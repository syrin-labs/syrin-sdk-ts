/**
 * Mastra Agent — Syrin SDK
 * ========================
 * Express server built with the Mastra Agent framework.
 * The MastraAdapter patches Agent.generate() so every call emits a
 * LLM_CALL event with framework="mastra" in the dashboard.
 *
 * Agent ID : mastra-agent   Port: 8005
 *
 * Install
 * -------
 *   npm install @mastra/core
 *
 * Run
 * ---
 *   npx tsx examples/agent-mastra.ts
 *
 * Endpoints
 * ---------
 *   GET  /          → agent info + active config + enabled tools
 *   GET  /config    → active config snapshot
 *   POST /chat      → single agent.generate() call (with tool calling)
 *
 * Remote config
 * -------------
 *   llm.model · llm.temperature · llm.max_tokens
 *   prompt.system_prompt
 *   mastra.max_steps · mastra.max_retries · mastra.record_steps
 *   tools.get_weather · tools.calculate · tools.search_web (boolean toggles)
 *   agent.response_style · agent.debug_mode
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { init, withSession, shutdown, tune, refreshSchema, mountConfigEndpoint, MastraAdapter } from '../dist/index.js';

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8005', 10);
const AGENT_ID = 'mastra-agent';

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY']!,
  agentId: AGENT_ID,
  backendUrl: process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000',
  serverUrl: `http://localhost:${PORT}`,
  captureContent: true,
  batchSize: 1,
  idleFlushMs: 2_000,
  configPollIntervalMs: 5_000,
  adapters: [new MastraAdapter()],
  schemaDefaults: {
    'llm.model': 'gpt-4o-mini',
    'llm.temperature': 0.7,
    'llm.max_tokens': 400,
    'prompt.system_prompt': 'You are a helpful assistant.',
    'mastra.max_steps': 5,
    'mastra.max_retries': 2,
    'mastra.record_steps': false,
  },
});

const cfg = (key: string, fallback: unknown): unknown => sdk.activeConfig()[key] ?? fallback;

// ── Custom tunables ───────────────────────────────────────────────────────────

const agentBehavior = {
  response_style: 'concise' as string,  // concise | detailed | bullets
  debug_mode: false,
};

const toolRegistry = {
  get_weather: true,
  calculate: true,
  search_web: true,
};

tune({ target: agentBehavior, namespace: 'agent', fields: { response_style: 'string', debug_mode: 'boolean' } });
tune({ target: toolRegistry, namespace: 'tools', fields: { get_weather: 'boolean', calculate: 'boolean', search_web: 'boolean' } });
await refreshSchema();

// ── Tool definitions (Mastra format) ─────────────────────────────────────────

const getWeatherTool = createTool({
  id: 'get_weather',
  description: 'Get current weather for a city or location.',
  inputSchema: z.object({ location: z.string().describe("City name, e.g. 'San Francisco'") }),
  execute: async ({ location }: { location: string }) => ({
    location,
    temperature: '72°F',
    condition: 'partly cloudy',
    humidity: '55%',
    source: 'mock-weather-api',
  }),
});

const calculateTool = createTool({
  id: 'calculate',
  description: 'Evaluate a mathematical expression.',
  inputSchema: z.object({ expression: z.string().describe("e.g. '2 ** 10 + 144 ** 0.5'") }),
  execute: async ({ expression }: { expression: string }) => {
    try {
      const result = Function(`"use strict"; return (${expression})`)() as unknown;
      return { expression, result: String(result) };
    } catch (e) {
      return { expression, error: String(e) };
    }
  },
});

const searchWebTool = createTool({
  id: 'search_web',
  description: 'Search the web for recent information on a topic.',
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }: { query: string }) => ({
    query,
    results: [
      { title: `Result 1 for '${query}'`, snippet: 'Mock snippet 1 — plug in a real search API.' },
      { title: `Result 2 for '${query}'`, snippet: 'Mock snippet 2 — plug in a real search API.' },
    ],
    note: 'Mock result. Plug in a real search API for production.',
  }),
});

const ALL_TOOLS = { get_weather: getWeatherTool, calculate: calculateTool, search_web: searchWebTool };

function activeTools(): typeof ALL_TOOLS {
  const enabled: Partial<typeof ALL_TOOLS> = {};
  for (const [name, tool] of Object.entries(ALL_TOOLS)) {
    const isEnabled = cfg(`tools.${name}`, (toolRegistry as Record<string, unknown>)[name] ?? true) as boolean;
    if (isEnabled) (enabled as Record<string, unknown>)[name] = tool;
  }
  return enabled as typeof ALL_TOOLS;
}

// ── Mastra agent (rebuilt per-request so model picks up config changes) ───────

const app = express();
app.use(express.json());
app.use(cors());

function makeAgent(): Agent {
  return new Agent({
    name: AGENT_ID,
    instructions: String(cfg('prompt.system_prompt', `You are a helpful assistant. Style: ${agentBehavior.response_style}. When the user asks about weather, calculations, or needs web information, use the available tools.`)),
    model: `openai/${String(cfg('llm.model', 'gpt-4o-mini'))}`,
    tools: activeTools(),
  });
}

// ── Express routes ────────────────────────────────────────────────────────────

app.get('/', (_req: Request, res: Response) => {
  res.json({
    agent: AGENT_ID,
    library: '@mastra/core',
    status: 'running',
    config: sdk.activeConfig(),
    active_tools: Object.keys(activeTools()),
  });
});

app.get('/config', (_req: Request, res: Response) => {
  res.json({ active: sdk.activeConfig() });
});

// Receive config pushes from the dashboard
app.post('/syrin/config', mountConfigEndpoint());

app.post('/chat', async (req: Request, res: Response) => {
  const { message, session_id } = req.body as { message: string; session_id?: string };
  const sid = session_id ?? `chat-${Math.random().toString(36).slice(2, 10)}`;

  await withSession(sid, async () => {
    const agent = makeAgent();
    const result = await agent.generate(message, {
      // Mastra-specific opts injected automatically from mastra.* config —
      // pass explicit values as fallback for first call before remote config arrives
      maxSteps:   Number(cfg('mastra.max_steps', 5)),
      maxRetries: Number(cfg('mastra.max_retries', 2)),
    } as Record<string, unknown>);
    const text = await result.text;
    res.json({
      session_id: sid,
      response: text,
      active_tools: Object.keys(activeTools()),
    });
  });
});

const server = app.listen(PORT, () => {
  console.log(`\n  ${AGENT_ID}  →  http://localhost:${PORT}`);
  console.log(`  Dashboard    →  http://localhost:5173\n`);
});

process.on('SIGTERM', async () => { server.close(); await shutdown(); });
process.on('SIGINT',  async () => { server.close(); await shutdown(); });
