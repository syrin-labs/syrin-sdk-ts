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
    .field('llm.model', 'gpt-4o-mini', { label: 'LLM Model', enum: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] })
    .field('llm.temperature', 0.7, { label: 'Temperature', ge: 0.0, le: 1.0 })
    .field('llm.max_tokens', 2048, { label: 'Max Tokens', ge: 256, le: 8192 })
    .field('prompt.system_prompt', 'You are an expert travel researcher. Research the destination thoroughly.', { label: 'System Prompt', multiline: true }),

  'hotel-finder-agent': sdk.agent('hotel-finder-agent')
    .field('llm.model', 'gpt-4o-mini', { label: 'LLM Model', enum: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] })
    .field('llm.temperature', 0.5, { label: 'Temperature', ge: 0.0, le: 1.0 })
    .field('llm.max_tokens', 2048, { label: 'Max Tokens', ge: 256, le: 8192 })
    .field('prompt.system_prompt', 'You are a hotel expert. Find the best accommodations.', { label: 'System Prompt', multiline: true }),

  'transport-agent': sdk.agent('transport-agent')
    .field('llm.model', 'gpt-4o-mini', { label: 'LLM Model', enum: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] })
    .field('llm.temperature', 0.5, { label: 'Temperature', ge: 0.0, le: 1.0 })
    .field('llm.max_tokens', 2048, { label: 'Max Tokens', ge: 256, le: 8192 })
    .field('prompt.system_prompt', 'You are a transport specialist. Identify all transportation options.', { label: 'System Prompt', multiline: true }),

  'events-agent': sdk.agent('events-agent')
    .field('llm.model', 'gpt-4o-mini', { label: 'LLM Model', enum: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] })
    .field('llm.temperature', 0.8, { label: 'Temperature', ge: 0.0, le: 1.0 })
    .field('llm.max_tokens', 2048, { label: 'Max Tokens', ge: 256, le: 8192 })
    .field('prompt.system_prompt', 'You are an events expert. Discover local events and activities.', { label: 'System Prompt', multiline: true }),

  'route-optimizer-agent': sdk.agent('route-optimizer-agent')
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

// ── Agent callable functions ──────────────────────────────────────────────────

async function callAgent(agentId: string, prompt: string): Promise<string> {
  const handle = agentHandles[agentId];
  if (!handle) throw new Error(`Unknown agent: ${agentId}`);

  return handle.run(async () => {
    const model       = handle.cfg('llm.model', 'gpt-4o-mini');
    const temperature = handle.cfg('llm.temperature', 0.7);
    const maxTokens   = handle.cfg('llm.max_tokens', 2048);

    const response = await client.chat.completions.create({
      model,
      temperature: temperature as number,
      max_tokens: maxTokens as number,
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
