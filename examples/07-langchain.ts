/**
 * Example 7: LangChain Adapter
 *
 * Demonstrates Syrin's LangChain.js instrumentation:
 *   - Build a chain: ChatPromptTemplate | ChatOpenAI | StringOutputParser
 *   - Method 1: adapter.callbackHandler() injected into chain.invoke() config
 *   - Method 2: adapter.wrap(chain) for zero-friction automatic instrumentation
 *   - Stream through a wrapped chain
 *   - CHAIN_EXECUTION events emitted for each invocation
 *
 * Requirements:
 *   npm install @langchain/core @langchain/openai
 *
 * Run with mock backend:
 *   OPENAI_BASE_URL=http://localhost:4318/v1 \
 *   OPENAI_API_KEY=sk-test \
 *   SYRIN_BACKEND_URL=http://localhost:4318 \
 *   SYRIN_API_KEY=syrin_test \
 *   npx tsx examples/07-langchain.ts
 */

// ---------------------------------------------------------------------------
// Check @langchain/core and @langchain/openai are installed
// ---------------------------------------------------------------------------

let ChatPromptTemplate: typeof import('@langchain/core/prompts').ChatPromptTemplate;
let StringOutputParser: typeof import('@langchain/core/output_parsers').StringOutputParser;

try {
  const prompts = await import('@langchain/core/prompts');
  ChatPromptTemplate = prompts.ChatPromptTemplate;
  const parsers = await import('@langchain/core/output_parsers');
  StringOutputParser = parsers.StringOutputParser;
} catch {
  console.error(
    '[example-07] @langchain/core is not installed.\n' +
    'Install it with:\n' +
    '  npm install @langchain/core @langchain/openai\n' +
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
    '[example-07] @langchain/openai is not installed.\n' +
    'Install it with:\n' +
    '  npm install @langchain/openai\n' +
    'Then re-run this example.'
  );
  process.exit(0);
}

import { init, shutdown, LangChainAdapter } from '../src/index.js';

const BACKEND_URL = process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000';
const OPENAI_BASE_URL = process.env['OPENAI_BASE_URL'];

// ---------------------------------------------------------------------------
// Initialize SDK with LangChainAdapter
// ---------------------------------------------------------------------------

const adapter = new LangChainAdapter();

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY'] ?? 'syrin_demo',
  backendUrl: BACKEND_URL,
  agentId: 'langchain-demo-agent',
  debug: true,
  captureContent: true,
  adapters: [adapter],
});

console.log('='.repeat(60));
console.log('  SYRIN LANGCHAIN ADAPTER DEMO (TypeScript)');
console.log('='.repeat(60));
console.log(`  session_id : ${sdk.sessionId}`);
console.log(`  backend    : ${BACKEND_URL}`);
console.log();

// ---------------------------------------------------------------------------
// Build the chain: ChatPromptTemplate | ChatOpenAI | StringOutputParser
// ---------------------------------------------------------------------------

const modelOptions: ConstructorParameters<typeof ChatOpenAI>[0] = {
  model: 'gpt-4o-mini',
  temperature: 0.5,
  maxTokens: 256,
  apiKey: process.env['OPENAI_API_KEY'] ?? 'sk-test',
};

if (OPENAI_BASE_URL) {
  modelOptions.configuration = { baseURL: OPENAI_BASE_URL };
}

const llm = new ChatOpenAI(modelOptions);

const prompt = ChatPromptTemplate.fromMessages([
  ['system', 'You are a helpful assistant that answers questions concisely.'],
  ['human', '{question}'],
]);

const parser = new StringOutputParser();

// Pipe the components together: prompt | llm | parser
const chain = prompt.pipe(llm).pipe(parser);

// ---------------------------------------------------------------------------
// Demo 1: Method 1 — callbackHandler() injected manually
// ---------------------------------------------------------------------------

async function demoCallbackHandler(): Promise<void> {
  console.log('--- Demo 1: Method 1 — callbackHandler() ---');

  const handler = adapter.callbackHandler('qa-chain-manual');

  let result: string;
  try {
    result = await chain.invoke(
      { question: 'What is the difference between TypeScript and JavaScript?' },
      { callbacks: [handler] }
    ) as string;
  } catch (err) {
    console.warn(`  [skipped] Chain invocation failed (expected in mock mode): ${String(err)}`);
    return;
  }

  console.log(`  answer: ${result}`);
  console.log('  CHAIN_EXECUTION event emitted via callback handler');
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 2: Method 2 — adapter.wrap(chain) for zero-friction
// ---------------------------------------------------------------------------

async function demoWrappedChain(): Promise<void> {
  console.log('--- Demo 2: Method 2 — adapter.wrap(chain) ---');

  // wrap() returns a Proxy: callbacks and FrameworkContext injected automatically
  const wrappedChain = adapter.wrap(chain, { chainName: 'qa-chain-wrapped' });

  let result: unknown;
  try {
    result = await wrappedChain.invoke(
      { question: 'Name three advantages of async/await over raw Promises.' }
    );
  } catch (err) {
    console.warn(`  [skipped] Wrapped chain invocation failed (expected in mock mode): ${String(err)}`);
    return;
  }

  console.log(`  answer: ${String(result)}`);
  console.log('  CHAIN_EXECUTION event emitted automatically by wrapped chain');
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 3: Stream through the wrapped chain
// ---------------------------------------------------------------------------

async function demoStreamWrapped(): Promise<void> {
  console.log('--- Demo 3: Streaming through wrapped chain ---');

  const streamChain = adapter.wrap(chain, { chainName: 'qa-chain-stream' });

  // Attempt streaming — LangChain chains expose .stream() separately; we invoke
  // via the original chain's stream method and wrap context manually for this demo.
  const handler = adapter.callbackHandler('qa-chain-stream');

  let streamResult: AsyncIterable<string> | null = null;
  try {
    // LangChain LCEL chains expose .stream() for streaming output
    streamResult = await (chain as unknown as {
      stream(input: unknown, config?: unknown): Promise<AsyncIterable<string>>;
    }).stream(
      { question: 'List three TypeScript features briefly.' },
      { callbacks: [handler] }
    );
  } catch (err) {
    // If the chain does not support streaming in this context, fall back to invoke
    console.warn(`  [streaming not available]: ${String(err)}`);
    console.warn('  Falling back to invoke for this demo.');
    try {
      const fallback = await streamChain.invoke({ question: 'List three TypeScript features briefly.' });
      console.log(`  answer (invoke fallback): ${String(fallback)}`);
    } catch (err2) {
      console.warn(`  [skipped] Both stream and invoke failed (expected in mock mode): ${String(err2)}`);
    }
    console.log();
    return;
  }

  process.stdout.write('  answer: ');
  for await (const chunk of streamResult) {
    process.stdout.write(chunk);
  }
  process.stdout.write('\n');
  console.log('  CHAIN_EXECUTION event emitted via callback handler on stream completion');
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await demoCallbackHandler();
  await demoWrappedChain();
  await demoStreamWrapped();

  console.log('='.repeat(60));
  console.log('  Demo complete.');
  console.log('  Events emitted per invocation:');
  console.log('    CHAIN_EXECUTION  — 1 per invoke/stream (LangChain adapter)');
  console.log('    LLM_CALL         — 1 per LLM call (OpenAI adapter, Tier 1)');
  console.log('  Inspect events at:');
  console.log(`  GET ${BACKEND_URL}/events`);
  console.log('='.repeat(60));

  await shutdown();
}

main().catch(console.error);
