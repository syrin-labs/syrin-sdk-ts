/**
 * Example 2: Streaming Completions with Syrin Instrumentation
 *
 * Run: SYRIN_API_KEY=test OPENAI_API_KEY=real npx tsx examples/02-streaming.ts
 * Or with mock backend: SYRIN_BACKEND_URL=http://localhost:4318 SYRIN_API_KEY=test npx tsx examples/02-streaming.ts
 *
 * What this example shows:
 *  - Streaming completions are automatically instrumented
 *  - Token counts extracted from the final chunk
 *  - Events emitted on stream completion
 */

import OpenAI from 'openai';
import { init, shutdown, withSession } from '../src/index.js';

async function main() {
  // Initialize Syrin — that's it!
  const sdk = await init({
    apiKey: process.env['SYRIN_API_KEY'] ?? 'syrin_demo_key',
    agentId: 'example-agent-streaming',
    backendUrl: process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4318',
    debug: true,
  });

  console.log(`Session ID: ${sdk.sessionId}`);

  const openai = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'] ?? 'sk-demo',
  });

  console.log('\n--- Streaming chat completion ---');

  try {
    // Use withSession to scope this call to a specific session
    await withSession('user_stream_demo', async () => {
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: 'Count from 1 to 10, putting each number on its own line.',
          },
        ],
        stream: true,
        stream_options: { include_usage: true }, // Required for token counts in streaming
        max_tokens: 100,
      });

      process.stdout.write('\nAssistant: ');

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          process.stdout.write(delta);
        }
      }

      process.stdout.write('\n');
    });

    console.log('\n(Syrin event will be emitted after stream completes)');
  } catch (err) {
    console.error('Streaming call failed (expected if no real API key):', err);
  }

  console.log('\n--- Making another streaming call (different session) ---');

  try {
    await withSession('user_stream_demo_2', async () => {
      const stream2 = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say "hello" in 5 different languages.' }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 100,
      });

      process.stdout.write('\nTranslations: ');
      for await (const chunk of stream2) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          process.stdout.write(delta);
        }
      }
      process.stdout.write('\n');
    });
  } catch (err) {
    console.error('Second streaming call failed:', err);
  }

  // Flush remaining events on shutdown
  console.log('\n--- Shutting down ---');
  await shutdown();
  console.log('Done.');
}

main().catch(console.error);
