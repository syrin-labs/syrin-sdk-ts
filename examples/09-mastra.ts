/**
 * Example 9: Mastra Adapter
 *
 * Demonstrates Syrin's Mastra instrumentation (requires @mastra/core v1.x):
 *   - Demo 1: Basic agent.generate() — LLM_CALL emitted with framework=mastra
 *   - Demo 2: Streaming agent.stream() — LLM_CALL emitted after stream completes
 *   - Demo 3: Remote config injection — push temperature via backend, applied transparently
 *   - Demo 4: Multiple agents — separate agent_name per LLM_CALL event
 *
 * Requirements:
 *   npm install @mastra/core @ai-sdk/openai
 *
 * Run:
 *   OPENAI_API_KEY=sk-... \
 *   SYRIN_API_KEY=syrin_... \
 *   SYRIN_BACKEND_URL=http://localhost:4000 \
 *   npx tsx examples/09-mastra.ts
 */

// ---------------------------------------------------------------------------
// Check @mastra/core and @ai-sdk/openai are installed
// ---------------------------------------------------------------------------

let Agent: (new (opts: {
  name: string;
  instructions: string;
  model: unknown;
}) => {
  name: string;
  model: unknown;
  generate(messages: unknown[], opts?: unknown): Promise<{ text?: string; usage?: { promptTokens?: number; completionTokens?: number } }>;
  stream(messages: unknown[], opts?: unknown): AsyncIterable<{ text?: string }>;
});

let openai: (modelId: string) => unknown;

try {
  const mod = await import('@mastra/core/agent');
  Agent = mod.Agent as typeof Agent;
} catch {
  console.error('[example-09] @mastra/core is not installed. Run: npm install @mastra/core @ai-sdk/openai');
  process.exit(0);
}

try {
  const mod = await import('@ai-sdk/openai');
  openai = mod.openai as typeof openai;
} catch {
  console.error('[example-09] @ai-sdk/openai is not installed. Run: npm install @ai-sdk/openai');
  process.exit(0);
}

import { init, shutdown, MastraAdapter } from '../src/index.js';

const BACKEND_URL = process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000';
const SYRIN_API_KEY = process.env['SYRIN_API_KEY'] ?? 'syrin_demo';
const MODEL = process.env['OPENAI_MODEL_NAME'] ?? 'gpt-4o-mini';

// ---------------------------------------------------------------------------
// Initialize SDK with MastraAdapter
// ---------------------------------------------------------------------------

const adapter = new MastraAdapter();

