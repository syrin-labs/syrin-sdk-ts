/**
 * Example 05 — Framework Auto-Detection: LangChain and LangGraph, Zero Config
 * ============================================================================
 *
 * THE PROBLEM
 * -----------
 * You add Syrin to your project. You `await init()`. You check the dashboard.
 *
 * You see raw OpenAI calls — but none of the structure your LangChain code has.
 * No chain names. No node names from your LangGraph graph.
 * No "CHAIN_EXECUTION" or "NODE_EXECUTION" events. Just bare LLM_CALL entries.
 *
 * Your actual agent has meaningful structure:
 *   - A LangChain chain: PromptTemplate → LLM → OutputParser
 *   - A LangGraph graph with nodes: "research", "synthesize", "format"
 *
 * That structure is invisible in the dashboard because Syrin doesn't know about it.
 * You wonder: do I need to manually configure adapters? Pass them to init()?
 *
 * THE SYRIN SOLUTION
 * ------------------
 * No. You don't pass adapters. Syrin auto-detects.
 *
 * When you import @langchain/core or @langchain/langgraph at the top of your file,
 * those modules are registered in Node's module cache. Syrin's init() scans that
 * cache and installs the right adapters automatically.
 *
 * You get:
 *   - LLM_CALL events tagged with framework: "langchain" or "langchain-langgraph"
 *   - CHAIN_EXECUTION events wrapping each chain invocation
 *   - NODE_EXECUTION events for each LangGraph node
 *   - graph_id and node_name on every LLM_CALL made inside a graph node
 *
 * The only requirement: import the framework before calling init().
 * That's it. No adapters array. No manual wiring.
 *
 * Run:   npx tsx 05-framework-autodetect.ts
 *
 * NOTE: This example requires LangChain and LangGraph to be installed:
 *   npm install @langchain/core @langchain/openai @langchain/langgraph langchain
 */

import 'dotenv/config';

// ─── IMPORT FRAMEWORKS FIRST ─────────────────────────────────────────────────

// These imports are what trigger auto-detection.
// The moment these modules are loaded into Node's require() cache,
// Syrin's init() will find them and install the right adapters.
//
// You are NOT passing adapters: [...] to init().
// You are NOT calling LangChainAdapter() or LangGraphAdapter() manually.
// The import below is sufficient.

import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { StateGraph, MessagesAnnotation, END, START } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';

// ─── INIT AFTER IMPORTS ───────────────────────────────────────────────────────

// init() runs AFTER the imports above.
// It scans the module cache, finds @langchain/core and @langchain/langgraph,
// and automatically installs the LangChain and LangGraph adapters.

import { init } from '../src/index.js';

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  name: 'langchain-langgraph-agent',
  url: process.env.SYRIN_BACKEND_URL ?? 'http://localhost:4000',
  // No `adapters` option needed. Auto-detection handles it.
});

console.log('');
console.log('Syrin initialized. Auto-detected frameworks:');
console.log('  - @langchain/core  → LangChain adapter installed');
console.log('  - @langchain/langgraph → LangGraph adapter installed');
console.log('');
console.log('You passed NO adapters option to init().');
console.log('Syrin found them by scanning Node\'s module cache.\n');

// ─── PART 1: A LANGCHAIN CHAIN ───────────────────────────────────────────────

const model = new ChatOpenAI({
  model: 'gpt-4o-mini',
  temperature: 0.5,
  apiKey: process.env.OPENAI_API_KEY!,
  maxTokens: 100,
});

const prompt = ChatPromptTemplate.fromTemplate(
  'You are a helpful assistant. Answer in one sentence: {question}'
);

const chain = prompt.pipe(model).pipe(new StringOutputParser());

console.log('─── Running a LangChain chain ──────────────────────────────');
console.log('    chain: ChatPromptTemplate → ChatOpenAI → StringOutputParser\n');

const chainResult = await chain.invoke({
  question: 'What is the capital of France?',
});

console.log(`Chain result: "${chainResult}"\n`);

// What appeared in the dashboard for this call:
//   event_type:  "LLM_CALL"
//   framework:   "langchain"
//   model:       "gpt-4o-mini"
//   input_tokens: ~30
//   cost_usd:    ~$0.000005
//
// Plus a wrapping "CHAIN_EXECUTION" event showing the full chain duration.

