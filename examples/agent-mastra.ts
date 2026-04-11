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
 *   GET  /          → agent info + active config
 *   GET  /config    → active config snapshot
 *   POST /chat      → single agent.generate() call
 *
 * Remote config
 * -------------
 *   llm.model · llm.temperature · llm.max_tokens
 *   mastra.max_steps · mastra.max_retries · mastra.record_steps
 *   agent.response_style · agent.debug_mode
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { Agent } from '@mastra/core/agent';
import { init, withSession, shutdown, tune, refreshSchema, mountConfigEndpoint, MastraAdapter } from '../src/index.js';

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

tune({ target: agentBehavior, namespace: 'agent', fields: { response_style: 'string', debug_mode: 'boolean' } });
await refreshSchema();

// ── Mastra agent (rebuilt per-request so model picks up config changes) ───────

const app = express();
app.use(express.json());
app.use(cors());

function makeAgent(): Agent {
  return new Agent({
    name: AGENT_ID,
    instructions: `You are a helpful assistant. Style: ${agentBehavior.response_style}.`,
    model: `openai/${String(cfg('llm.model', 'gpt-4o-mini'))}`,
  });
}

// ── Express routes ────────────────────────────────────────────────────────────

app.get('/', (_req: Request, res: Response) => {
  res.json({ agent: AGENT_ID, library: '@mastra/core', status: 'running', config: sdk.activeConfig() });
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
    res.json({ session_id: sid, response: text });
  });
});

const server = app.listen(PORT, () => {
  console.log(`\n  ${AGENT_ID}  →  http://localhost:${PORT}`);
  console.log(`  Dashboard    →  http://localhost:5173\n`);
});

process.on('SIGTERM', async () => { server.close(); await shutdown(); });
process.on('SIGINT',  async () => { server.close(); await shutdown(); });
