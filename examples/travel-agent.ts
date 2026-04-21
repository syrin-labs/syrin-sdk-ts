/**
 * Travel AI — Multi-Agent Travel Planning System (TypeScript)
 * ===========================================================
 *
 * Demonstrates a production-grade multi-agent system using the Syrin SDK.
 *
 * Architecture:
 *   travel-orchestrator          — analyses the request and dispatches sub-agents
 *     └── researcher-agent       — destination research (climate, culture, attractions)
 *     └── [parallel swarm]
 *           hotel-finder-agent   — finds accommodation options
 *           transport-agent      — finds bus / train / flight options
 *           events-agent         — finds local events on travel dates
 *     └── route-optimizer-agent  — picks the optimal route + mode of transport
 *     └── itinerary-creator-agent— synthesises the final day-by-day itinerary
 *
 * SDK auto-emits (no user code required):
 *   LLM_CALL    — every OpenAI call, with tokens, cost, latency, context window
 *   TOOL_CALL   — auto-emitted when the LLM response contains tool_calls
 *   AGENT_RUN_STARTED/ENDED  — from withAgent()
 *   WORKFLOW_STARTED/ENDED   — from withWorkflow()
 *   SWARM_STARTED/ENDED      — from withSwarm()
 *
 * User emits (domain events):
 *   TOOL_RESULT       — after each tool is executed (pairs with SDK-emitted TOOL_CALL)
 *   GUARDRAIL_INPUT/OUTPUT
 *   CIRCUIT_BREAKER_OPEN/CLOSE
 *   HANDOFF, AGENT_FORK/JOIN, WORKER_SPAWNED
 *   BUDGET_ESTIMATION
 *   CHECKPOINT
 *
 * Run:
 *   export SYRIN_API_KEY=syrin_43aa3675439022959f2083a2c9b0ea1382220e44031fa8f0
 *   export OPENAI_API_KEY=sk-...
 *   export SYRIN_BACKEND_URL=http://localhost:4000
 *   npx tsx examples/travel-agent.ts
 *
 *   TRAVEL_DESTINATION="Tokyo, Japan" npx tsx examples/travel-agent.ts
 */

import OpenAI from 'openai';
import {
  init,
  withAgent,
  withWorkflow,
  withSwarm,
  withSession,
  getSessionId,
  shutdown,
  tune,
  GovernanceStopError,
} from '../src/index.js';

// ── Environment ───────────────────────────────────────────────────────────────

const SYRIN_API_KEY  = process.env['SYRIN_API_KEY']  ?? 'syrin_43aa3675439022959f2083a2c9b0ea1382220e44031fa8f0';
const BACKEND_URL    = process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000';
const OPENAI_API_KEY = process.env['OPENAI_API_KEY'] ?? '';

if (!OPENAI_API_KEY) {
  console.error('❌  OPENAI_API_KEY is required. Set it with:');
  console.error('    export OPENAI_API_KEY=sk-...');
  process.exit(1);
}

const DESTINATION   = process.env['TRAVEL_DESTINATION'] ?? 'Barcelona, Spain';
const TRAVEL_DATES  = process.env['TRAVEL_DATES']       ?? '2026-06-15 to 2026-06-22';
const NUM_TRAVELERS = parseInt(process.env['NUM_TRAVELERS'] ?? '2', 10);

// ── SDK init ──────────────────────────────────────────────────────────────────

const sdk = await init({
  apiKey:               SYRIN_API_KEY,
  agentId:              'travel-orchestrator',
  backendUrl:           BACKEND_URL,
  captureContent:       true,
  batchSize:            1,
  idleFlushMs:          2_000,
  configPollIntervalMs: 5_000,
  schemaDefaults: {
    'llm.model':               'gpt-4o-mini',
    'llm.temperature':          0.7,
    'budget.max_session_usd':   5.0,
    'guardrails.enabled':       true,
    'output.language':          'English',
    'researcher.llm.temperature':    0.3,
    'researcher.search.depth':       'standard',
    'hotel.search.max_results':       5,
    'hotel.search.budget_tier':      'mid-range',
    'transport.search.modes':        'all',
    'transport.search.max_options':   3,
    'events.search.categories':      'all',
    'route.optimize.criteria':       'balanced',
    'route.optimize.prefer_train':    true,
    'itinerary.output.format':       'markdown',
    'itinerary.output.detail_level': 'detailed',
  },
});