const sdk = await init({
  apiKey: SYRIN_API_KEY,
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
console.log(`  model      : ${MODEL}`);
console.log();

// ---------------------------------------------------------------------------
// Shared model
// ---------------------------------------------------------------------------

const model = openai(MODEL);

// ---------------------------------------------------------------------------
// Demo 1: Basic agent.generate()
// ---------------------------------------------------------------------------

async function demoGenerate(): Promise<void> {
  console.log('--- Demo 1: Basic agent.generate() ---');

  const agent = new Agent({
    name: 'demo-agent',
    model,
    instructions: 'You are a concise assistant. Answer in 2 sentences max.',
  });

  try {
    const result = await agent.generate([
      { role: 'user', content: 'Explain vector embeddings in 2 sentences.' },
    ]);
    console.log(`  answer: ${result.text ?? '(no text)'}`);
    if (result.usage) {
      console.log(`  tokens: ${(result.usage as Record<string, number>)['inputTokens'] ?? (result.usage as Record<string, number>)['promptTokens'] ?? 0} → ${(result.usage as Record<string, number>)['outputTokens'] ?? (result.usage as Record<string, number>)['completionTokens'] ?? 0}`);
    }
  } catch (err) {
    console.warn(`  [failed] ${String(err).split('\n')[0]}`);
  }

  console.log('  LLM_CALL emitted: framework=mastra, agent_name=demo-agent');
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 2: Streaming agent.stream()
// ---------------------------------------------------------------------------

async function demoStream(): Promise<void> {
  console.log('--- Demo 2: Streaming agent.stream() ---');

  const agent = new Agent({
    name: 'stream-agent',
    model,
    instructions: 'You are a concise assistant.',
  });

  process.stdout.write('  answer: ');
  try {
    // Mastra v1.x: stream() returns Promise<{ textStream: AsyncIterable<string>, ... }>
    const result = await agent.stream([
      { role: 'user', content: 'What is semantic search? Answer in one sentence.' },
    ]) as { textStream: AsyncIterable<string> };

    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
    }
    process.stdout.write('\n');
  } catch (err) {
    process.stdout.write('\n');
    console.warn(`  [failed] ${String(err).split('\n')[0]}`);
  }

  console.log('  LLM_CALL emitted after stream completes: framework=mastra, stream=true');
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 3: Remote config injection
// ---------------------------------------------------------------------------

async function demoConfigInjection(): Promise<void> {
  console.log('--- Demo 3: Remote config injection ---');
  console.log('  Pushing llm.temperature=0.1 to backend...');

  const agent = new Agent({
    name: 'config-agent',
    model,
    instructions: 'You are a concise assistant.',
  });

  // Push config via the backend API (same as what the dashboard does)
  try {
    await fetch(`${BACKEND_URL}/agents/mastra-demo-agent/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SYRIN_API_KEY}`,
      },
      body: JSON.stringify({ overrides: { 'llm.temperature': 0.1 } }),
    });
    console.log('  Config pushed. Waiting 2s for SDK to pick it up...');
    await new Promise(r => setTimeout(r, 2000));
  } catch (err) {
    console.warn(`  [push failed] ${String(err).split('\n')[0]}`);
  }

  try {
    const result = await agent.generate([
      { role: 'user', content: 'Name three vector databases in one sentence.' },
    ]);
    console.log(`  answer: ${result.text ?? '(no text)'}`);
  } catch (err) {
    console.warn(`  [failed] ${String(err).split('\n')[0]}`);
  }

  console.log('  LLM_CALL emitted with temperature=0.1 merged into opts transparently');

  // Clear config
  await fetch(`${BACKEND_URL}/agents/mastra-demo-agent/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SYRIN_API_KEY}` },
    body: JSON.stringify({ overrides: { 'llm.temperature': null } }),
  }).catch(() => {});
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
    instructions: 'You explain technical concepts clearly in 2 sentences.',
  });

  const summariser = new Agent({
    name: 'summariser-agent',
    model,
    instructions: 'You summarise text into a single sentence.',
  });

  try {
    const [r1, r2] = await Promise.all([
      explainer.generate([{ role: 'user', content: 'What is HNSW indexing?' }]),
      summariser.generate([{ role: 'user', content: 'Summarise: HNSW is a graph-based algorithm for approximate nearest neighbour search that builds hierarchical layers of proximity graphs.' }]),
    ]);
    console.log(`  explainer : ${r1.text ?? '(no text)'}`);
    console.log(`  summariser: ${r2.text ?? '(no text)'}`);
  } catch (err) {
    console.warn(`  [failed] ${String(err).split('\n')[0]}`);
  }

  console.log('  Two LLM_CALL events emitted:');
  console.log('    { agent_name: "explainer-agent",  framework: "mastra" }');
  console.log('    { agent_name: "summariser-agent", framework: "mastra" }');
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

  // Allow emitter to flush
  await new Promise(r => setTimeout(r, 2000));

  console.log('='.repeat(60));
  console.log('  Demo complete.');
  console.log('  Events emitted per agent call:');
  console.log('    LLM_CALL  — framework=mastra, agent_name, model, tokens');
  console.log(`  Inspect: GET ${BACKEND_URL}/agents/mastra-demo-agent/events`);
  console.log('='.repeat(60));

  await shutdown();
}

main().catch(console.error);
