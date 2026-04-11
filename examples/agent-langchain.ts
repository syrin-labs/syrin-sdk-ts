/**
 * LangChain Agent — Syrin SDK
 * ===========================
 * Express server built with LangChain (ChatOpenAI + prompt template + chain).
 * The LangChainAdapter wraps the chain so every invocation emits a
 * CHAIN_EXECUTION event visible in the dashboard.
 *
 * Agent ID : langchain-ts-agent   Port: 8003
 *
 * Install
 * -------
 *   npm install @langchain/openai @langchain/core
 *
 * Run
 * ---
 *   npx tsx examples/agent-langchain.ts
 *
 * Endpoints
 * ---------
 *   GET  /          → agent info + active config
 *   GET  /config    → active config snapshot
 *   POST /chat      → single chain invocation
 *   POST /research  → researcher chain → writer chain (2 CHAIN_EXECUTION events)
 *   POST /analyze   → sentiment chain + themes chain (2 CHAIN_EXECUTION events)
 *
 * Remote config
 * -------------
 *   llm.model · llm.temperature · llm.max_tokens · prompt.system_prompt
 *   agent.chain_verbose · agent.max_output_tokens_override
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { init, withSession, shutdown, tune, refreshSchema, mountConfigEndpoint, LangChainAdapter, OpenAIAdapter } from '../src/index.js';

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8003', 10);
const AGENT_ID = 'langchain-ts-agent';

const adapter = new LangChainAdapter();

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY']!,
  agentId: AGENT_ID,
  backendUrl: process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000',
  serverUrl: `http://localhost:${PORT}`,
  captureContent: true,
  batchSize: 1,
  idleFlushMs: 2_000,
  configPollIntervalMs: 5_000,
  adapters: [new OpenAIAdapter(), adapter],
  schemaDefaults: {
    'llm.model': 'gpt-4o-mini',
    'llm.temperature': 0.7,
    'llm.max_tokens': 500,
    'prompt.system_prompt': 'You are a helpful assistant.',
  },
});

const cfg = (key: string, fallback: unknown): unknown => sdk.activeConfig()[key] ?? fallback;

// ── Custom tunables ───────────────────────────────────────────────────────────

const agentBehavior = {
  chain_verbose: false,
  max_output_tokens_override: 0,  // 0 = disabled; >0 overrides llm.max_tokens
};

tune({ target: agentBehavior, namespace: 'agent', fields: { chain_verbose: 'boolean', max_output_tokens_override: 'number' } });

await refreshSchema();

// ── Chain builder ─────────────────────────────────────────────────────────────

function makeLLM(): ChatOpenAI {
  const maxTokens = agentBehavior.max_output_tokens_override > 0
    ? agentBehavior.max_output_tokens_override
    : Number(cfg('llm.max_tokens', 500));

  return new ChatOpenAI({
    model: String(cfg('llm.model', 'gpt-4o-mini')),
    temperature: Number(cfg('llm.temperature', 0.7)),
    maxTokens,
    apiKey: process.env['OPENAI_API_KEY'],
    verbose: agentBehavior.chain_verbose,
  });
}

// Chains are rebuilt per-request so remote config changes take effect immediately.

async function runChain(systemPrompt: string, humanInput: string, chainName: string): Promise<string> {
  const llm = makeLLM();
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', systemPrompt],
    ['human', '{input}'],
  ]);
  const chain = adapter.wrap(prompt.pipe(llm).pipe(new StringOutputParser()), { chainName });
  return chain.invoke({ input: humanInput });
}

// ── Multi-agent pipelines ─────────────────────────────────────────────────────

async function researchPipeline(topic: string): Promise<{ research: string; article: string }> {
  // Chain 1: Researcher
  const research = await runChain(
    'You are a research specialist. Provide factual, numbered answers.',
    `Research topic: ${topic}. List 5 key facts as a numbered list.`,
    'researcher',
  );
  // Chain 2: Writer
  const article = await runChain(
    'You are an expert writer. Write a 3-paragraph article (under 200 words) from the research.',
    `Topic: ${topic}\n\nResearch:\n${research}`,
    'writer',
  );
  return { research, article };
}

async function analyzePipeline(text: string): Promise<{ sentiment: string; themes: string }> {
  // Chain 1: Sentiment
  const sentiment = await runChain(
    'Classify sentiment. Line 1: one word (positive/negative/neutral). Line 2: one-sentence explanation.',
    text,
    'sentiment',
  );
  // Chain 2: Themes
  const themes = await runChain(
    'Extract the 3 most important themes as a concise bullet list.',
    text,
    'themes',
  );
  return { sentiment, themes };
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(cors());

app.get('/', (_req: Request, res: Response) => {
  res.json({ agent: AGENT_ID, library: '@langchain/openai', status: 'running', config: sdk.activeConfig() });
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
    const response = await runChain(
      String(cfg('prompt.system_prompt', 'You are a helpful assistant.')),
      message,
      'chat',
    );
    res.json({ session_id: sid, response });
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
      analysis: `Sentiment:\n${result.sentiment}\n\nThemes: ${result.themes}`,
    });
  });
});

const server = app.listen(PORT, () => {
  console.log(`\n  ${AGENT_ID}  →  http://localhost:${PORT}`);
  console.log(`  Dashboard    →  http://localhost:5173\n`);
});

process.on('SIGTERM', async () => { server.close(); await shutdown(); });
process.on('SIGINT',  async () => { server.close(); await shutdown(); });