const cfg = (key: string, fallback: unknown): unknown => sdk.activeConfig()[key] ?? fallback;

const orchestratorConfig = { model: 'gpt-4o-mini', temperature: 0.7, maxSessionUsd: 5.0, guardrailsEnabled: true, outputLanguage: 'English' };
tune({ target: orchestratorConfig, namespace: 'llm',         fields: { model: 'string', temperature: 'number' } });
tune({ target: orchestratorConfig, namespace: 'budget',      fields: { maxSessionUsd: 'number' } });
tune({ target: orchestratorConfig, namespace: 'guardrails',  fields: { guardrailsEnabled: 'boolean' } });
tune({ target: orchestratorConfig, namespace: 'output',      fields: { outputLanguage: 'string' } });

await sdk.refreshSchema();

// ── OpenAI client ─────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Tool definitions ──────────────────────────────────────────────────────────

const RESEARCH_TOOLS: OpenAI.ChatCompletionTool[] = [
  { type: 'function', function: {
    name: 'search_destination',
    description: 'Search for general information about a travel destination including culture, safety, and attractions',
    parameters: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'City and country, e.g. Paris, France' },
        aspects: { type: 'array', items: { type: 'string' },
                   description: 'Areas to research: attractions, culture, climate, safety, transport' },
      },
      required: ['destination'],
    },
  }},
  { type: 'function', function: {
    name: 'get_climate_data',
    description: 'Get climate and weather data for a destination at specific travel dates',
    parameters: {
      type: 'object',
      properties: {
        destination: { type: 'string' },
        month: { type: 'integer', description: 'Month number 1-12' },
      },
      required: ['destination', 'month'],
    },
  }},
  { type: 'function', function: {
    name: 'get_safety_info',
    description: 'Get travel safety advisories and tips for a destination',
    parameters: {
      type: 'object',
      properties: { destination: { type: 'string' } },
      required: ['destination'],
    },
  }},
];

const HOTEL_TOOLS: OpenAI.ChatCompletionTool[] = [
  { type: 'function', function: {
    name: 'search_hotels',
    description: 'Search for available hotels matching budget and dates',
    parameters: {
      type: 'object',
      properties: {
        destination: { type: 'string' },
        check_in:    { type: 'string', description: 'ISO date YYYY-MM-DD' },
        check_out:   { type: 'string', description: 'ISO date YYYY-MM-DD' },
        guests:      { type: 'integer' },
        tier:        { type: 'string', enum: ['budget', 'mid-range', 'luxury'] },
        max_results: { type: 'integer' },
      },
      required: ['destination', 'check_in', 'check_out'],
    },
  }},
];

const TRANSPORT_TOOLS: OpenAI.ChatCompletionTool[] = [
  { type: 'function', function: {
    name: 'search_flights',
    description: 'Search for available flights between two cities',
    parameters: {
      type: 'object',
      properties: {
        origin:      { type: 'string' },
        destination: { type: 'string' },
        date:        { type: 'string' },
        passengers:  { type: 'integer' },
      },
      required: ['origin', 'destination', 'date'],
    },
  }},
  { type: 'function', function: {
    name: 'search_trains',
    description: 'Search for train services between two cities',
    parameters: {
      type: 'object',
      properties: {
        origin:      { type: 'string' },
        destination: { type: 'string' },
        date:        { type: 'string' },
      },
      required: ['origin', 'destination', 'date'],
    },
  }},
  { type: 'function', function: {
    name: 'search_buses',
    description: 'Search for coach/bus services between two cities',
    parameters: {
      type: 'object',
      properties: {
        origin:      { type: 'string' },
        destination: { type: 'string' },
        date:        { type: 'string' },
      },
      required: ['origin', 'destination', 'date'],
    },
  }},
];

const EVENTS_TOOLS: OpenAI.ChatCompletionTool[] = [
  { type: 'function', function: {
    name: 'search_events',
    description: 'Search for events happening in a city during specific dates',
    parameters: {
      type: 'object',
      properties: {
        city:        { type: 'string' },
        start_date:  { type: 'string' },
        end_date:    { type: 'string' },
        categories:  { type: 'array', items: { type: 'string' } },
      },
      required: ['city', 'start_date', 'end_date'],
    },
  }},
];

