/**
 * Vercel AI Agent — Syrin SDK
 * ===========================
 * Express server built with the Vercel AI SDK (generateText).
 * The VercelAIAdapter patches generateText/streamText so every call
 * emits a LLM_CALL event with framework="vercel-ai" in the dashboard.
 *
 * Agent ID : vercel-agent   Port: 8006
 *
 * Install
 * -------
 *   npm install ai @ai-sdk/openai
 *
 * Run
 * ---
 *   npx tsx examples/agent-vercel.ts
 *
 * Endpoints
 * ---------
 *   GET  /          → agent info + active config
 *   GET  /config    → active config snapshot
 *   POST /chat      → single generateText() call
 *
 * Remote config
 * -------------
 *   llm.model · llm.temperature · llm.max_tokens
 *   vercel.max_steps · vercel.max_retries · vercel.abort_after_ms · vercel.structured_output
 *   agent.response_style · agent.debug_mode
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { openai as openaiProvider } from '@ai-sdk/openai';
import { init, withSession, shutdown, tune, refreshSchema, mountConfigEndpoint, VercelAIAdapter } from '../src/index.js';

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8006', 10);
const AGENT_ID = 'vercel-agent';

const vercelAdapter = new VercelAIAdapter();

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY']!,
  agentId: AGENT_ID,
  backendUrl: process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000',
  serverUrl: `http://localhost:${PORT}`,
  captureContent: true,
  batchSize: 1,
  idleFlushMs: 2_000,
  configPollIntervalMs: 5_000,
  adapters: [vercelAdapter],
  schemaDefaults: {
    'llm.model': 'gpt-4o-mini',
    'llm.temperature': 0.7,
    'llm.max_tokens': 400,
    'vercel.max_steps': 5,
    'vercel.max_retries': 2,
    'vercel.abort_after_ms': 0,
    'vercel.structured_output': false,
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

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(cors());

app.get('/', (_req: Request, res: Response) => {
  res.json({ agent: AGENT_ID, library: 'ai (@vercel/ai-sdk)', status: 'running', config: sdk.activeConfig() });
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
    // Use adapter.generateText() so calls are instrumented even when ESM
    // module bindings are read-only (which prevents monkey-patching 'ai').
    const result = await vercelAdapter.generateText({
      model: openaiProvider(String(cfg('llm.model', 'gpt-4o-mini'))),
      system: `You are a helpful assistant. Style: ${agentBehavior.response_style}.`,
      prompt: message,
      // vercel.* config is injected automatically by the adapter;
      // explicit values below are fallbacks for the first call
      temperature: Number(cfg('llm.temperature', 0.7)),
      maxTokens:   Number(cfg('llm.max_tokens', 400)),
      maxSteps:    Number(cfg('vercel.max_steps', 5)),
      maxRetries:  Number(cfg('vercel.max_retries', 2)),
    }) as { text: string; usage?: { promptTokens?: number; completionTokens?: number } };
    res.json({
      session_id: sid,
      response: result.text,
      tokens: { input: result.usage?.promptTokens ?? 0, output: result.usage?.completionTokens ?? 0 },
    });
  });
});

const server = app.listen(PORT, () => {
  console.log(`\n  ${AGENT_ID}  →  http://localhost:${PORT}`);
  console.log(`  Dashboard    →  http://localhost:5173\n`);
});

process.on('SIGTERM', async () => { server.close(); await shutdown(); });
process.on('SIGINT',  async () => { server.close(); await shutdown(); });
