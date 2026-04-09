/**
 * Example 6: LangGraph Adapter
 *
 * Demonstrates Syrin's LangGraph instrumentation:
 *   - 3-node graph: research -> factCheck -> summarise
 *   - LangGraphAdapter emits GRAPH_EXECUTION + NODE_EXECUTION events
 *   - Each node calls OpenAI via ChatOpenAI from @langchain/openai
 *   - Config injection from ConfigStore 'langgraph' section
 *
 * Requirements:
 *   npm install @langchain/langgraph @langchain/openai @langchain/core
 *
 * Run with mock backend:
 *   OPENAI_BASE_URL=http://localhost:4318/v1 \
 *   OPENAI_API_KEY=sk-test \
 *   SYRIN_BACKEND_URL=http://localhost:4318 \
 *   SYRIN_API_KEY=syrin_test \
 *   npx tsx examples/06-langgraph.ts
 */

// ---------------------------------------------------------------------------
// Check @langchain/langgraph and @langchain/openai are installed
// ---------------------------------------------------------------------------

let StateGraph: typeof import('@langchain/langgraph').StateGraph;
let END: typeof import('@langchain/langgraph').END;
let START: typeof import('@langchain/langgraph').START;
let Annotation: typeof import('@langchain/langgraph').Annotation;

try {
  const lg = await import('@langchain/langgraph');
  StateGraph = lg.StateGraph;
  END = lg.END;
  START = lg.START;
  Annotation = lg.Annotation;
} catch {
  console.error(
    '[example-06] @langchain/langgraph is not installed.\n' +
    'Install it with:\n' +
    '  npm install @langchain/langgraph @langchain/openai @langchain/core\n' +
    'Then re-run this example.'
  );
  process.exit(0);
}

let ChatOpenAI: typeof import('@langchain/openai').ChatOpenAI;

try {
  const lo = await import('@langchain/openai');
  ChatOpenAI = lo.ChatOpenAI;
} catch {
  console.error(
    '[example-06] @langchain/openai is not installed.\n' +
    'Install it with:\n' +
    '  npm install @langchain/openai\n' +
    'Then re-run this example.'
  );
  process.exit(0);
}

import { init, shutdown, LangGraphAdapter } from '../src/index.js';

const BACKEND_URL = process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000';
const OPENAI_BASE_URL = process.env['OPENAI_BASE_URL'];

// ---------------------------------------------------------------------------
// Initialize SDK with LangGraphAdapter
// ---------------------------------------------------------------------------

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY'] ?? 'syrin_demo',
  backendUrl: BACKEND_URL,
  agentId: 'langgraph-demo-agent',
  debug: true,
  captureContent: true,
  adapters: [new LangGraphAdapter()],
});

console.log('='.repeat(60));
console.log('  SYRIN LANGGRAPH ADAPTER DEMO (TypeScript)');
console.log('='.repeat(60));
console.log(`  session_id : ${sdk.sessionId}`);
console.log(`  backend    : ${BACKEND_URL}`);
console.log();

// ---------------------------------------------------------------------------
// Graph state definition
// ---------------------------------------------------------------------------

const GraphState = Annotation.Root({
  question: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  facts: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  checked: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  summary: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
});

type GraphStateType = typeof GraphState.State;

// ---------------------------------------------------------------------------
// Build ChatOpenAI model
// (points to mock backend if OPENAI_BASE_URL is set)
// ---------------------------------------------------------------------------

const modelOptions: ConstructorParameters<typeof ChatOpenAI>[0] = {
  model: 'gpt-4o-mini',
  temperature: 0.3,
  maxTokens: 256,
  apiKey: process.env['OPENAI_API_KEY'] ?? 'sk-test',
};

if (OPENAI_BASE_URL) {
  modelOptions.configuration = { baseURL: OPENAI_BASE_URL };
}

const llm = new ChatOpenAI(modelOptions);

// ---------------------------------------------------------------------------
// Node definitions
// ---------------------------------------------------------------------------

async function researchNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  console.log(`  [research]   question="${state.question}"`);
  let facts = '';
  try {
    const response = await llm.invoke([
      {
        role: 'system',
        content: 'You are a research assistant. Provide 2-3 brief factual points.',
      },
      {
        role: 'user',
        content: `Research the following topic: ${state.question}`,
      },
    ]);
    facts = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);
  } catch {
    facts = `[mock] Research facts about: ${state.question}`;
  }
  console.log(`  [research]   facts collected (${facts.length} chars)`);
  return { facts };
}

async function factCheckNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  console.log(`  [factCheck]  verifying ${state.facts.length} chars of facts`);
  let checked = '';
  try {
    const response = await llm.invoke([
      {
        role: 'system',
        content: 'You are a fact-checker. Validate the facts and flag any inaccuracies.',
      },
      {
        role: 'user',
        content: `Fact-check these statements:\n${state.facts}`,
      },
    ]);
    checked = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);
  } catch {
    checked = `[mock] Verified: ${state.facts.slice(0, 80)}...`;
  }
  console.log(`  [factCheck]  checked (${checked.length} chars)`);
  return { checked };
}

async function summariseNode(state: GraphStateType): Promise<Partial<GraphStateType>> {
  console.log(`  [summarise]  summarising ${state.checked.length} chars`);
  let summary = '';
  try {
    const response = await llm.invoke([
      {
        role: 'system',
        content: 'You are an expert summariser. Write a concise 1-paragraph summary.',
      },
      {
        role: 'user',
        content: `Summarise these verified facts:\n${state.checked}`,
      },
    ]);
    summary = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);
  } catch {
    summary = `[mock] Summary for "${state.question}": ${state.checked.slice(0, 100)}...`;
  }
  console.log(`  [summarise]  summary ready (${summary.length} chars)`);
  return { summary };
}

// ---------------------------------------------------------------------------
// Build the graph: research → factCheck → summarise
// ---------------------------------------------------------------------------

const graph = new StateGraph(GraphState)
  .addNode('research', researchNode)
  .addNode('factCheck', factCheckNode)
  .addNode('summarise', summariseNode)
  .addEdge(START, 'research')
  .addEdge('research', 'factCheck')
  .addEdge('factCheck', 'summarise')
  .addEdge('summarise', END);

const compiledGraph = graph.compile();

// ---------------------------------------------------------------------------
// Run the graph
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const question = 'What are the main benefits of TypeScript over JavaScript?';
  console.log(`Running 3-node research pipeline for: "${question}"`);
  console.log();

  let finalState: GraphStateType;
  try {
    finalState = await compiledGraph.invoke({ question });
  } catch (err) {
    console.error(`  Graph execution failed: ${String(err)}`);
    await shutdown();
    return;
  }

  console.log();
  console.log('--- Final State ---');
  console.log(`  question : ${finalState.question}`);
  console.log(`  facts    : ${finalState.facts.slice(0, 120)}...`);
  console.log(`  checked  : ${finalState.checked.slice(0, 120)}...`);
  console.log(`  summary  : ${finalState.summary}`);
  console.log();

  console.log('='.repeat(60));
  console.log('  Graph execution complete.');
  console.log('  The following events were emitted:');
  console.log('    GRAPH_EXECUTION  — 1 event (full pipeline)');
  console.log('    NODE_EXECUTION   — 3 events (research, factCheck, summarise)');
  console.log('    LLM_CALL         — up to 3 events (one per node)');
  console.log('  Inspect events at:');
  console.log(`  GET ${BACKEND_URL}/events`);
  console.log('='.repeat(60));

  await shutdown();
}

main().catch(console.error);