// ── Tool execution (realistic mock implementations) ────────────────────────────

function executeTool(toolName: string, args: Record<string, unknown>): unknown {
  const dest = (args['destination'] ?? args['city'] ?? 'Unknown') as string;
  const startDate = (TRAVEL_DATES.split(' to ')[0]) ?? '';

  switch (toolName) {
    case 'search_destination':
      return {
        destination: dest,
        summary: `${dest} is a world-class travel destination with rich history and culture.`,
        top_attractions: [
          'Sagrada Família — Gaudí's unfinished basilica, book months ahead',
          'Park Güell — mosaic park with panoramic city views',
          'Las Ramblas — iconic 1.2km boulevard, vibrant but watch for pickpockets',
          'Gothic Quarter — medieval streets, Barcelona Cathedral',
          'Camp Nou — world's largest football stadium',
          'Barceloneta — city beach, 4.5km of sand',
        ],
        best_neighborhoods: ['Eixample (Gaudí architecture)', 'Gothic Quarter (history)', 'Gràcia (local feel)', 'El Born (tapas & bars)'],
        local_transport: 'T-Casual 10-trip card (€12.15) — metro + bus + tram; Bicing bike-share also popular',
        language: 'Catalan and Spanish — English widely spoken in tourist areas',
        currency: 'EUR (€) — credit cards everywhere',
      };

    case 'get_climate_data': {
      const month = (args['month'] as number) ?? 6;
      const byMonth: Record<number, Record<string, unknown>> = {
        6: { month: 'June', avg_high_c: 26, avg_low_c: 18, sunshine_hours: 10, rainfall_mm: 32,
             description: 'Warm and sunny — perfect beach and sightseeing weather' },
        7: { month: 'July', avg_high_c: 29, avg_low_c: 21, sunshine_hours: 11, rainfall_mm: 18,
             description: 'Hot and dry — keep hydrated, visit museums in the afternoon' },
        8: { month: 'August', avg_high_c: 29, avg_low_c: 21, sunshine_hours: 10, rainfall_mm: 54,
             description: 'Very hot, busiest tourist month; occasional thunderstorms' },
      };
      return { ...(byMonth[month] ?? byMonth[6]), destination: dest };
    }

    case 'get_safety_info':
      return {
        destination: dest,
        overall_rating: 'Safe',
        level: 'Low to moderate risk',
        advisories: [
          'Pickpockets common on Las Ramblas and Metro Line 3 — keep bags in front',
          'Busy tourist areas: be vigilant around Sagrada Família and Park Güell',
          'Avoid leaving valuables on restaurant tables',
        ],
        emergency_numbers: { police: '091', ambulance: '112', fire: '080', EU_emergency: '112' },
        health: 'No vaccinations required for EU/US travellers; EHIC card covers EU residents',
      };

    case 'search_hotels': {
      const tier = (args['tier'] ?? 'mid-range') as string;
      const guests = (args['guests'] ?? 2) as number;
      const hotels: Record<string, unknown[]> = {
        budget: [
          { name: 'Equity Point Gothic', stars: 3, price_per_night: 60, rating: 8.1, location: 'Gothic Quarter', highlights: ['Rooftop terrace', 'Social atmosphere'] },
          { name: 'Casa Gracia', stars: 3, price_per_night: 55, rating: 8.0, location: 'Eixample', highlights: ['Artsy hostel-hotel', 'Central'] },
        ],
        'mid-range': [
          { name: 'Catalonia Ramblas', stars: 4, price_per_night: 140, rating: 8.8, location: 'Las Ramblas', highlights: ['Perfect central location', 'Rooftop pool'] },
          { name: 'Hotel Praktik Rambla', stars: 4, price_per_night: 110, rating: 8.6, location: 'Gràcia', highlights: ['Boutique feel', 'Quiet neighbourhood'] },
          { name: 'HCC Montblanc', stars: 4, price_per_night: 125, rating: 8.5, location: 'Eixample', highlights: ['Near Sagrada Família', 'Terrace'] },
        ],
        luxury: [
          { name: 'Hotel Arts Barcelona', stars: 5, price_per_night: 380, rating: 9.2, location: 'Barceloneta', highlights: ['Beachfront', 'Two Michelin restaurants', 'Infinity pool'] },
          { name: 'W Barcelona', stars: 5, price_per_night: 420, rating: 9.0, location: 'Port Olímpic', highlights: ['Iconic sail shape', 'Ocean views', 'Eclipse bar'] },
        ],
      };
      return { search_params: { destination: dest, guests, tier }, hotels: hotels[tier] ?? hotels['mid-range'] };
    }

    case 'search_flights': {
      const origin = (args['origin'] ?? 'London Heathrow') as string;
      return {
        route: `${origin} → ${dest}`,
        date: args['date'] ?? startDate,
        results: [
          { airline: 'Vueling', flight: 'VY7831', departure: '07:00', arrival: '10:10', duration: '2h10m', price_gbp: 72, stops: 0 },
          { airline: 'British Airways', flight: 'BA482', departure: '10:30', arrival: '13:45', duration: '2h15m', price_gbp: 118, stops: 0 },
          { airline: 'easyJet', flight: 'EZY8734', departure: '14:15', arrival: '17:25', duration: '2h10m', price_gbp: 58, stops: 0 },
        ],
      };
    }

    case 'search_trains': {
      const origin = (args['origin'] ?? 'London St Pancras') as string;
      return {
        route: `${origin} → ${dest}`,
        date: args['date'] ?? startDate,
        results: [
          { operator: 'Renfe + SNCF via Paris', departure: '09:13', arrival: '17:00', duration: '7h47m', price_eur: 120, note: 'Change in Paris, advance booking needed' },
          { operator: 'Renfe from Madrid', departure: '08:00 (from Madrid Atocha)', arrival: '10:30', duration: '2h30m', price_eur: 30, note: 'If already in Spain — AVE high-speed, frequent' },
        ],
      };
    }

    case 'search_buses': {
      const origin = (args['origin'] ?? 'London Victoria') as string;
      return {
        route: `${origin} → ${dest}`,
        date: args['date'] ?? startDate,
        results: [
          { operator: 'ALSA / FlixBus', departure: '07:00', arrival: '23:30', duration: '16h30m', price_eur: 45, note: 'Long journey, daytime' },
          { operator: 'Eurolines', departure: '20:00', arrival: '12:30+1', duration: '16h30m', price_eur: 40, note: 'Overnight — saves hotel cost' },
        ],
      };
    }

    case 'search_events': {
      const city = (args['city'] ?? dest) as string;
      const cats = (args['categories'] as string[]) ?? ['all'];
      return {
        city,
        period: `${args['start_date'] ?? ''} – ${args['end_date'] ?? ''}`,
        categories_searched: cats,
        events: [
          { name: 'Sónar Festival', type: 'music', dates: 'Jun 19-21', venue: 'Fira de Barcelona', price: '€120/day', booking: 'Book in advance' },
          { name: 'FC Barcelona match', type: 'sports', dates: 'Check fixture list', venue: 'Camp Nou', price: '€50-€250', booking: 'Official club website' },
          { name: 'Sant Joan Night (Midsummer)', type: 'cultural', dates: 'Jun 23', venue: 'City beaches & streets', price: 'Free', note: 'Spectacular fireworks, very lively' },
          { name: 'Grec Festival Barcelona', type: 'cultural/arts', dates: 'July (preview in June)', venue: 'Multiple outdoor venues', price: '€12-€35' },
        ],
      };
    }

    default:
      return { tool: toolName, args, result: 'Tool executed successfully' };
  }
}

