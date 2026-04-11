/**
 * LangGraph Agent — Syrin SDK
 * ===========================
 * Express server built with LangGraph (multi-node StateGraphs).
 * The LangGraphAdapter patches StateGraph.addNode and graph.invoke so every
 * node execution emits a NODE_EXECUTION event in the dashboard.
 *
 * Agent ID : langgraph-ts-agent   Port: 8004
 *
 * Install
 * -------
 *   npm install @langchain/langgraph @langchain/openai @langchain/core
 *
 * Run
 * ---
 *   npx tsx examples/agent-langgraph.ts
 *
 * Endpoints
 * ---------
 *   GET  /          → agent info + active config
 *   GET  /config    → active config snapshot
 *   POST /chat      → 2-node graph: draft → respond
 *   POST /research  → 3-node graph: planner → researcher → writer
 *   POST /analyze   → 2-node graph: classify sentiment → summarize
 *
 * Remote config
 * -------------
 *   llm.model · llm.temperature · llm.max_tokens · langgraph.recursion_limit
 *   agent.max_node_retries · agent.stream_intermediate
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { init, withSession, shutdown, tune, refreshSchema, mountConfigEndpoint, LangGraphAdapter, OpenAIAdapter } from '../src/index.js';

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8004', 10);
const AGENT_ID = 'langgraph-ts-agent';

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY']!,
  agentId: AGENT_ID,
  backendUrl: process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000',
  serverUrl: `http://localhost:${PORT}`,
  captureContent: true,
  batchSize: 1,
  idleFlushMs: 2_000,
  configPollIntervalMs: 5_000,
  adapters: [new OpenAIAdapter(), new LangGraphAdapter()],
  schemaDefaults: {
    'llm.model': 'gpt-4o-mini',
    'llm.temperature': 0.7,
    'llm.max_tokens': 500,
    'langgraph.recursion_limit': 25,
  },
});

const cfg = (key: string, fallback: unknown): unknown => sdk.activeConfig()[key] ?? fallback;

// ── Custom tunables ───────────────────────────────────────────────────────────

const agentBehavior = {
  max_node_retries: 1,
  stream_intermediate: false,
};

tune({ target: agentBehavior, namespace: 'agent', fields: { max_node_retries: 'number', stream_intermediate: 'boolean' } });

await refreshSchema();

// ── LLM factory ──────────────────────────────────────────────────────────────

function makeLLM(): ChatOpenAI {
  return new ChatOpenAI({
    model: String(cfg('llm.model', 'gpt-4o-mini')),
    temperature: Number(cfg('llm.temperature', 0.7)),
    maxTokens: Number(cfg('llm.max_tokens', 500)),
    apiKey: process.env['OPENAI_API_KEY'],
  });
}

// ── Graph: Chat (2 nodes) ─────────────────────────────────────────────────────

const ChatState = Annotation.Root({
  input: Annotation<string>,
  draft: Annotation<string>,
  response: Annotation<string>,
});

type ChatS = typeof ChatState.State;

function buildChatGraph() {
  const llm = makeLLM();
  return new StateGraph(ChatState)
    .addNode('think', async (state: ChatS) => {
      const resp = await llm.invoke([
        new SystemMessage('Think through the question briefly.'),
        new HumanMessage(state.input),
      ]);
      return { draft: String(resp.content) };
    })
    .addNode('respond', async (state: ChatS) => {
      const resp = await llm.invoke([
        new SystemMessage('Give a clear, concise final answer.'),
        new HumanMessage(`Question: ${state.input}\nThinking: ${state.draft}`),
      ]);
      return { response: String(resp.content) };
    })
    .addEdge(START, 'think')
    .addEdge('think', 'respond')
    .addEdge('respond', END)
    .compile();
}

// ── Graph: Research (3 nodes) ─────────────────────────────────────────────────

const ResearchState = Annotation.Root({
  topic: Annotation<string>,
  plan: Annotation<string>,
  research: Annotation<string>,
  article: Annotation<string>,
});

type ResearchS = typeof ResearchState.State;

function buildResearchGraph() {
  const llm = makeLLM();
  return new StateGraph(ResearchState)
    .addNode('planner', async (state: ResearchS) => {
      const resp = await llm.invoke([
        new SystemMessage('You are a research planner. Outline 3 key angles to explore.'),
        new HumanMessage(`Topic: ${state.topic}`),
      ]);
      return { plan: String(resp.content) };
    })
    .addNode('researcher', async (state: ResearchS) => {
      const resp = await llm.invoke([
        new SystemMessage('You are a research specialist. Provide factual, numbered answers.'),
        new HumanMessage(`Topic: ${state.topic}\nPlan: ${state.plan}\nList 5 key facts.`),
      ]);
      return { research: String(resp.content) };
    })
    .addNode('writer', async (state: ResearchS) => {
      const resp = await llm.invoke([
        new SystemMessage('You are an expert writer. Write a 3-paragraph article (under 200 words) from the research.'),
        new HumanMessage(`Topic: ${state.topic}\n\nResearch:\n${state.research}`),
      ]);
      return { article: String(resp.content) };
    })
    .addEdge(START, 'planner')
    .addEdge('planner', 'researcher')
    .addEdge('researcher', 'writer')
    .addEdge('writer', END)
    .compile();
}

// ── Graph: Analyze (2 nodes) ──────────────────────────────────────────────────

const AnalyzeState = Annotation.Root({
  text: Annotation<string>,
  sentiment: Annotation<string>,
  summary: Annotation<string>,
});

type AnalyzeS = typeof AnalyzeState.State;

function buildAnalyzeGraph() {
  const llm = makeLLM();
  return new StateGraph(AnalyzeState)
    .addNode('classify', async (state: AnalyzeS) => {
      const resp = await llm.invoke([
        new SystemMessage('Classify sentiment. Line 1: one word (positive/negative/neutral). Line 2: one-sentence explanation.'),
        new HumanMessage(state.text),
      ]);
      return { sentiment: String(resp.content) };
    })
    .addNode('summarize', async (state: AnalyzeS) => {
      const resp = await llm.invoke([
        new SystemMessage('Extract the 3 most important points as a concise bullet list.'),
        new HumanMessage(state.text),
      ]);
      return { summary: String(resp.content) };
    })
    .addEdge(START, 'classify')
    .addEdge('classify', 'summarize')
    .addEdge('summarize', END)
    .compile();
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(cors());

app.get('/', (_req: Request, res: Response) => {
  res.json({ agent: AGENT_ID, library: '@langchain/langgraph', status: 'running', config: sdk.activeConfig() });
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
    const compiled = buildChatGraph();
    const result = await compiled.invoke({ input: message, draft: '', response: '' });
    res.json({ session_id: sid, response: result.response });
  });
});

app.post('/research', async (req: Request, res: Response) => {
  const { topic, session_id } = req.body as { topic: string; session_id?: string };
  const sid = session_id ?? `chat-${Math.random().toString(36).slice(2, 10)}`;

  await withSession(sid, async () => {
    const compiled = buildResearchGraph();
    const result = await compiled.invoke({ topic, plan: '', research: '', article: '' });
    res.json({ session_id: sid, topic, research: result.research, article: result.article, agents: ['planner', 'researcher', 'writer'] });
  });
});

app.post('/analyze', async (req: Request, res: Response) => {
  const { text, session_id } = req.body as { text: string; session_id?: string };
  const sid = session_id ?? `chat-${Math.random().toString(36).slice(2, 10)}`;

  await withSession(sid, async () => {
    const compiled = buildAnalyzeGraph();
    const result = await compiled.invoke({ text, sentiment: '', summary: '' });
    res.json({
      session_id: sid,
      sentiment: result.sentiment,
      summary: result.summary,
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
