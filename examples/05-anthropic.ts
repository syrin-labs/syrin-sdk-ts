/**
 * Example 5: Anthropic Adapter
 *
 * Demonstrates Syrin's automatic Anthropic instrumentation:
 *   - AnthropicAdapter is auto-installed by init() when @anthropic-ai/sdk is present
 *   - Sync message with system prompt
 *   - Tool use (tool_use block in response)
 *   - Streaming via client.messages.stream()
 *   - All calls emit LLM_CALL events to the Syrin backend
 *
 * Requirements:
 *   npm install @anthropic-ai/sdk
 *
 * Run against mock backend (uses ANTHROPIC_API_KEY env var or custom baseURL):
 *   OPENAI_BASE_URL=http://localhost:4318/v1 \
 *   OPENAI_API_KEY=sk-test \
 *   SYRIN_BACKEND_URL=http://localhost:4318 \
 *   SYRIN_API_KEY=syrin_test \
 *   ANTHROPIC_API_KEY=sk-ant-test \
 *   npx tsx examples/05-anthropic.ts
 *
 * With real Anthropic:
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   SYRIN_API_KEY=syrin_... \
 *   npx tsx examples/05-anthropic.ts
 */

// ---------------------------------------------------------------------------
// Check @anthropic-ai/sdk is installed before proceeding
// ---------------------------------------------------------------------------

let Anthropic: typeof import('@anthropic-ai/sdk').default;
try {
  const mod = await import('@anthropic-ai/sdk');
  Anthropic = mod.default;
} catch {
  console.error(
    '[example-05] @anthropic-ai/sdk is not installed.\n' +
    'Install it with:\n' +
    '  npm install @anthropic-ai/sdk\n' +
    'Then re-run this example.'
  );
  process.exit(0);
}

import { init, shutdown } from '../src/index.js';

const BACKEND_URL = process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000';
const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY'] ?? 'sk-ant-test';

// Detect if we have a real key or should point at local mock
const USE_MOCK_BACKEND = !ANTHROPIC_API_KEY.startsWith('sk-ant-api');

// ---------------------------------------------------------------------------
// Initialize SDK — AnthropicAdapter is auto-installed
// ---------------------------------------------------------------------------

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY'] ?? 'syrin_demo',
  backendUrl: BACKEND_URL,
  agentId: 'anthropic-demo-agent',
  debug: true,
  captureContent: true,
});

console.log('='.repeat(60));
console.log('  SYRIN ANTHROPIC ADAPTER DEMO (TypeScript)');
console.log('='.repeat(60));
console.log(`  session_id : ${sdk.sessionId}`);
console.log(`  backend    : ${BACKEND_URL}`);
if (USE_MOCK_BACKEND) {
  console.log('  mode       : mock (set a real ANTHROPIC_API_KEY to use live API)');
}
console.log();

// ---------------------------------------------------------------------------
// Build the Anthropic client
// Redirect to mock server if we do not have a real API key
// ---------------------------------------------------------------------------

const clientOptions: ConstructorParameters<typeof Anthropic>[0] = {
  apiKey: ANTHROPIC_API_KEY,
};

if (USE_MOCK_BACKEND) {
  // Point the client at the mock backend's OpenAI-compatible endpoint.
  // The AnthropicAdapter patches messages.create so telemetry is still captured.
  clientOptions.baseURL = `${BACKEND_URL}/v1`;
}

const client = new Anthropic(clientOptions);

// ---------------------------------------------------------------------------
// Demo 1: Sync message with system prompt
// ---------------------------------------------------------------------------

