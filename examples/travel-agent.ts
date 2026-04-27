/**
 * Travel AI — Multi-Agent Travel Planning System (TypeScript)
 * ===========================================================
 *
 * A complete example demonstrating:
 *   • Multi-agent orchestration with auto-discovered topology
 *   • SDK initialization with agent registration
 *   • HTTP server with SDK auto-generated agent endpoints
 *   • Each agent callable registered and routed by SDK
 *
 * Architecture (Auto-Discovered Orchestrator Topology):
 *   travel-orchestrator (root orchestrator)
 *     ├── researcher-agent          — destination research
 *     ├── hotel-finder-agent        ┐
 *     ├── transport-agent           ├ parallel swarm execution
 *     ├── events-agent              ┘
 *     ├── route-optimizer-agent     — route optimization
 *     └── itinerary-creator-agent   — itinerary synthesis
 *
 * Setup:
 *   SYRIN_ENV=local  → loads examples/.env.local  (localhost:4000 backend)
 *   SYRIN_ENV=production → loads examples/.env.production  (app.syrin.ai backend)
 *
 *   export SYRIN_API_KEY=syrin_pk_...
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx examples/travel-agent.ts
 *
 * Usage:
 *   curl http://localhost:3001/health
 *   curl -X POST http://localhost:3001/agent/itinerary-creator-agent/run \
 *     -H "Content-Type: application/json" \
 *     -d '{"task": "Create a 3-day itinerary for Rome"}'
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Load environment ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath: string): void {
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // File not found — silently skip
  }
}

const syrinEnv = process.env['SYRIN_ENV'] ?? 'local';
const envMap: Record<string, string> = {
  local: '.env.local',
  production: '.env.production',
  prod: '.env.production',
};
const envFile = resolve(__dirname, envMap[syrinEnv] ?? '.env.local');
loadEnvFile(envFile);
// Fallback to .env if preferred file not found
loadEnvFile(resolve(__dirname, '.env'));

console.log(`[env] Loaded ${envMap[syrinEnv] ?? '.env.local'} (SYRIN_ENV=${syrinEnv})`);

const SYRIN_API_KEY  = process.env['SYRIN_API_KEY'] ?? '';
const OPENAI_API_KEY = process.env['OPENAI_API_KEY'] ?? '';
const BACKEND_URL    = process.env['SYRIN_BACKEND_URL'] ?? 'https://app.syrin.ai';
const PORT           = parseInt(process.env['PORT'] ?? '3001', 10);
const AGENT_URL      = process.env['SYRIN_AGENT_URL'] ?? process.env['AGENT_URL'] ?? `http://localhost:${PORT}`;

if (!SYRIN_API_KEY) {
  console.error('❌ SYRIN_API_KEY environment variable required');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY environment variable required');
  process.exit(1);
}

const DESTINATION   = process.env['TRAVEL_DESTINATION'] ?? 'Paris, France';
const TRAVEL_DATES  = process.env['TRAVEL_DATES']       ?? '2026-05-10 to 2026-05-17';
const NUM_TRAVELERS = parseInt(process.env['NUM_TRAVELERS'] ?? '2', 10);

// ── Initialize Syrin SDK ──────────────────────────────────────────────────────

import { init, GovernancePresets } from '../src/index.js';

const SUB_AGENT_IDS = [
  'researcher-agent',
  'hotel-finder-agent',
  'transport-agent',
  'events-agent',
  'route-optimizer-agent',
  'itinerary-creator-agent',
];

console.info('Initializing Syrin SDK with multi-agent system...');

const sdk = await init({
  apiKey: SYRIN_API_KEY,
  agentId: 'travel-orchestrator',
  backendUrl: BACKEND_URL,
  agentUrl: AGENT_URL,
  captureContent: true,
  sessionTtlMs: 7200 * 1000,
  agents: SUB_AGENT_IDS,
  configPollIntervalMs: 15000,
  debug: process.env['DEBUG'] === 'true',
});

console.info(`✓ SDK initialized with ${SUB_AGENT_IDS.length} agents, agentUrl=${AGENT_URL}`);

// ── OpenAI client ─────────────────────────────────────────────────────────────

import OpenAI from 'openai';

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Agent handles (field declarations for dashboard config) ───────────────────

const agentHandles: Record<string, ReturnType<typeof sdk.agent>> = {
  'researcher-agent': sdk.agent('researcher-agent')
    .tools(['search_destination_info', 'get_weather_forecast', 'get_travel_advisories'])
    .field('llm.model', 'gpt-4o-mini', { label: 'LLM Model', enum: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] })
    .field('llm.temperature', 0.7, { label: 'Temperature', ge: 0.0, le: 1.0 })
    .field('llm.max_tokens', 2048, { label: 'Max Tokens', ge: 256, le: 8192 })
    .field('prompt.system_prompt', 'You are an expert travel researcher. Research the destination thoroughly.', { label: 'System Prompt', multiline: true }),

  'hotel-finder-agent': sdk.agent('hotel-finder-agent')
    .tools(['search_hotels', 'check_availability', 'get_hotel_reviews'])
    .field('llm.model', 'gpt-4o-mini', { label: 'LLM Model', enum: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] })
    .field('llm.temperature', 0.5, { label: 'Temperature', ge: 0.0, le: 1.0 })
    .field('llm.max_tokens', 2048, { label: 'Max Tokens', ge: 256, le: 8192 })
    .field('prompt.system_prompt', 'You are a hotel expert. Find the best accommodations.', { label: 'System Prompt', multiline: true }),

  'transport-agent': sdk.agent('transport-agent')
    .tools(['search_flights', 'search_trains', 'get_taxi_rates'])
    .field('llm.model', 'gpt-4o-mini', { label: 'LLM Model', enum: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] })
    .field('llm.temperature', 0.5, { label: 'Temperature', ge: 0.0, le: 1.0 })
    .field('llm.max_tokens', 2048, { label: 'Max Tokens', ge: 256, le: 8192 })
    .field('prompt.system_prompt', 'You are a transport specialist. Identify all transportation options.', { label: 'System Prompt', multiline: true }),

  'events-agent': sdk.agent('events-agent')
    .tools(['search_events', 'get_museum_hours', 'search_restaurants'])
    .field('llm.model', 'gpt-4o-mini', { label: 'LLM Model', enum: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] })
    .field('llm.temperature', 0.8, { label: 'Temperature', ge: 0.0, le: 1.0 })
    .field('llm.max_tokens', 2048, { label: 'Max Tokens', ge: 256, le: 8192 })
    .field('prompt.system_prompt', 'You are an events expert. Discover local events and activities.', { label: 'System Prompt', multiline: true }),

  'route-optimizer-agent': sdk.agent('route-optimizer-agent')
    .tools(['get_distance_matrix', 'calculate_route'])
    .field('llm.model', 'gpt-4o-mini', { label: 'LLM Model', enum: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] })
    .field('llm.temperature', 0.3, { label: 'Temperature', ge: 0.0, le: 1.0 })
    .field('llm.max_tokens', 2048, { label: 'Max Tokens', ge: 256, le: 8192 })
    .field('prompt.system_prompt', 'You are a logistics expert. Optimize routes for efficiency.', { label: 'System Prompt', multiline: true }),

  'itinerary-creator-agent': sdk.agent('itinerary-creator-agent')
    .field('llm.model', 'gpt-4o-mini', { label: 'LLM Model', enum: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] })
    .field('llm.temperature', 0.7, { label: 'Temperature', ge: 0.0, le: 1.0 })
    .field('llm.max_tokens', 4096, { label: 'Max Tokens', ge: 256, le: 8192 })
    .field('prompt.system_prompt', 'You are a travel planner. Create comprehensive, detailed itineraries.', { label: 'System Prompt', multiline: true }),
};

// Re-register now that all field declarations are complete
try {
  await (sdk as any)._core.register();
  console.info('✓ Schema re-registered with all agent fields');
} catch (e) {
  console.warn(`Schema re-registration failed (non-fatal): ${e}`);
}

// ── OpenAI tool schemas ───────────────────────────────────────────────────────
// Passed as tools= to each LLM call. The SDK intercepts and strips tools whose
// dashboard toggle is OFF before forwarding to OpenAI.

const AGENT_TOOL_DEFS: Record<string, Array<Record<string, unknown>>> = {
  'researcher-agent': [
    { type: 'function', function: {
      name: 'search_destination_info',
      description: 'Search for destination information: attractions, culture, local tips',
      parameters: { type: 'object', properties: {
        destination: { type: 'string' },
        topics: { type: 'array', items: { type: 'string' } },
      }, required: ['destination'] },
    }},
    { type: 'function', function: {
      name: 'get_weather_forecast',
      description: 'Get weather forecast for a destination during travel dates',
      parameters: { type: 'object', properties: {
        destination: { type: 'string' },
        start_date: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        end_date:   { type: 'string', description: 'ISO date YYYY-MM-DD' },
      }, required: ['destination', 'start_date', 'end_date'] },
    }},
    { type: 'function', function: {
      name: 'get_travel_advisories',
      description: 'Get safety ratings, travel advisories, and visa requirements',
      parameters: { type: 'object', properties: {
        destination: { type: 'string' },
        nationality: { type: 'string' },
      }, required: ['destination'] },
    }},
  ],
  'hotel-finder-agent': [
    { type: 'function', function: {
      name: 'search_hotels',
      description: 'Search available hotels matching budget and dates',
      parameters: { type: 'object', properties: {
        destination:      { type: 'string' },
        check_in:         { type: 'string' },
        check_out:        { type: 'string' },
        budget_per_night: { type: 'number' },
        guests:           { type: 'integer' },
      }, required: ['destination', 'check_in', 'check_out'] },
    }},
    { type: 'function', function: {
      name: 'check_availability',
      description: 'Check real-time room availability for a specific hotel',
      parameters: { type: 'object', properties: {
        hotel_id: { type: 'string' },
        check_in: { type: 'string' },
        check_out: { type: 'string' },
      }, required: ['hotel_id', 'check_in', 'check_out'] },
    }},
    { type: 'function', function: {
      name: 'get_hotel_reviews',
      description: 'Fetch guest reviews and ratings for a hotel',
      parameters: { type: 'object', properties: {
        hotel_id: { type: 'string' },
        limit: { type: 'integer' },
      }, required: ['hotel_id'] },
    }},
  ],
  'transport-agent': [
    { type: 'function', function: {
      name: 'search_flights',
      description: 'Search available flights between origin and destination',
      parameters: { type: 'object', properties: {
        origin:         { type: 'string' },
        destination:    { type: 'string' },
        departure_date: { type: 'string' },
        return_date:    { type: 'string' },
        passengers:     { type: 'integer' },
      }, required: ['origin', 'destination', 'departure_date'] },
    }},
    { type: 'function', function: {
      name: 'search_trains',
      description: 'Search train connections between two cities',
      parameters: { type: 'object', properties: {
        origin:      { type: 'string' },
        destination: { type: 'string' },
        travel_date: { type: 'string' },
      }, required: ['origin', 'destination', 'travel_date'] },
    }},
    { type: 'function', function: {
      name: 'get_taxi_rates',
      description: 'Get estimated taxi/rideshare rates for a city',
      parameters: { type: 'object', properties: {
        city:          { type: 'string' },
        from_location: { type: 'string' },
        to_location:   { type: 'string' },
      }, required: ['city'] },
    }},
  ],
  'events-agent': [
    { type: 'function', function: {
      name: 'search_events',
      description: 'Find local events, concerts, and festivals during travel dates',
      parameters: { type: 'object', properties: {
        destination: { type: 'string' },
        start_date:  { type: 'string' },
        end_date:    { type: 'string' },
        category:    { type: 'string', enum: ['music', 'sports', 'culture', 'food', 'all'] },
      }, required: ['destination', 'start_date', 'end_date'] },
    }},
    { type: 'function', function: {
      name: 'get_museum_hours',
      description: 'Get opening hours, ticket prices, and booking info for museums',
      parameters: { type: 'object', properties: {
        museum_name: { type: 'string' },
        city:        { type: 'string' },
      }, required: ['museum_name', 'city'] },
    }},
    { type: 'function', function: {
      name: 'search_restaurants',
      description: 'Find top-rated restaurants by cuisine and budget',
      parameters: { type: 'object', properties: {
        city:    { type: 'string' },
        cuisine: { type: 'string' },
        budget:  { type: 'string', enum: ['budget', 'mid-range', 'fine-dining'] },
        limit:   { type: 'integer' },
      }, required: ['city'] },
    }},
  ],
  'route-optimizer-agent': [
    { type: 'function', function: {
      name: 'get_distance_matrix',
      description: 'Get travel times and distances between multiple locations',
      parameters: { type: 'object', properties: {
        locations: { type: 'array', items: { type: 'string' } },
        mode:      { type: 'string', enum: ['walking', 'transit', 'driving'] },
      }, required: ['locations'] },
    }},
    { type: 'function', function: {
      name: 'calculate_route',
      description: 'Calculate the optimal visiting order for a list of attractions',
      parameters: { type: 'object', properties: {
        start_location: { type: 'string' },
        attractions:    { type: 'array', items: { type: 'string' } },
        optimize_for:   { type: 'string', enum: ['time', 'distance', 'cost'] },
      }, required: ['start_location', 'attractions'] },
    }},
  ],
};

// ── Simulated tool handlers ───────────────────────────────────────────────────
// Return realistic-looking fake data so the demo works without real API keys.

type ToolArgs = Record<string, unknown>;

const TOOL_HANDLERS: Record<string, (args: ToolArgs) => string> = {
  search_destination_info: (a) => JSON.stringify({
    destination: a['destination'],
    highlights: ['Historic city center', 'World-class museums', 'Local cuisine'],
    best_neighborhoods: ['Old Town', 'Cultural Quarter', 'Waterfront'],
    local_tips: ['Book museums in advance', 'Use public transit', 'Try street food'],
    currency: 'EUR',
  }),
  get_weather_forecast: (a) => JSON.stringify({
    destination: a['destination'],
    forecast: [
      { date: a['start_date'], condition: 'Partly cloudy', high_c: 18, low_c: 12 },
      { date: a['end_date'],   condition: 'Sunny',         high_c: 22, low_c: 14 },
    ],
    summary: 'Mild spring weather, light layers recommended',
  }),
  get_travel_advisories: (a) => JSON.stringify({
    destination: a['destination'],
    safety_level: 'Low risk',
    advisory: 'Normal precautions apply',
    visa_required: false,
    emergency_number: '112',
  }),
  search_hotels: (a) => JSON.stringify({
    destination: a['destination'],
    results: [
      { name: 'Grand Hotel Central',   stars: 4, price_per_night: 140, rating: 4.5 },
      { name: 'Boutique Old Town Inn', stars: 3, price_per_night:  90, rating: 4.7 },
      { name: 'Modern City Suites',    stars: 4, price_per_night: 120, rating: 4.3 },
    ],
  }),
  check_availability: () => JSON.stringify({ available: true, rooms_left: 3, price_per_night: 130 }),
  get_hotel_reviews:  () => JSON.stringify({ average_rating: 4.5, reviews: [
    { score: 5, comment: 'Excellent location, very clean' },
    { score: 4, comment: 'Great staff, comfortable beds' },
  ]}),
  search_flights: () => JSON.stringify({ results: [
    { airline: 'AirEuro',  departure: '08:00', arrival: '10:30', price: 210, duration: '2h30m' },
    { airline: 'SkyLink',  departure: '14:00', arrival: '16:45', price: 175, duration: '2h45m' },
  ]}),
  search_trains: () => JSON.stringify({ results: [
    { operator: 'EuroRail',   departure: '09:00', arrival: '11:45', price: 65, class: '2nd' },
    { operator: 'HighSpeed',  departure: '12:00', arrival: '13:50', price: 95, class: '1st' },
  ]}),
  get_taxi_rates: () => JSON.stringify({ base_fare: 3.50, per_km: 1.80, airport_flat_rate: 45, currency: 'EUR' }),
  search_events: (a) => JSON.stringify({ destination: a['destination'], events: [
    { name: 'Jazz Festival', date: a['start_date'], venue: 'City Park',      price: 25 },
    { name: 'Food Market',   date: a['start_date'], venue: 'Central Square', price: 0  },
    { name: 'Art Exhibition',date: a['end_date'],   venue: 'National Gallery',price: 15 },
  ]}),
  get_museum_hours: (a) => JSON.stringify({
    museum: a['museum_name'],
    hours: 'Tue–Sun 10:00–18:00, closed Monday',
    ticket_price: 18,
    booking_required: true,
  }),
  search_restaurants: (a) => JSON.stringify({ city: a['city'], restaurants: [
    { name: 'La Piazza',     cuisine: 'Italian', rating: 4.7, avg_price: 35 },
    { name: 'Bistro Moderne',cuisine: 'French',  rating: 4.5, avg_price: 45 },
    { name: 'Street Kitchen',cuisine: 'Local',   rating: 4.8, avg_price: 15 },
  ]}),
  get_distance_matrix: (a) => {
    const locs = (a['locations'] as string[]) ?? [];
    return JSON.stringify({
      locations: locs,
      matrix: locs.map((_, i) => locs.map((__, j) => i === j ? 0 : Math.abs(i - j) * 12)),
      unit: 'minutes',
    });
  },
  calculate_route: (a) => JSON.stringify({
    start: a['start_location'],
    optimized_order: a['attractions'],
    total_travel_time: `${((a['attractions'] as string[])?.length ?? 0) * 25} minutes`,
    tip: 'Start early to avoid crowds at popular sites',
  }),
};

// ── Agent callable functions ──────────────────────────────────────────────────

async function callAgent(agentId: string, prompt: string): Promise<string> {
  const handle = agentHandles[agentId];
  if (!handle) throw new Error(`Unknown agent: ${agentId}`);

  const tools = AGENT_TOOL_DEFS[agentId];
  if (tools) {
    // handle.chat() owns the tool loop; the SDK patches the OpenAI call and strips
    // any tool whose dashboard toggle is OFF before forwarding to OpenAI.
    return handle.chat({
      client,
      messages: [{ role: 'user', content: prompt }],
      tools,
      onTool: TOOL_HANDLERS,
      maxRounds: 5,
      maxTokens: 2048,
    });
  }

  // No tools (itinerary-creator-agent) — plain completion
  return handle.run(async () => {
    const model      = handle.cfg('llm.model', 'gpt-4o-mini');
    const temperature = handle.cfg('llm.temperature', 0.7);
    const maxTokens  = handle.cfg('llm.max_tokens', 4096);
    const response = await client.chat.completions.create({
      model:       model as string,
      temperature: temperature as number,
      max_tokens:  maxTokens  as number,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.choices[0].message.content ?? '';
  });
}

async function researcherAgent(task: string): Promise<string> {
  return callAgent('researcher-agent', task);
}

async function hotelFinderAgent(task: string): Promise<string> {
  return callAgent('hotel-finder-agent', task);
}

async function transportAgent(task: string): Promise<string> {
  return callAgent('transport-agent', task);
}

async function eventsAgent(task: string): Promise<string> {
  return callAgent('events-agent', task);
}

async function routeOptimizerAgent(task: string): Promise<string> {
  return callAgent('route-optimizer-agent', task);
}

async function itineraryCreatorAgent(task: string): Promise<string> {
  return callAgent('itinerary-creator-agent', task);
}

async function travelOrchestrator(task: string): Promise<string> {
  // Step 1: Research the destination
  const research = await callAgent('researcher-agent', `Research this travel request in detail: ${task}`);

  // Step 2: Parallel swarm — hotels, transport, events simultaneously
  const [hotel, transport, events] = await Promise.all([
    callAgent('hotel-finder-agent', `Find the best hotels for: ${task}\n\nContext: ${research.slice(0, 600)}`),
    callAgent('transport-agent', `Find all transport options for: ${task}\n\nContext: ${research.slice(0, 600)}`),
    callAgent('events-agent', `Find top events and activities for: ${task}\n\nContext: ${research.slice(0, 600)}`),
  ]);

  // Step 3: Route optimization
  const route = await callAgent(
    'route-optimizer-agent',
    `Optimize the routes for: ${task}\nHotels: ${hotel.slice(0, 400)}\nTransport: ${transport.slice(0, 400)}\nEvents: ${events.slice(0, 400)}`,
  );

  // Step 4: Synthesize final itinerary
  return callAgent(
    'itinerary-creator-agent',
    `Create a complete, detailed itinerary for: ${task}\n\n` +
    `Research:\n${research.slice(0, 600)}\n\n` +
    `Hotels:\n${hotel.slice(0, 400)}\n\n` +
    `Transport:\n${transport.slice(0, 400)}\n\n` +
    `Events:\n${events.slice(0, 400)}\n\n` +
    `Optimized Route:\n${route.slice(0, 400)}`,
  );
}

// Map agent IDs to callable functions
const AGENT_FUNCTIONS: Record<string, (task: string) => Promise<string>> = {
  'travel-orchestrator':     travelOrchestrator,
  'researcher-agent':        researcherAgent,
  'hotel-finder-agent':      hotelFinderAgent,
  'transport-agent':         transportAgent,
  'events-agent':            eventsAgent,
  'route-optimizer-agent':   routeOptimizerAgent,
  'itinerary-creator-agent': itineraryCreatorAgent,
};

// ── Create agent router (SDK routes HTTP to agent functions) ──────────────────

const router = sdk.createAgentRouter(AGENT_FUNCTIONS);

console.info('✓ Agent router created with auto-routed endpoints');

// ── Express server ────────────────────────────────────────────────────────────

import express from 'express';

const app = express();
app.use(express.json());

// Mount SDK's per-agent routes
app.use(router.express());

// Global health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'travel-agent', version: '1.0.0' });
});

// ── Start server ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.info('');
  console.info('='.repeat(80));
  console.info('TRAVEL AGENT SERVER STARTING');
  console.info('='.repeat(80));
  console.info(`Server: http://localhost:${PORT}  (agentUrl=${AGENT_URL})`);
  console.info('');
  console.info('SDK auto-generated endpoints (routing handled by SDK):');
  for (const agentId of SUB_AGENT_IDS) {
    console.info(`  POST /agent/${agentId}/run`);
    console.info(`  POST /agent/${agentId}/chat`);
    console.info(`  GET  /agent/${agentId}/health`);
  }
  console.info('');
  console.info(`Expose publicly: ngrok http ${PORT}`);
  console.info('='.repeat(80));
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.info('\n✓ Travel agent server stopped');
  await sdk.shutdown();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await sdk.shutdown();
  process.exit(0);
});
