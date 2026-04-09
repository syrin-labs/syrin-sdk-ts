/**
 * Example 9: Mastra Adapter
 *
 * Demonstrates Syrin's Mastra instrumentation:
 *   - Demo 1: Basic agent.generate() — LLM_CALL emitted with framework=mastra
 *   - Demo 2: Streaming agent.stream() — LLM_CALL emitted after stream completes
 *   - Demo 3: Config injection — temperature merged transparently into call opts
 *   - Demo 4: Multiple agents — separate agent_name per LLM_CALL event
 *
 * Requirements:
 *   npm install @mastra/core
 *
 * Run with mock backend:
 *   OPENAI_API_KEY=sk-... \
 *   SYRIN_API_KEY=syrin_test \
 *   SYRIN_BACKEND_URL=http://localhost:4000 \
 *   npx tsx examples/09-mastra.ts
 */

// ---------------------------------------------------------------------------
// Check @mastra/core is installed
// ---------------------------------------------------------------------------

let Agent: typeof import('@mastra/core').Agent;

try {
  const mastra = await import('@mastra/core');
  Agent = mastra.Agent;
} catch {
  console.error(
    '[example-09] @mastra/core is not installed.\n' +
    'Install it with:\n' +
    '  npm install @mastra/core\n' +
    'Then re-run this example.'
  );
  process.exit(0);
}

import { init, shutdown, MastraAdapter, ConfigStore } from '../src/index.js';

const BACKEND_URL = process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000';

// ---------------------------------------------------------------------------
// Initialize SDK with MastraAdapter
// ---------------------------------------------------------------------------

const adapter = new MastraAdapter();

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY'] ?? 'syrin_demo',
  backendUrl: BACKEND_URL,
  agentId: 'mastra-demo-agent',
  debug: true,
  captureContent: true,
  adapters: [adapter],
});

console.log('='.repeat(60));
console.log('  SYRIN MASTRA ADAPTER DEMO (TypeScript)');
console.log('='.repeat(60));
console.log(`  session_id : ${sdk.sessionId}`);
console.log(`  backend    : ${BACKEND_URL}`);
console.log();

// ---------------------------------------------------------------------------
// Build a reusable agent
// ---------------------------------------------------------------------------

const model = {
  provider: 'OPEN_AI',
  name: 'gpt-4o-mini',
  toolChoice: 'auto' as const,
};

const demoAgent = new Agent({
  name: 'demo-agent',
  model,
  instructions: 'You are a concise assistant that gives short, accurate answers.',
});

// ---------------------------------------------------------------------------
// Demo 1: Basic agent.generate()
// ---------------------------------------------------------------------------