async function demoSyncMessage(): Promise<void> {
  console.log('--- Demo 1: Sync message with system prompt ---');

  let response: import('@anthropic-ai/sdk').Message;
  try {
    response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 256,
      system: 'You are a concise assistant. Reply in one sentence.',
      messages: [
        { role: 'user', content: 'What is the capital of France?' },
      ],
    });
  } catch (err) {
    console.warn(`  [skipped] API call failed (expected in mock mode): ${String(err)}`);
    return;
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = textBlock && 'text' in textBlock ? textBlock.text : '(no text block)';

  console.log(`  model       : ${response.model}`);
  console.log(`  stop_reason : ${response.stop_reason}`);
  console.log(`  input_tokens: ${response.usage.input_tokens}`);
  console.log(`  output_tokens: ${response.usage.output_tokens}`);
  console.log(`  response    : ${text}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 2: Tool use
// ---------------------------------------------------------------------------

async function demoToolUse(): Promise<void> {
  console.log('--- Demo 2: Tool use ---');

  const tools: import('@anthropic-ai/sdk').Tool[] = [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      input_schema: {
        type: 'object' as const,
        properties: {
          city: { type: 'string', description: 'City name' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        },
        required: ['city'],
      },
    },
  ];

  let response: import('@anthropic-ai/sdk').Message;
  try {
    response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 256,
      tools,
      messages: [
        { role: 'user', content: 'What is the weather in London right now?' },
      ],
    });
  } catch (err) {
    console.warn(`  [skipped] API call failed (expected in mock mode): ${String(err)}`);
    return;
  }

  console.log(`  model       : ${response.model}`);
  console.log(`  stop_reason : ${response.stop_reason}`);
  console.log(`  input_tokens: ${response.usage.input_tokens}`);
  console.log(`  output_tokens: ${response.usage.output_tokens}`);

  for (const block of response.content) {
    if (block.type === 'tool_use') {
      console.log(`  tool_use    : ${block.name}(${JSON.stringify(block.input)})`);
    } else if (block.type === 'text' && 'text' in block) {
      console.log(`  text        : ${block.text}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Demo 3: Streaming
// ---------------------------------------------------------------------------

async function demoStreaming(): Promise<void> {
  console.log('--- Demo 3: Streaming ---');

  let stream: ReturnType<typeof client.messages.stream>;
  try {
    stream = client.messages.stream({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 128,
      messages: [
        {
          role: 'user',
          content: 'Count from 1 to 5, one number per line.',
        },
      ],
    });
  } catch (err) {
    console.warn(`  [skipped] Stream creation failed (expected in mock mode): ${String(err)}`);
    return;
  }

  process.stdout.write('  response    : ');
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = '';

  try {
    for await (const chunk of stream) {
      const type = (chunk as Record<string, unknown>)['type'] as string | undefined;

      if (type === 'message_start') {
        const msg = (chunk as Record<string, unknown>)['message'] as {
          usage?: { input_tokens?: number };
        } | undefined;
        if (msg?.usage?.input_tokens != null) {
          inputTokens = msg.usage.input_tokens;
        }
      } else if (type === 'content_block_delta') {
        const delta = (chunk as Record<string, unknown>)['delta'] as {
          type?: string;
          text?: string;
        } | undefined;
        if (delta?.type === 'text_delta' && delta.text) {
          process.stdout.write(delta.text);
        }
      } else if (type === 'message_delta') {
        const delta = (chunk as Record<string, unknown>)['delta'] as {
          stop_reason?: string;
        } | undefined;
        const usage = (chunk as Record<string, unknown>)['usage'] as {
          output_tokens?: number;
        } | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        if (usage?.output_tokens != null) outputTokens = usage.output_tokens;
      }
    }
  } catch (err) {
    console.warn(`\n  [skipped] Stream iteration failed (expected in mock mode): ${String(err)}`);
    return;
  }

  process.stdout.write('\n');
  console.log(`  stop_reason : ${stopReason}`);
  console.log(`  input_tokens: ${inputTokens}`);
  console.log(`  output_tokens: ${outputTokens}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await demoSyncMessage();
  await demoToolUse();
  await demoStreaming();

  console.log('='.repeat(60));
  console.log('  Demo complete.');
  console.log('  All Anthropic calls were intercepted by AnthropicAdapter.');
  console.log('  Events are visible in the mock backend at:');
  console.log(`  GET ${BACKEND_URL}/events`);
  console.log('='.repeat(60));

  await shutdown();
}

main().catch(console.error);
