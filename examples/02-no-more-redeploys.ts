/**
 * Example 02 — No More Redeploys for Config Changes
 * ===================================================
 *
 * THE PROBLEM
 * -----------
 * Your product manager sends a Slack message:
 *   "The agent is way too verbose. Can we make it shorter? Also marketing wants
 *    to try the cheaper model. And can we make it less random?"
 *
 * So you:
 *   1. Open your code editor
 *   2. Change temperature: 0.7 → 0.2
 *   3. Change model: "gpt-4o" → "gpt-4o-mini"
 *   4. Change max_tokens: 1000 → 150
 *   5. Commit. Push. Wait for CI. Wait for deploy. Wait for rollout.
 *   6. Verify it's live.
 *
 * That's 20-45 minutes for three number changes.
 *
 * If you have 3 agents, that's 3 builds. If you need to revert, add another build.
 * If you want to A/B test different temperatures, good luck.
 *
 * THE SYRIN SOLUTION
 * ------------------
 * Config is a runtime concern, not a code concern. With Syrin:
 *
 *   - Your backend sends new config in the /ingest response
 *   - The SDK picks it up automatically on the next call
 *   - No rebuild. No redeploy. No downtime.
 *   - You get a hook that fires when config changes, so you can log it
 *
 * You can also send config directly to a running agent via a single curl command.
 *
 * Run:   npx tsx 02-no-more-redeploys.ts
 *
 * Then in another terminal, while it's running:
 *
 *   curl -X POST http://localhost:4000/control/config \
 *        -H 'Content-Type: application/json' \
 *        -d '{"temperature": 0.1, "model": "gpt-4o", "max_tokens": 100}'
 *
 * Watch the config change live in this terminal's output. No restart needed.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { init, onConfigChange } from '../src/index.js';

// ─── SETUP ───────────────────────────────────────────────────────────────────

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  name: 'content-writing-agent',
  url: process.env.SYRIN_BACKEND_URL ?? 'http://localhost:4000',
  // Poll for remote config updates every 5 seconds.
  // In production you'd use backend-pushed config via the /ingest response,
  // but polling is a simple way to see config changes during development.
  configPollIntervalMs: 5_000,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ─── THE MAGIC: CONFIG CHANGE HOOK ───────────────────────────────────────────

// This function fires automatically whenever the backend sends new config.
// Use it to log what changed, update dashboards, or notify your team.
onConfigChange((sessionId: string, changes: Record<string, unknown>) => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  CONFIG UPDATED — NO REDEPLOY NEEDED            ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('  Session:', sessionId);
  console.log('  Changes:', JSON.stringify(changes, null, 2));
  console.log('  The next LLM call will automatically use these values.\n');
});

// ─── LOCAL CONFIG: YOUR STARTING DEFAULTS ────────────────────────────────────

// Set your initial config locally. The backend can override these at any time
// without you touching code.
sdk.configure({
  temperature: 0.7,  // will be changed to 0.2 by the curl command above
  max_tokens: 500,   // will be changed to 100
  model: 'gpt-4o-mini', // unchanged to keep this example cheap
});

// ─── THE AGENT LOOP ──────────────────────────────────────────────────────────

const topics = [
  'the future of remote work',
  'why sleep is the ultimate productivity hack',
  'the hidden costs of microservices',
];

console.log('Running 3 LLM calls, 10 seconds apart.');
console.log('In another terminal, run the curl command from the file comment to');
console.log('change the config live. Watch it take effect on the next call.\n');

for (let i = 0; i < topics.length; i++) {
  const topic = topics[i];

  // Print active config before each call so you can see it change in real time.
  const activeConfig = sdk.activeConfig();
  const temperature = activeConfig.temperature ?? 0.7;
  const maxTokens = activeConfig.max_tokens ?? 500;
  const model = (activeConfig.model as string | null) ?? 'gpt-4o-mini';

  console.log(`─── Call ${i + 1} of ${topics.length} ───────────────────────────`);
  console.log(`  Topic:       "${topic}"`);
  console.log(`  temperature: ${temperature}`);
  console.log(`  max_tokens:  ${maxTokens}`);
  console.log(`  model:       ${model}`);

  const response = await openai.chat.completions.create({
    model: model,          // Syrin injects these from the active config
    temperature: temperature as number,
    max_tokens: maxTokens as number,
    messages: [
      { role: 'system', content: 'You write punchy, opinionated blog post intros. One paragraph only.' },
      { role: 'user', content: `Write a blog intro about: ${topic}` },
    ],
  });

  const reply = response.choices[0].message.content ?? '';
  console.log(`  Response (${reply.length} chars): "${reply.slice(0, 100)}..."`);
  console.log('');

  if (i < topics.length - 1) {
    // Wait 10 seconds between calls so you have time to run the curl command.
    console.log('  Waiting 10s before next call... (run the curl command now!)\n');
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

await sdk.flush();
await sdk.shutdown();

// ─── WHAT YOU JUST SAW ───────────────────────────────────────────────────────
//
//  BEFORE SYRIN:  PM wants a config change → open code → edit → commit →
//                 build → deploy → wait → verify. 20-45 minutes.
//
//  WITH SYRIN:    curl one endpoint. Change takes effect on the next LLM call.
//                 No code changes. No deploy. 10 seconds.
//
//  WHAT THIS ENABLES:
//    - PM or product team can tune agent behavior without engineering
//    - A/B test different temperatures or models with zero code changes
//    - Emergency rollback: if a model behaves badly, switch models instantly
//    - All config changes are logged in the dashboard with timestamps
