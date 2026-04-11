/**
 * Anthropic Agent — Syrin SDK
 * ===========================
 * Express server built with the Anthropic SDK.
 * The AnthropicAdapter is auto-installed when @anthropic-ai/sdk is present.
 *
 * Agent ID : anthropic-ts-agent   Port: 8002
 *
 * Requires
 * --------
 *   ANTHROPIC_API_KEY in examples/.env
 *
 * Run
 * ---
 *   npx tsx examples/agent-anthropic.ts
 *
 * Endpoints
 * ---------
 *   GET  /          → agent info + active config
 *   GET  /config    → active config snapshot
 *   POST /chat      → single LLM call
 *   POST /research  → researcher → writer (2 LLM_CALL events)
 *   POST /analyze   → sentiment + key-points (2 LLM_CALL events)
 *
 * Remote config
 * -------------
 *   llm.model · llm.max_tokens · prompt.system_prompt
 *   agent.response_style · agent.enable_thinking · agent.thinking_budget
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { init, withSession, shutdown, tune, refreshSchema, mountConfigEndpoint } from '../src/index.js';

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8002', 10);
const AGENT_ID = 'anthropic-ts-agent';

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY']!,
  agentId: AGENT_ID,
  backendUrl: process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000',
  serverUrl: `http://localhost:${PORT}`,
  captureContent: true,
  batchSize: 1,
  idleFlushMs: 2_000,
  configPollIntervalMs: 5_000,
  schemaDefaults: {
    'llm.model': 'claude-haiku-4-5-20251001',
    'llm.temperature': 0.7,
    'llm.max_tokens': 1024,
    'prompt.system_prompt': 'You are a helpful assistant.',
  },
});

const cfg = (key: string, fallback: unknown): unknown => sdk.activeConfig()[key] ?? fallback;

// ── Custom tunables ───────────────────────────────────────────────────────────

const agentBehavior = {
  response_style: 'concise' as string,  // concise | detailed | bullet_points
  enable_thinking: false,               // enable Claude's extended thinking mode
  thinking_budget: 5000,               // token budget for extended thinking
};

tune({ target: agentBehavior, namespace: 'agent', fields: { response_style: 'string', enable_thinking: 'boolean', thinking_budget: 'number' } });

await refreshSchema();

// ── LLM helper ────────────────────────────────────────────────────────────────

if (!process.env['ANTHROPIC_API_KEY']) {
  console.warn('  WARNING: ANTHROPIC_API_KEY not set — LLM calls will fail');
}
const anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] ?? 'sk-ant-placeholder' });

async function llm(
  messages: Anthropic.MessageParam[],
  system?: string,
): Promise<string> {
  const resp = await anthropic.messages.create({
    model: String(cfg('llm.model', 'claude-haiku-4-5-20251001')),
    max_tokens: Number(cfg('llm.max_tokens', 1024)),
    messages,
    ...(system ? { system } : {}),
  });
  return resp.content[0]?.type === 'text' ? resp.content[0].text : '';
}

// ── Multi-agent pipelines ─────────────────────────────────────────────────────

async function researchPipeline(topic: string): Promise<{ research: string; article: string }> {
  // Agent 1: Researcher
  const research = await llm(
    [{ role: 'user', content: `Research topic: ${topic}. List 5 key facts as a numbered list.` }],
    'You are a research specialist. Provide factual, numbered answers.',
  );
  // Agent 2: Writer
  const article = await llm(
    [{ role: 'user', content: `Topic: ${topic}\n\nResearch:\n${research}` }],
    'You are an expert writer. Write a 3-paragraph article (under 200 words) from the research.',
  );
  return { research, article };
}

async function analyzePipeline(text: string): Promise<{ sentiment: string; summary: string }> {
  // Agent 1: Sentiment classifier
  const sentiment = await llm(
    [{ role: 'user', content: text }],
    'Classify sentiment. Line 1: one word (positive/negative/neutral). Line 2: one-sentence explanation.',
  );
  // Agent 2: Summarizer
  const summary = await llm(
    [{ role: 'user', content: text }],
    'Extract the 3 most important points as a concise bullet list.',
  );
  return { sentiment, summary };
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(cors());

app.get('/', (_req: Request, res: Response) => {
  res.json({ agent: AGENT_ID, library: '@anthropic-ai/sdk', status: 'running', config: sdk.activeConfig() });
});

app.get('/config', (_req: Request, res: Response) => {
  res.json({ active: sdk.activeConfig() });
});

// Receive config pushes from the dashboard
app.post('/syrin/config', mountConfigEndpoint());

app.post('/chat', async (req: Request, res: Response) => {
  if (!process.env['ANTHROPIC_API_KEY']) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set in examples/.env' });
  }
  const { message, session_id } = req.body as { message: string; session_id?: string };
  const sid = session_id ?? `chat-${Math.random().toString(36).slice(2, 10)}`;

  await withSession(sid, async () => {
    const resp = await anthropic.messages.create({
      model: String(cfg('llm.model', 'claude-haiku-4-5-20251001')),
      max_tokens: Number(cfg('llm.max_tokens', 1024)),
      system: String(cfg('prompt.system_prompt', 'You are a helpful assistant.')),
      messages: [{ role: 'user', content: message }],
    });
    const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
    res.json({
      session_id: sid,
      response: text,
      model: resp.model,
      tokens: { input: resp.usage.input_tokens, output: resp.usage.output_tokens },
    });
  });
});

app.post('/research', async (req: Request, res: Response) => {
  const { topic, session_id } = req.body as { topic: string; session_id?: string };
  const sid = session_id ?? `chat-${Math.random().toString(36).slice(2, 10)}`;

  await withSession(sid, async () => {
    const result = await researchPipeline(topic);
    res.json({ session_id: sid, topic, ...result, agents: ['researcher', 'writer'] });
  });
});

app.post('/analyze', async (req: Request, res: Response) => {
  const { text, session_id } = req.body as { text: string; session_id?: string };
  const sid = session_id ?? `chat-${Math.random().toString(36).slice(2, 10)}`;

  await withSession(sid, async () => {
    const result = await analyzePipeline(text);
    res.json({
      session_id: sid,
      ...result,
      analysis: `Sentiment:\n${result.sentiment}\n\nKey points:\n${result.summary}`,
    });
  });
});

const server = app.listen(PORT, () => {
  console.log(`\n  ${AGENT_ID}  →  http://localhost:${PORT}`);
  console.log(`  Dashboard    →  http://localhost:5173\n`);
});

process.on('SIGTERM', async () => { server.close(); await shutdown(); });
process.on('SIGINT',  async () => { server.close(); await shutdown(); });
