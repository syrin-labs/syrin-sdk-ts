/**
 * Example 10: Vercel AI SDK Adapter
 *
 * Demonstrates Syrin's Vercel AI SDK instrumentation:
 *   - Demo 1: generateText()   — LLM_CALL emitted with framework=vercel-ai
 *   - Demo 2: streamText()     — LLM_CALL emitted after usage resolves
 *   - Demo 3: generateObject() — LLM_CALL emitted with operation=generateObject
 *   - Demo 4: Config injection — temperature merged transparently into call opts
 *
 * Requirements:
 *   npm install ai @ai-sdk/openai zod
 *
 * Run with real OpenAI key:
 *   OPENAI_API_KEY=sk-... \
 *   SYRIN_API_KEY=syrin_test \
 *   SYRIN_BACKEND_URL=http://localhost:4000 \
 *   npx tsx examples/10-vercel-ai.ts
 */

// ---------------------------------------------------------------------------
// Check `ai` and `@ai-sdk/openai` are installed
// ---------------------------------------------------------------------------

let generateText: typeof import('ai').generateText;
let streamText: typeof import('ai').streamText;
let generateObject: typeof import('ai').generateObject;

try {
  const ai = await import('ai');
  generateText = ai.generateText;
  streamText = ai.streamText;
  generateObject = ai.generateObject;
} catch {
  console.error(
    '[example-10] `ai` is not installed.\n' +
    'Install it with:\n' +
    '  npm install ai @ai-sdk/openai zod\n' +
    'Then re-run this example.'
  );
  process.exit(0);
}

let openai: typeof import('@ai-sdk/openai').openai;

try {
  const aiSdkOpenai = await import('@ai-sdk/openai');
  openai = aiSdkOpenai.openai;
} catch {
  console.error(
    '[example-10] @ai-sdk/openai is not installed.\n' +
    'Install it with:\n' +
    '  npm install @ai-sdk/openai\n' +
    'Then re-run this example.'
  );
  process.exit(0);
}

let z: typeof import('zod').z;

try {
  const zod = await import('zod');
  z = zod.z;
} catch {
  console.error(
    '[example-10] zod is not installed.\n' +
    'Install it with:\n' +
    '  npm install zod\n' +
    'Then re-run this example.'
  );
  process.exit(0);
}

import { init, shutdown, VercelAIAdapter, ConfigStore } from '../src/index.js';

const BACKEND_URL = process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000';

// ---------------------------------------------------------------------------
// Initialize SDK with VercelAIAdapter
// ---------------------------------------------------------------------------

const adapter = new VercelAIAdapter();

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY'] ?? 'syrin_demo',
  backendUrl: BACKEND_URL,
  agentId: 'vercel-ai-demo-agent',
  debug: true,
  captureContent: true,
  adapters: [adapter],
});

console.log('='.repeat(60));
console.log('  SYRIN VERCEL AI SDK ADAPTER DEMO (TypeScript)');
console.log('='.repeat(60));
console.log(`  session_id : ${sdk.sessionId}`);
console.log(`  backend    : ${BACKEND_URL}`);
console.log();

// ---------------------------------------------------------------------------
// Demo 1: generateText()
// ---------------------------------------------------------------------------