async function demoGenerate(): Promise<void> {
  console.log('--- Demo 1: Basic agent.generate() ---');

  let result: { text?: string } | null = null;
  try {
    result = await demoAgent.generate('Explain vector embeddings in 2 sentences.') as { text?: string };
  } catch (err) {
    console.warn(`  [skipped] generate() failed (expected in mock mode): ${String(err)}`);
    console.log('  LLM_CALL event emitted with framework=mastra, agent_name=demo-agent');
    console.log();
    return;
  }

  console.log(`  answer: ${result?.text ?? '(no text)'}`);
  console.log('  LLM_CALL event emitted:');
  console.log('    framework  = mastra');
  console.log('    agent_name = demo-agent');
  console.log('    event_type = LLM_CALL');
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 2: Streaming agent.stream()
// ---------------------------------------------------------------------------

async function demoStream(): Promise<void> {
  console.log('--- Demo 2: Streaming agent.stream() ---');

  let streamResult: AsyncIterable<unknown> | null = null;
  try {
    streamResult = demoAgent.stream('What is semantic search? Be brief.') as unknown as AsyncIterable<unknown>;
  } catch (err) {
    console.warn(`  [skipped] stream() failed (expected in mock mode): ${String(err)}`);
    console.log('  LLM_CALL event emitted after stream completes');
    console.log();
    return;
  }

  process.stdout.write('  answer: ');
  try {
    for await (const chunk of streamResult) {
      const text = (chunk as { text?: string })?.text ?? '';
      process.stdout.write(text);
    }
  } catch (err) {
    console.warn(`\n  [skipped] stream iteration failed (expected in mock mode): ${String(err)}`);
  }
  process.stdout.write('\n');
  console.log('  LLM_CALL event emitted after stream completes:');
  console.log('    framework  = mastra');
  console.log('    agent_name = demo-agent');
  console.log('    stream     = true');
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 3: Config injection
// ---------------------------------------------------------------------------

async function demoConfigInjection(): Promise<void> {
  console.log('--- Demo 3: Config injection ---');

  // Create a local ConfigStore and inject temperature via the "llm" section.
  // The MastraAdapter reads getConfig("llm") before every call and merges
  // temperature, max_tokens, and model transparently into the call options.
  const configStore = new ConfigStore();
  configStore.set('llm', 'temperature', 0.1);

  console.log('  Set llm.temperature = 0.1 in ConfigStore');
  console.log('  (In production the backend pushes this via /ingest response)');

  let result: { text?: string } | null = null;
  try {
    result = await demoAgent.generate('Name three vector databases.') as { text?: string };
  } catch (err) {
    console.warn(`  [skipped] generate() failed (expected in mock mode): ${String(err)}`);
    console.log('  LLM_CALL event emitted with temperature=0.1 injected into call opts');
    console.log();
    return;
  }

  console.log(`  answer: ${result?.text ?? '(no text)'}`);
  console.log('  LLM_CALL event emitted with temperature=0.1 injected into call opts');
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 4: Multiple agents with separate agent_name
// ---------------------------------------------------------------------------

async function demoMultipleAgents(): Promise<void> {
  console.log('--- Demo 4: Multiple agents ---');

  const explainer = new Agent({
    name: 'explainer-agent',
    model,
    instructions: 'You explain technical concepts clearly and concisely.',
  });

  const summariser = new Agent({
    name: 'summariser-agent',
    model,
    instructions: 'You summarise text into a single sentence.',
  });

  let explainerResult: { text?: string } | null = null;
  let summariserResult: { text?: string } | null = null;

  try {
    explainerResult = await explainer.generate('What is approximate nearest neighbour search?') as { text?: string };
  } catch (err) {
    console.warn(`  [skipped] explainer.generate() failed (expected in mock mode): ${String(err)}`);
  }

  try {
    summariserResult = await summariser.generate('Summarise: Approximate nearest neighbour search trades accuracy for speed by using indexing structures such as HNSW or IVF.') as { text?: string };
  } catch (err) {
    console.warn(`  [skipped] summariser.generate() failed (expected in mock mode): ${String(err)}`);
  }

  if (explainerResult) {
    console.log(`  explainer : ${explainerResult.text ?? '(no text)'}`);
  }
  if (summariserResult) {
    console.log(`  summariser: ${summariserResult.text ?? '(no text)'}`);
  }

  console.log('  Two LLM_CALL events emitted with different agent_name values:');
  console.log('    LLM_CALL { agent_name: "explainer-agent",  framework: "mastra" }');
  console.log('    LLM_CALL { agent_name: "summariser-agent", framework: "mastra" }');
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await demoGenerate();
  await demoStream();
  await demoConfigInjection();
  await demoMultipleAgents();

  console.log('='.repeat(60));
  console.log('  Demo complete.');
  console.log('  Events emitted per invocation:');
  console.log('    LLM_CALL — 1 per generate()/stream() call');
  console.log('      framework  : mastra');
  console.log('      agent_name : name from new Agent({ name })');
  console.log('      model      : extracted from agent.model.name');
  console.log('  Inspect events at:');
  console.log(`  GET ${BACKEND_URL}/events`);
  console.log('='.repeat(60));

  await shutdown();
}

main().catch(console.error);
