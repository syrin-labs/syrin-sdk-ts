/**
 * Example 1: Basic Chat with Syrin Instrumentation
 *
 * Run: SYRIN_API_KEY=test OPENAI_API_KEY=real npx tsx examples/01-basic-chat.ts
 * Or with mock backend: SYRIN_BACKEND_URL=http://localhost:4318 SYRIN_API_KEY=test npx tsx examples/01-basic-chat.ts
 *
 * What this example shows:
 *  - Zero-friction integration: just two lines to instrument everything
 *  - All subsequent openai.chat.completions.create() calls are auto-captured
 *  - Events are batched and sent to Syrin backend automatically
 */

import OpenAI from 'openai';
import { init, shutdown } from '../src/index.js';

async function main() {
  // --- Syrin initialization (the only two lines you need) ---
  await init({
    apiKey: process.env['SYRIN_API_KEY'] ?? 'syrin_demo_key',
    agentId: 'example-agent-basic-chat',
    backendUrl: process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000',
    debug: true,
    captureContent: true, // Captures full prompts/responses in telemetry events
  });

  // --- Your existing OpenAI code — completely unchanged ---
  const openai = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'] ?? 'sk-demo',
  });

  console.log('\n--- Making chat completion request ---');

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant.',
        },
        {
          role: 'user',
          content: 'Explain what observability means in the context of AI agents in one sentence.',
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
    });

    const reply = response.choices[0]?.message?.content ?? '';
    console.log('\nAssistant:', reply);
    console.log('\nUsage:', response.usage);
  } catch (err) {
    console.error('OpenAI call failed (expected if no real API key):', err);
  }

  console.log('\n--- Making a second call to show batching ---');

  try {
    const response2 = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'What is 2 + 2?' }],
      max_tokens: 20,
    });

    console.log('\nAnswer:', response2.choices[0]?.message?.content);
  } catch (err) {
    console.error('Second call failed:', err);
  }

  // Graceful shutdown: flushes remaining events
  console.log('\n--- Shutting down Syrin SDK ---');
  await shutdown();
  console.log('Done. Check your Syrin dashboard or mock backend for events.');
}

main().catch(console.error);
