/**
 * Basic Instrumentation — Syrin SDK
 * ====================================
 * The smallest possible integration: two lines to instrument all OpenAI calls.
 * Every LLM_CALL event is sent to the Syrin backend and appears in the dashboard.
 *
 * Prerequisites
 * -------------
 *   1. Backend running:  cd syrin-backend && npm run dev
 *   2. Create a project + API key in the dashboard (http://localhost:5173)
 *   3. Copy the API key below (or export SYRIN_API_KEY=...)
 *
 * Run
 * ---
 *   SYRIN_API_KEY=syrin_... OPENAI_API_KEY=sk-... \
 *     npx tsx examples/basic-instrumentation.ts
 */

import OpenAI from 'openai';
import { init, shutdown } from '../src/index.js';

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY']!,
  agentId: 'my-agent',
  backendUrl: process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000',
  captureContent: true,
  debug: true,
});

console.log(`Session: ${sdk.sessionId}`);

// Your existing OpenAI code — zero changes needed.
const openai = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

const r1 = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user',   content: 'What is observability for AI agents in one sentence?' },
  ],
  temperature: 0.7,
  max_tokens: 120,
});
console.log('\nAssistant:', r1.choices[0]?.message?.content);

// A second call — both show up in the same session in the dashboard.
const r2 = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Give one concrete example of an AI observability gap.' }],
  max_tokens: 80,
});
console.log('Follow-up:', r2.choices[0]?.message?.content);

// Flush remaining events and stop the SDK.
await shutdown();
console.log('\nDone — open the dashboard to see the session.');