// ── Core agent turn runner — handles multi-turn tool loop ─────────────────────

async function runAgentTurn(
  agentId: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  options: { model?: string; temperature?: number; tools?: OpenAI.ChatCompletionTool[] } = {},
  maxToolRounds = 4,
): Promise<string> {
  const model       = (cfg('llm.model',       options.model       ?? 'gpt-4o-mini')) as string;
  const temperature = (cfg('llm.temperature', options.temperature ?? 0.7))           as number;

  let currentMessages: OpenAI.ChatCompletionMessageParam[] = [...messages];

  for (let round = 0; round <= maxToolRounds; round++) {
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model,
      temperature,
      messages: currentMessages,
      max_tokens: 1500,
    };
    if (options.tools?.length && round < maxToolRounds) {
      params.tools       = options.tools;
      params.tool_choice = 'auto';
    }

    // SDK intercepts → auto-emits LLM_CALL (tokens, cost, latency, context window)
    // and auto-emits TOOL_CALL for each tool the model requests
    const resp = await openai.chat.completions.create(params);
    const msg  = resp.choices[0].message;

    if (!msg.tool_calls?.length) {
      return msg.content ?? '';
    }

    // Append assistant message with tool_calls to conversation
    currentMessages.push(msg as OpenAI.ChatCompletionMessageParam);

    // Execute each tool and emit TOOL_RESULT
    for (const tc of msg.tool_calls) {
      const toolName = tc.function.name;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments ?? '{}'); } catch { /* use empty args */ }

      const t0 = performance.now();
      let resultStr: string;
      let errorStr: string | undefined;
      try {
        const result = executeTool(toolName, args);
        resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (err) {
        resultStr = '';
        errorStr  = String(err);
      }
      const latencyMs = Math.max(1, Math.round(performance.now() - t0));

      // Emit TOOL_RESULT — pairs with the auto-emitted TOOL_CALL from the SDK
      sdk.emit('TOOL_RESULT', {
        tool_call_id: tc.id,
        tool_name:    toolName,
        result:       resultStr,
        error:        errorStr,
        latency_ms:   latencyMs,
      });

      currentMessages.push({
        role:         'tool',
        tool_call_id: tc.id,
        content:      resultStr || `[error] ${errorStr}`,
      });
    }
  }

  // Exceeded max rounds — make one final call without tools
  const resp = await openai.chat.completions.create({
    model, temperature, messages: currentMessages, max_tokens: 1500,
  });
  return resp.choices[0].message.content ?? '';
}

