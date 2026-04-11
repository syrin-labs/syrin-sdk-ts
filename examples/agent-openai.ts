/**
 * OpenAI Agent — Syrin SDK
 * ========================
 * Express server built with the OpenAI SDK.
 * The OpenAIAdapter is auto-installed by Syrin — no extra registration needed.
 *
 * Agent ID : openai-ts-agent   Port: 8001
 *
 * Run
 * ---
 *   npx tsx examples/agent-openai.ts
 *
 * Endpoints
 * ---------
 *   GET  /          → agent info + active config + enabled tools
 *   GET  /config    → active config snapshot
 *   POST /chat      → single LLM call with optional tool calling
 *   POST /research  → researcher → writer (2 LLM_CALL events)
 *   POST /analyze   → sentiment + themes in parallel (2 LLM_CALL events)
 *
 * Remote config
 * -------------
 *   llm.model · llm.temperature · llm.max_tokens · prompt.system_prompt
 *   tools.get_weather · tools.calculate · tools.search_web (boolean toggles)
 *   agent.response_style · agent.max_research_hops · agent.debug_mode
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { init, withSession, shutdown, tune, refreshSchema, mountConfigEndpoint } from '../src/index.js';

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8001', 10);
const AGENT_ID = 'openai-ts-agent';

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
    'llm.model': 'gpt-4o-mini',
    'llm.temperature': 0.7,
    'llm.max_tokens': 500,
    'prompt.system_prompt': 'You are a helpful assistant.',
  },
});

const cfg = (key: string, fallback: unknown): unknown => sdk.activeConfig()[key] ?? fallback;

// ── Custom tunables ───────────────────────────────────────────────────────────

const agentBehavior = {
  response_style: 'concise' as string,  // concise | detailed | bullets
  max_research_hops: 2,
  debug_mode: false,
};

const toolRegistry = {
  get_weather: true,
  calculate: true,
  search_web: true,
};

tune({ target: agentBehavior, namespace: 'agent', fields: { response_style: 'string', max_research_hops: 'number', debug_mode: 'boolean' } });
tune({ target: toolRegistry, namespace: 'tools', fields: { get_weather: 'boolean', calculate: 'boolean', search_web: 'boolean' } });

await refreshSchema();

// ── Tools ─────────────────────────────────────────────────────────────────────

const ALL_TOOL_DEFINITIONS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a city or location.',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string', description: "City name, e.g. 'San Francisco'" } },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a mathematical expression (supports math functions).',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: "e.g. '2 ** 10 + Math.sqrt(144)'" } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the web for recent information on a topic.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
];

function activeTools(): OpenAI.ChatCompletionTool[] {
  return ALL_TOOL_DEFINITIONS.filter(
    (t) => cfg(`tools.${t.function.name}`, (toolRegistry as Record<string, unknown>)[t.function.name] ?? true) as boolean
  );
}

const TOOL_IMPLS: Record<string, (args: Record<string, unknown>) => string> = {
  get_weather: ({ location }) =>
    JSON.stringify({ location, temperature: '72°F', condition: 'partly cloudy', humidity: '55%' }),
  calculate: ({ expression }) => {
    try { return String(eval(String(expression))); } catch (e) { return `Error: ${e}`; }  // eslint-disable-line no-eval
  },
  search_web: ({ query }) =>
    JSON.stringify({
      query,
      results: [
        { title: `Result 1 for '${query}'`, snippet: '...' },
        { title: `Result 2 for '${query}'`, snippet: '...' },
      ],
      note: 'Mock result. Plug in a real search API for production.',
    }),
};

// ── LLM helper ────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env['OPENAI_API_KEY']! });

async function llm(
  messages: OpenAI.ChatCompletionMessageParam[],
  withTools = false,
): Promise<string> {
  const tools = withTools ? activeTools() : undefined;
  const resp = await openai.chat.completions.create({
    model: String(cfg('llm.model', 'gpt-4o-mini')),
    temperature: Number(cfg('llm.temperature', 0.7)),
    max_tokens: Number(cfg('llm.max_tokens', 500)),
    messages,
    ...(tools?.length ? { tools } : {}),
  });

  const choice = resp.choices[0];
  if (!choice) return '';

  // Handle one round of tool calls
  if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
    const toolMessages: OpenAI.ChatCompletionMessageParam[] = [
      choice.message,
      ...choice.message.tool_calls.map((tc) => {
        const impl = TOOL_IMPLS[tc.function.name];
        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        return {
          role: 'tool' as const,
          tool_call_id: tc.id,
          content: impl ? impl(args) : `Tool '${tc.function.name}' not found.`,
        };
      }),
    ];
    const followUp = await openai.chat.completions.create({
      model: String(cfg('llm.model', 'gpt-4o-mini')),
      temperature: Number(cfg('llm.temperature', 0.7)),
      max_tokens: Number(cfg('llm.max_tokens', 500)),
      messages: [...messages, ...toolMessages],
    });
    return followUp.choices[0]?.message.content ?? '';
  }

  return choice.message.content ?? '';
}

// ── Multi-agent pipelines ─────────────────────────────────────────────────────

async function researchPipeline(topic: string): Promise<{ research: string; article: string }> {
  // Agent 1: Researcher
  const research = await llm([
    { role: 'system', content: 'You are a research specialist. Provide factual, numbered answers.' },
    { role: 'user', content: `Research topic: ${topic}. List 5 key facts as a numbered list.` },
  ]);
  // Agent 2: Writer
  const article = await llm([
    { role: 'system', content: 'You are an expert writer. Write a 3-paragraph article (under 200 words) from the research.' },
    { role: 'user', content: `Topic: ${topic}\n\nResearch:\n${research}` },
  ]);
  return { research, article };
}

async function analyzePipeline(text: string): Promise<{ sentiment: string; themes: string }> {
  // Both agents run sequentially (independent analysis)
  const sentiment = await llm([
    { role: 'system', content: 'Classify sentiment. Line 1: one word (positive/negative/neutral). Line 2: one-sentence explanation.' },
    { role: 'user', content: text },
  ]);
  const themes = await llm([
    { role: 'system', content: 'Extract the 3 most important themes as a concise bullet list.' },
    { role: 'user', content: text },
  ]);
  return { sentiment, themes };
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(cors());

app.get('/', (_req: Request, res: Response) => {
  res.json({
    agent: AGENT_ID,
    library: 'openai',
    status: 'running',
    config: sdk.activeConfig(),
    active_tools: activeTools().map((t) => t.function.name),
  });
});

app.get('/config', (_req: Request, res: Response) => {
  res.json({ active: sdk.activeConfig() });
});

// Receive config pushes from the dashboard (parity with Python's mount_config_endpoint)
app.post('/syrin/config', mountConfigEndpoint());

app.post('/chat', async (req: Request, res: Response) => {
  const { message, session_id } = req.body as { message: string; session_id?: string };
  const sid = session_id ?? `chat-${Math.random().toString(36).slice(2, 10)}`;

  await withSession(sid, async () => {
    const response = await llm(
      [
        { role: 'system', content: String(cfg('prompt.system_prompt', 'You are a helpful assistant.')) },
        { role: 'user', content: message },
      ],
      /* withTools */ true,
    );
    res.json({ session_id: sid, response, active_tools: activeTools().map((t) => t.function.name) });
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
  console.log(`  Dashboard   →  http://localhost:5173\n`);
});

process.on('SIGTERM', async () => { server.close(); await shutdown(); });
process.on('SIGINT',  async () => { server.close(); await shutdown(); });
