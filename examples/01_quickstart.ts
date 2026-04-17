/**
 * 01 — Quickstart
 * ---------------
 * Minimal Syrin SDK integration: init, observe one LLM call, shutdown.
 *
 * Works with any LLM library (OpenAI, Anthropic, Vercel AI, LangChain, etc.).
 * The SDK auto-detects which library you have installed and instruments it.
 *
 * Run:
 *   SYRIN_API_KEY=syrin_... npx ts-node examples/01_quickstart.ts
 */

import { init, shutdown } from '@syrin/sdk';

async function main() {
  // 1. Init — only SYRIN_API_KEY and name are required
  const sdk = await init({
    apiKey: process.env['SYRIN_API_KEY'] ?? '',
    name: 'my-agent',
    url: process.env['SYRIN_URL'] ?? 'https://api.syrin.ai',
    captureContent: true,
  });

  // 2. Make an LLM call (replace with your library of choice)
  // The SDK intercepts it automatically — no wrappers needed.
  //
  // Example with OpenAI:
  //   import OpenAI from 'openai';
  //   const client = new OpenAI();
  //   const response = await client.chat.completions.create({
  //     model: 'gpt-4o-mini',
  //     messages: [{ role: 'user', content: 'Hello!' }],
  //   });
  //   console.log(response.choices[0].message.content);

  console.log('SDK ready — make your LLM call here.');
  console.log('Config snapshot:', sdk.configSnapshot());

  // 3. Shutdown
  await shutdown();
}

main().catch(console.error);