// ── Circuit breaker ───────────────────────────────────────────────────────────

const failureCounts: Record<string, number> = {};
const openedAt:      Record<string, number> = {};
const CB_THRESHOLD = 3;
const CB_COOLDOWN  = 30_000;

function isCBOpen(agentId: string): boolean {
  const t = openedAt[agentId];
  if (t && Date.now() - t < CB_COOLDOWN) return true;
  if (t) {
    delete openedAt[agentId];
    failureCounts[agentId] = 0;
    sdk.emit('CIRCUIT_BREAKER_CLOSE', { agent_id: agentId, reason: 'cooldown_expired' });
  }
  return false;
}
function cbSuccess(agentId: string): void  { failureCounts[agentId] = 0; }
function cbFailure(agentId: string, reason: string): void {
  const n = (failureCounts[agentId] ?? 0) + 1;
  failureCounts[agentId] = n;
  if (n >= CB_THRESHOLD) {
    openedAt[agentId] = Date.now();
    sdk.emit('CIRCUIT_BREAKER_OPEN', { agent_id: agentId, reason, failure_count: n, threshold: CB_THRESHOLD });
  }
}

// ── Guardrails ────────────────────────────────────────────────────────────────

function guardrailInput(text: string, agentId: string): boolean {
  if (!cfg('guardrails.enabled', true)) return true;
  const blocked = ['hack', 'illegal', 'weapon', 'bomb'];
  const passed  = !blocked.some(w => text.toLowerCase().includes(w));
  sdk.emit('GUARDRAIL_INPUT', { name: 'content_safety', passed, agent_id: agentId,
    message: passed ? undefined : 'Input blocked: disallowed content detected' });
  return passed;
}

function guardrailOutput(text: string, agentId: string): boolean {
  const passed = text.trim().length > 10;
  sdk.emit('GUARDRAIL_OUTPUT', { name: 'output_quality', passed, agent_id: agentId,
    message: passed ? undefined : 'Output too short or empty' });
  return passed;
}

// ── Budget tracking ───────────────────────────────────────────────────────────

let accumulatedCost = 0;

function checkBudget(phase: string, estimatedUsd: number): void {
  const limit = cfg('budget.max_session_usd', 5.0) as number;
  sdk.emit('BUDGET_ESTIMATION', {
    phase,
    estimated_cost_usd:   estimatedUsd,
    accumulated_cost_usd: accumulatedCost,
    budget_usd:           limit,
    message: `Phase '${phase}': est $${estimatedUsd.toFixed(3)} | accum $${accumulatedCost.toFixed(3)} / $${limit.toFixed(2)}`,
  });
  if (accumulatedCost + estimatedUsd > limit) {
    throw new GovernanceStopError(
      `Budget limit $${limit.toFixed(2)} would be exceeded ` +
      `(accumulated: $${accumulatedCost.toFixed(3)}, estimate: $${estimatedUsd.toFixed(3)})`
    );
  }
}