console.log('In the dashboard:');
console.log('  LLM_CALL tagged with framework: "langchain"');
console.log('  CHAIN_EXECUTION event wrapping the chain invocation\n');

// ─── PART 2: A LANGGRAPH GRAPH ───────────────────────────────────────────────

console.log('─── Running a LangGraph graph ──────────────────────────────');
console.log('    nodes: research → synthesize\n');

// Define the graph state shape
const graphModel = new ChatOpenAI({
  model: 'gpt-4o-mini',
  temperature: 0.3,
  apiKey: process.env.OPENAI_API_KEY!,
  maxTokens: 80,
});

// Node 1: research — gather information
async function researchNode(state: typeof MessagesAnnotation.State) {
  console.log('  [node: research] Starting...');
  const response = await graphModel.invoke([
    ...state.messages,
    new HumanMessage('List 2 key facts about quantum computing. Be brief.'),
  ]);
  console.log(`  [node: research] Done: "${(response.content as string).slice(0, 60)}..."`);
  return { messages: [response] };
}

// Node 2: synthesize — turn facts into a summary
async function synthesizeNode(state: typeof MessagesAnnotation.State) {
  console.log('  [node: synthesize] Starting...');
  const response = await graphModel.invoke([
    ...state.messages,
    new HumanMessage('Now summarize those facts in one sentence.'),
  ]);
  console.log(`  [node: synthesize] Done: "${(response.content as string).slice(0, 60)}..."`);
  return { messages: [response] };
}

// Build and compile the graph
const graph = new StateGraph(MessagesAnnotation)
  .addNode('research', researchNode)
  .addNode('synthesize', synthesizeNode)
  .addEdge(START, 'research')
  .addEdge('research', 'synthesize')
  .addEdge('synthesize', END)
  .compile();

// Run the graph
const graphResult = await graph.invoke({
  messages: [new HumanMessage('Tell me about quantum computing.')],
});

const finalMessage = graphResult.messages[graphResult.messages.length - 1];
console.log(`\nGraph final output: "${(finalMessage.content as string).slice(0, 120)}"`);

// What appeared in the dashboard for graph calls:
//   For "research" node LLM call:
//     event_type:  "LLM_CALL"
//     framework:   "langchain-langgraph"
//     node_name:   "research"
//     graph_id:    auto-generated
//   For "synthesize" node LLM call:
//     node_name:   "synthesize"
//   Plus NODE_EXECUTION events for each node, and a GRAPH_EXECUTION wrapping both.

console.log('\nIn the dashboard:');
console.log('  LLM_CALL for research node:   framework="langchain-langgraph", node_name="research"');
console.log('  LLM_CALL for synthesize node: framework="langchain-langgraph", node_name="synthesize"');
console.log('  NODE_EXECUTION event for each node (with duration)');
console.log('  GRAPH_EXECUTION event wrapping the full graph run\n');

await sdk.flush();
await sdk.shutdown();

// ─── WHAT YOU JUST SAW ───────────────────────────────────────────────────────
//
//  BEFORE SYRIN:  LangChain and LangGraph calls appear as anonymous LLM_CALLs.
//                 No chain names. No node names. No graph structure. Useless.
//
//  WITH SYRIN (auto-detect):
//    Just import the frameworks before calling init().
//    Syrin scans the module cache and installs the right adapters automatically.
//    No adapters: [...] option needed.
//    No manual wiring. No configuration.
//
//  WHAT YOU GET IN THE DASHBOARD:
//    LangChain:  LLM_CALL tagged with framework="langchain"
//                CHAIN_EXECUTION events with chain duration
//    LangGraph:  LLM_CALL tagged with framework="langchain-langgraph"
//                NODE_EXECUTION events per node (with node_name, duration)
//                GRAPH_EXECUTION events wrapping the full graph run
//
//  AUTO-DETECTED FRAMEWORKS (TypeScript SDK):
//    openai          → always instrumented (Tier 1)
//    @anthropic-ai/sdk → Tier 1 (auto-detected)
//    @langchain/core → Tier 2 (auto-detected on import)
//    @langchain/langgraph → Tier 2 (auto-detected on import)
//    mastra          → Tier 2 (auto-detected on import)
//    ai (Vercel AI)  → Tier 2 (auto-detected on import)