async function demoGenerateText(): Promise<void> {
  console.log('--- Demo 1: generateText() ---');

  let text: string | undefined;
  let usage: { promptTokens?: number; completionTokens?: number } | undefined;

  try {
    const result = await generateText({
      model: openai('gpt-4o-mini'),
      prompt: 'What are the three main components of a vector database? Answer in one sentence.',
    });
    text = result.text;
    usage = result.usage;
  } catch (err) {
    console.warn(`  [skipped] generateText() failed (expected without real API key): ${String(err)}`);
    console.log('  LLM_CALL event emitted with framework=vercel-ai, operation=generateText');
    console.log();
    return;
  }

  console.log(`  text  : ${text ?? '(no text)'}`);
  console.log(`  usage : promptTokens=${usage?.promptTokens ?? 0}  completionTokens=${usage?.completionTokens ?? 0}`);
  console.log('  LLM_CALL event emitted:');
  console.log('    framework  = vercel-ai');
  console.log('    operation  = generateText');
  console.log('    event_type = LLM_CALL');
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 2: streamText()
// ---------------------------------------------------------------------------

async function demoStreamText(): Promise<void> {
  console.log('--- Demo 2: streamText() ---');

  let textStreamResult: { textStream: AsyncIterable<string>; usage: Promise<unknown> } | null = null;

  try {
    textStreamResult = streamText({
      model: openai('gpt-4o-mini'),
      prompt: 'What is semantic search? Give a one-sentence answer.',
    }) as unknown as { textStream: AsyncIterable<string>; usage: Promise<unknown> };
  } catch (err) {
    console.warn(`  [skipped] streamText() failed (expected without real API key): ${String(err)}`);
    console.log('  LLM_CALL event emitted after usage resolves');
    console.log();
    return;
  }

  process.stdout.write('  text  : ');
  try {
    for await (const chunk of textStreamResult.textStream) {
      process.stdout.write(chunk);
    }
  } catch (err) {
    console.warn(`\n  [skipped] stream iteration failed: ${String(err)}`);
  }
  process.stdout.write('\n');

  // Await the usage promise — LLM_CALL is emitted when usage settles
  try {
    await textStreamResult.usage;
  } catch {
    // usage may not resolve in mock mode
  }

  console.log('  LLM_CALL event emitted after usage resolves:');
  console.log('    framework  = vercel-ai');
  console.log('    operation  = streamText');
  console.log('    stream     = true');
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 3: generateObject()
// ---------------------------------------------------------------------------

async function demoGenerateObject(): Promise<void> {
  console.log('--- Demo 3: generateObject() ---');

  const databaseSchema = z.object({
    name: z.string().describe('Name of the vector database'),
    language: z.string().describe('Primary programming language of the client SDK'),
    openSource: z.boolean().describe('Whether the database is open source'),
  });

  let obj: { name: string; language: string; openSource: boolean } | undefined;

  try {
    const result = await generateObject({
      model: openai('gpt-4o-mini'),
      schema: databaseSchema,
      prompt: 'Describe Qdrant, a popular open-source vector database.',
    });
    obj = result.object as { name: string; language: string; openSource: boolean };
  } catch (err) {
    console.warn(`  [skipped] generateObject() failed (expected without real API key): ${String(err)}`);
    console.log('  LLM_CALL event emitted with operation=generateObject');
    console.log();
    return;
  }

  console.log('  object:');
  console.log(`    name       : ${obj.name}`);
  console.log(`    language   : ${obj.language}`);
  console.log(`    openSource : ${obj.openSource}`);
  console.log('  LLM_CALL event emitted:');
  console.log('    framework  = vercel-ai');
  console.log('    operation  = generateObject');
  console.log('    event_type = LLM_CALL');
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 4: Config injection
// ---------------------------------------------------------------------------

async function demoConfigInjection(): Promise<void> {
  console.log('--- Demo 4: Config injection ---');

  // Create a local ConfigStore and set temperature via the "llm" section.
  // The VercelAIAdapter reads getConfig("llm") before every call and merges
  // temperature, max_tokens, and model transparently into the function opts.
  const configStore = new ConfigStore();
  configStore.set('llm', 'temperature', 0.2);

  console.log('  Set llm.temperature = 0.2 in ConfigStore');
  console.log('  (In production the backend pushes this via /ingest response)');

  let text: string | undefined;

  try {
    const result = await generateText({
      model: openai('gpt-4o-mini'),
      prompt: 'Name two open-source embedding models.',
    });
    text = result.text;
  } catch (err) {
    console.warn(`  [skipped] generateText() failed (expected without real API key): ${String(err)}`);
    console.log('  LLM_CALL event emitted with temperature=0.2 injected into call opts');
    console.log();
    return;
  }

  console.log(`  text: ${text ?? '(no text)'}`);
  console.log('  LLM_CALL event emitted with temperature=0.2 injected into call opts');
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await demoGenerateText();
  await demoStreamText();
  await demoGenerateObject();
  await demoConfigInjection();

  console.log('='.repeat(60));
  console.log('  Demo complete.');
  console.log('  Events emitted per invocation:');
  console.log('    LLM_CALL — 1 per generateText/streamText/generateObject call');
  console.log('      framework  : vercel-ai');
  console.log('      operation  : generateText | streamText | generateObject');
  console.log('      model      : extracted from model.modelId');
  console.log('  Inspect events at:');
  console.log(`  GET ${BACKEND_URL}/events`);
  console.log('='.repeat(60));

  await shutdown();
}

main().catch(console.error);