// ── Agent implementations ─────────────────────────────────────────────────────

async function runResearcher(destination: string, dates: string): Promise<{ research: string }> {
  sdk.emit('HANDOFF', {
    from_agent: 'travel-orchestrator', to_agent: 'researcher-agent',
    reason: 'Destination research phase',
    context: { destination, dates },
  });
  checkBudget('researcher', 0.005);

  return withAgent('researcher-agent', async () => {
    const depth = cfg('researcher.search.depth', 'standard') as string;
    console.log(`  [researcher] depth=${depth}`);
    guardrailInput(destination, 'researcher-agent');

    const result = await runAgentTurn(
      'researcher-agent',
      [
        { role: 'system', content: 'You are a travel research specialist. Use the tools to gather data, then return a comprehensive JSON summary.' },
        { role: 'user',   content: `Research ${destination} for ${NUM_TRAVELERS} people, ${dates}. Use the available tools to gather: attractions, culture, climate, safety, local transport. Return a detailed JSON report.` },
      ],
      { temperature: cfg('researcher.llm.temperature', 0.3) as number, tools: RESEARCH_TOOLS },
    );

    guardrailOutput(result, 'researcher-agent');
    cbSuccess('researcher-agent');

    sdk.emit('CHECKPOINT', { name: 'research-complete', label: 'research-complete',
      metadata: { destination, phase: 'research' } });

    return { research: result };
  });
}

async function runHotelFinder(destination: string, dates: string): Promise<{ hotels: string }> {
  sdk.emit('WORKER_SPAWNED', {
    worker_agent: 'hotel-finder-agent', parent_agent: 'travel-orchestrator',
    reason: 'Parallel accommodation search',
  });
  checkBudget('hotel-finder', 0.003);

  return withAgent('hotel-finder-agent', async () => {
    const tier       = cfg('hotel.search.budget_tier', 'mid-range') as string;
    const maxResults = cfg('hotel.search.max_results', 5) as number;

    const result = await runAgentTurn(
      'hotel-finder-agent',
      [
        { role: 'system', content: 'You are a hotel booking specialist. Return structured JSON.' },
        { role: 'user',   content: `Find top ${maxResults} ${tier} hotels in ${destination} for ${dates}, ${NUM_TRAVELERS} guests. Use the search_hotels tool then summarise as JSON.` },
      ],
      { temperature: 0.4, tools: HOTEL_TOOLS },
    );

    cbSuccess('hotel-finder-agent');
    return { hotels: result };
  });
}

async function runTransportFinder(destination: string, dates: string): Promise<{ transport: string }> {
  sdk.emit('WORKER_SPAWNED', {
    worker_agent: 'transport-agent', parent_agent: 'travel-orchestrator',
    reason: 'Parallel transport search',
  });
  checkBudget('transport-finder', 0.003);

  return withAgent('transport-agent', async () => {
    const modes    = cfg('transport.search.modes', 'all') as string;
    const maxOpts  = cfg('transport.search.max_options', 3) as number;

    let activeTools = [...TRANSPORT_TOOLS];
    if (modes === 'air_only')    activeTools = activeTools.filter(t => t.function.name === 'search_flights');
    if (modes === 'ground_only') activeTools = activeTools.filter(t => t.function.name !== 'search_flights');

    const result = await runAgentTurn(
      'transport-agent',
      [
        { role: 'system', content: 'You are a transport specialist. Return structured JSON.' },
        { role: 'user',   content: `Find the best ${maxOpts} options per transport mode to ${destination} for ${dates}, ${NUM_TRAVELERS} travellers. Use all available search tools, then compare and summarise as JSON.` },
      ],
      { temperature: 0.3, tools: activeTools },
    );

    cbSuccess('transport-agent');
    return { transport: result };
  });
}

