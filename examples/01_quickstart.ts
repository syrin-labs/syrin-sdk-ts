/**
 * 01 — Quickstart
 * ---------------
 * Minimal Syrin SDK integration: init, register an agent, observe one LLM call.
 *
 * Works with any LLM library (OpenAI, Anthropic, Vercel AI, LangChain, etc.).
 * The SDK auto-detects which library you have installed and instruments it.
 *
 * Run:
 *   SYRIN_API_KEY=syrin_... npx ts-node examples/01_quickstart.ts
 */

import { init, shutdown, withAgent } from '@syrin/sdk';

async function main() {
  // 1. Init — only apiKey and name are required.
  const sdk = await init({
    apiKey: process.env['SYRIN_API_KEY'] ?? '',
    name: 'my-agent',
    url: process.env['SYRIN_URL'] ?? 'https://api.syrin.ai',
  });

  // 2. Register your agent — declare how it should be observed.
  //    Call this any time after init(), before the agent runs.
  sdk.registerAgent({
    agentId: 'assistant',
    description: 'General-purpose assistant',
    captureContent: false,   // keep prompts private (default)
    captureToolCalls: true,  // emit TOOL_CALL / TOOL_RESULT events
  });

  // 3. Make an LLM call inside the agent scope.
  //    The SDK intercepts it automatically — no wrappers needed.
  await withAgent('assistant', async () => {
    // replace with your LLM call:
    //
    // import OpenAI from 'openai';
    // const client = new OpenAI();
    // const response = await client.chat.completions.create({
    //   model: 'gpt-4o-mini',
    //   messages: [{ role: 'user', content: 'Hello!' }],
    // });
    // console.log(response.choices[0].message.content);
  });

  console.log('SDK ready — make your LLM call inside withAgent().');
  console.log('Config snapshot:', sdk.configSnapshot());

  // 4. Shutdown
  await shutdown();
}

main().catch(console.error);