async function runEventsAgent(destination: string, dates: string): Promise<{ events: string }> {
  sdk.emit('WORKER_SPAWNED', {
    worker_agent: 'events-agent', parent_agent: 'travel-orchestrator',
    reason: 'Parallel events search',
  });
  checkBudget('events-agent', 0.002);

  return withAgent('events-agent', async () => {
    const categories = cfg('events.search.categories', 'all') as string;

    const result = await runAgentTurn(
      'events-agent',
      [
        { role: 'system', content: 'You are a local events specialist. Return structured JSON.' },
        { role: 'user',   content: `Find events in ${destination} during ${dates}. Categories: ${categories}. Use the search_events tool then return a curated JSON list.` },
      ],
      { temperature: 0.5, tools: EVENTS_TOOLS },
    );

    cbSuccess('events-agent');
    return { events: result };
  });
}

async function runRouteOptimizer(research: string, transport: string): Promise<{ route: string }> {
  sdk.emit('HANDOFF', {
    from_agent: 'travel-orchestrator', to_agent: 'route-optimizer-agent',
    reason: 'Route optimisation phase',
    context: { criteria: cfg('route.optimize.criteria', 'balanced') },
  });
  checkBudget('route-optimizer', 0.003);

  return withAgent('route-optimizer-agent', async () => {
    const criteria    = cfg('route.optimize.criteria', 'balanced') as string;
    const preferTrain = cfg('route.optimize.prefer_train', true)   as boolean;

    guardrailInput(transport, 'route-optimizer-agent');

    const result = await runAgentTurn(
      'route-optimizer-agent',
      [
        { role: 'system', content: `You are a route optimisation specialist. Prioritise: ${criteria}. Prefer trains: ${preferTrain}. Return JSON.` },
        { role: 'user',   content: `Research:\n${research.slice(0, 600)}\n\nTransport options:\n${transport.slice(0, 600)}\n\nRecommend the optimal transport and route with clear reasoning. Return JSON.` },
      ],
      { temperature: 0.3 },
    );

    guardrailOutput(result, 'route-optimizer-agent');
    cbSuccess('route-optimizer-agent');

    sdk.emit('CHECKPOINT', { name: 'route-decided', label: 'route-decided',
      metadata: { destination: DESTINATION, phase: 'route-optimisation' } });

    return { route: result };
  });
}

async function runItineraryCreator(
  destination: string, dates: string,
  research: string, hotels: string, transport: string, events: string, route: string,
): Promise<string> {
  sdk.emit('HANDOFF', {
    from_agent: 'travel-orchestrator', to_agent: 'itinerary-creator-agent',
    reason: 'Final itinerary synthesis',
    context: { format: cfg('itinerary.output.format', 'markdown'), detailLevel: cfg('itinerary.output.detail_level', 'detailed') },
  });
  checkBudget('itinerary-creator', 0.008);

  return withAgent('itinerary-creator-agent', async () => {
    const format      = cfg('itinerary.output.format',      'markdown') as string;
    const detailLevel = cfg('itinerary.output.detail_level', 'detailed') as string;
    const language    = cfg('output.language',               'English')  as string;
    console.log(`  [itinerary] format=${format}, detail=${detailLevel}, lang=${language}`);

    const context = [
      `Destination: ${destination}`, `Dates: ${dates}`, `Travellers: ${NUM_TRAVELERS}`,
      `Research:\n${research.slice(0, 600)}`,
      `Hotels:\n${hotels.slice(0, 500)}`,
      `Transport:\n${transport.slice(0, 500)}`,
      `Events:\n${events.slice(0, 500)}`,
      `Route decision:\n${route.slice(0, 500)}`,
    ].join('\n\n');

    const result = await runAgentTurn(
      'itinerary-creator-agent',
      [
        { role: 'system', content: 'You are an expert travel consultant. Create detailed, practical day-by-day itineraries.' },
        { role: 'user',   content: `Create a ${detailLevel} day-by-day itinerary in ${format} format, written in ${language}.\n\nAll gathered data:\n${context}` },
      ],
      { temperature: 0.8, model: 'gpt-4o' },
    );

    guardrailOutput(result, 'itinerary-creator-agent');
    cbSuccess('itinerary-creator-agent');

    sdk.emit('CHECKPOINT', { name: 'itinerary-complete', label: 'itinerary-complete',
      metadata: { destination, phases_completed: 6 } });

    return result;
  });
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

async function runTravelPlanner(): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Travel AI Planning System (TypeScript)`);
  console.log(`  Destination : ${DESTINATION}`);
  console.log(`  Dates       : ${TRAVEL_DATES}`);
  console.log(`  Travellers  : ${NUM_TRAVELERS}`);
  console.log(`  Mode        : LIVE (OpenAI)`);
  console.log(`${'='.repeat(60)}\n`);

  if (!guardrailInput(DESTINATION, 'travel-orchestrator')) {
    console.log('❌  Destination blocked by content guardrail');
    return;
  }

  try {
    await withWorkflow('travel-planning-session', async (_wf) => {
      // Orchestrator analyses the request
      await withAgent('travel-orchestrator', async () => {
        checkBudget('orchestration', 0.002);

        const plan = await runAgentTurn(
          'travel-orchestrator',
          [
            { role: 'system', content: 'You are a travel planning orchestrator. Return a JSON plan.' },
            { role: 'user',   content: `Plan a ${NUM_TRAVELERS}-person trip to ${DESTINATION} from ${TRAVEL_DATES}. Return JSON with: agents_order, reasoning, parallel_phases.` },
          ],
        );
        console.log(`  [orchestrator] plan ready (${plan.length} chars)`);
      });

      // ── Phase 1: Research (sequential) ───────────────────────────────────
      console.log('📚 Phase 1: Destination research...');
      const { research } = await runResearcher(DESTINATION, TRAVEL_DATES);
      accumulatedCost += 0.005;
      console.log(`   ✓ Research complete (${research.length} chars)`);

      // ── Phase 2: Parallel data gathering ─────────────────────────────────
      console.log('\n🔀 Phase 2: Parallel data gathering (hotels + transport + events)...');
      const parallelAgents = ['hotel-finder-agent', 'transport-agent', 'events-agent'];
      sdk.emit('AGENT_FORK', {
        agents: parallelAgents,
        reason: 'Hotel, transport, and events searches are independent — running in parallel',
      });

      let hotels = '', transport = '', events = '';
      await withSwarm('parallel-data-gathering', async () => {
        const [h, t, e] = await Promise.all([
          runHotelFinder(DESTINATION, TRAVEL_DATES),
          runTransportFinder(DESTINATION, TRAVEL_DATES),
          runEventsAgent(DESTINATION, TRAVEL_DATES),
        ]);
        hotels    = h.hotels;
        transport = t.transport;
        events    = e.events;
      });

      sdk.emit('AGENT_JOIN', { agents: parallelAgents, reason: 'All parallel agents completed — merging results' });
      accumulatedCost += 0.008;
      console.log('   ✓ Hotels, transport, and events collected');

      sdk.emit('CHECKPOINT', { name: 'parallel-phase-complete', label: 'parallel-phase-complete',
        metadata: { agents_completed: parallelAgents } });

      // ── Phase 3: Route optimisation ───────────────────────────────────────
      console.log('\n🗺  Phase 3: Route optimisation...');
      const { route } = await runRouteOptimizer(research, transport);
      accumulatedCost += 0.003;
      console.log('   ✓ Route optimised');

      // ── Phase 4: Itinerary creation ───────────────────────────────────────
      console.log('\n📋 Phase 4: Creating final itinerary...');
      const finalItinerary = await runItineraryCreator(
        DESTINATION, TRAVEL_DATES,
        research, hotels, transport, events, route,
      );
      accumulatedCost += 0.008;
      console.log(`   ✓ Itinerary created (${finalItinerary.length} chars)`);

      console.log(`\n${'='.repeat(60)}`);
      console.log('  FINAL ITINERARY');
      console.log(`${'='.repeat(60)}`);
      console.log(finalItinerary.slice(0, 2500));
      if (finalItinerary.length > 2500) {
        console.log(`\n... [${finalItinerary.length - 2500} more characters] ...`);
      }
      console.log(`\n${'='.repeat(60)}`);
      console.log(`  Estimated session cost: ~$${accumulatedCost.toFixed(4)}`);
      console.log('  Check the Syrin dashboard for full traces & analytics.');
      console.log(`${'='.repeat(60)}\n`);
    });

  } catch (err) {
    if (err instanceof GovernanceStopError) {
      console.log(`\n⛔  Governance stopped: ${(err as GovernanceStopError).message}`);
    } else {
      console.error('\n❌  Unexpected error:', err);
      throw err;
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

try {
  const sessionId = getSessionId();
  await withSession(sessionId, () => runTravelPlanner());
} finally {
  await sdk.flush();
  await shutdown();
  console.log('SDK shut down. All events flushed to Syrin backend.');
}
