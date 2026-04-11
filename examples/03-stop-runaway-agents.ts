/**
 * Example 03 — Stop Runaway Agents Before They Burn Your Budget
 * ==============================================================
 *
 * THE PROBLEM
 * -----------
 * Autonomous agents are powerful — and dangerous.
 *
 * A bug in your tool-calling logic sends the agent into a loop.
 * It calls the same search tool 50 times. It doesn't stop.
 * Each iteration uses 2,000 tokens. At gpt-4o prices that's $1 per loop.
 * You have 3 users hitting this path simultaneously.
 *
 * You find out the next morning when your OpenAI bill hits $300.
 *
 * Or worse: the agent is making write operations — updating records,
 * sending emails, posting to APIs. And it's doing it over and over.
 *
 * THE SYRIN SOLUTION
 * ------------------
 * Syrin watches every LLM call in real time. The backend detects:
 *   - Repeated conversation hashes (the agent is stuck)
 *   - Cost exceeding your configured budget
 *   - Call count exceeding a threshold
 *
 * When triggered, the backend sends a `stop` governance action.
 * The SDK throws a `GovernanceStopError` before the next LLM call.
 * Your code catches it and cleans up gracefully.
 *
 * You also get a real-time alert via the `onAlert` hook —
 * log it, send it to Slack, page your on-call engineer.
 *
 * Run:   npx tsx 03-stop-runaway-agents.ts
 *
 * To simulate a backend stop during the run, in another terminal:
 *
 *   curl -X POST http://localhost:4000/control/governance \
 *        -H 'Content-Type: application/json' \
 *        -d '{"actions": [{"type": "stop", "reason": "loop detected", "incident_id": "inc_001"}]}'
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { init, onAlert, GovernanceStopError } from '../src/index.js';
import type { MessageParam } from '../src/index.js';

// ─── SETUP ───────────────────────────────────────────────────────────────────

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  name: 'research-agent',
  url: process.env.SYRIN_BACKEND_URL ?? 'http://localhost:4000',
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ─── REAL-TIME ALERT HOOK ─────────────────────────────────────────────────────

// This fires when the backend sends any alert governance action.
// In production: send this to Slack, PagerDuty, email, your observability platform.
onAlert((action: Record<string, unknown>) => {
  console.log('\n🚨 ALERT from Syrin backend:');
  console.log('   Message:', action['message'] ?? 'Agent behavior anomaly detected');
  console.log('   Level:  ', action['level'] ?? 'warning');
  console.log('   This would page your on-call engineer in production.\n');
});

// ─── CREATE A CHECKPOINT BEFORE THE RISKY OPERATION ──────────────────────────

// Save the conversation state before we start the agentic loop.
// If the agent is stopped by governance, we can restore from here
// instead of losing all progress.
const initialMessages: MessageParam[] = [
  {
    role: 'user',
    content: 'Research everything you can find about quantum computing breakthroughs in 2024.',
  },
];

const checkpoint = await sdk.createCheckpoint(initialMessages, {
  label: 'before-research-loop',
});
console.log(`Checkpoint saved: ${checkpoint.checkpointId}`);
console.log('(If the agent is stopped, we can restore from here)\n');

// ─── THE AGENTIC LOOP ────────────────────────────────────────────────────────

// Simulate an agent that makes multiple sequential LLM calls.
// In a real agent, this might be: plan → search → read → search → summarize.
// The bug: it keeps searching instead of stopping. A runaway loop.

const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
  { role: 'system', content: 'You are a research agent. Be thorough.' },
  { role: 'user', content: 'Research quantum computing breakthroughs in 2024. Keep digging deeper.' },
];

let cumulativeCost = 0;

console.log('Starting agentic research loop (5 iterations max)...');
console.log('Syrin is watching every call. Run the curl command above to stop it.\n');

try {
  for (let step = 1; step <= 5; step++) {
    console.log(`─── Step ${step} ─────────────────────────────────────────────`);

    // Each call to openai.chat.completions.create is automatically intercepted.
    // Syrin tracks:
    //   - conversation_hash: if this repeats, it's a loop
    //   - cost_usd: cumulative cost across all calls
    //   - call_count: how many times this session has called the LLM
    // The backend analyses these signals and can send a `stop` action.
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 150,
    });

    const reply = response.choices[0].message.content ?? '';
    const usage = response.usage!;

    // Rough cost estimate: gpt-4o-mini is $0.15/M input + $0.60/M output
    const callCost = (usage.prompt_tokens * 0.00015 + usage.completion_tokens * 0.0006) / 1000;
    cumulativeCost += callCost;

    console.log(`  Tokens:    ${usage.prompt_tokens} in / ${usage.completion_tokens} out`);
    console.log(`  Call cost: $${callCost.toFixed(5)}`);
    console.log(`  TOTAL SO FAR: $${cumulativeCost.toFixed(5)}`);
    console.log(`  Reply: "${reply.slice(0, 80)}..."`);
    console.log('');

    messages.push({ role: 'assistant', content: reply });
    messages.push({ role: 'user', content: 'Good. Now keep researching. Go deeper.' });

    // Small delay so you have time to trigger the stop via curl
    await new Promise((r) => setTimeout(r, 2_000));
  }

  console.log('Loop completed normally (no governance action was triggered).');
  console.log('In a real runaway scenario, the backend would have stopped this.');

} catch (err) {
  // ─── GOVERNANCE STOP — CLEAN SHUTDOWN ────────────────────────────────────

  if (err instanceof GovernanceStopError) {
    const stopErr = err as GovernanceStopError;
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  AGENT STOPPED BY SYRIN GOVERNANCE               ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`  Reason:      ${stopErr.reason}`);
    console.log(`  Incident ID: ${stopErr.incidentId ?? 'none'}`);
    console.log(`  Cost burned: $${cumulativeCost.toFixed(5)}`);
    console.log('');
    console.log('  Restoring conversation from checkpoint...');

    // Restore the conversation from before the runaway loop started.
    const restored = await sdk.restoreCheckpoint(checkpoint.checkpointId);
    if (restored) {
      console.log(`  Restored ${restored.length} message(s) from checkpoint "${checkpoint.checkpointId}".`);
      console.log('  The agent can now restart from a known-good state.');
    }

    console.log('');
    console.log('  WITHOUT SYRIN: This loop would have run to completion,');
    console.log('  burning tokens until OpenAI rate-limited you or the bill arrived.');

  } else {
    // Re-throw anything that isn't a governance stop
    throw err;
  }
}

await sdk.flush();
await sdk.shutdown();

// ─── WHAT YOU JUST SAW ───────────────────────────────────────────────────────
//
//  BEFORE SYRIN:  Runaway agent → morning surprise on OpenAI billing page.
//                 Or worse: repeated writes to external APIs.
//
//  WITH SYRIN:
//    1. Every call is observed (cost, token count, conversation hash)
//    2. Backend detects the loop pattern
//    3. Sends a `stop` action in the /ingest response
//    4. SDK throws GovernanceStopError before the NEXT call
//    5. Your catch block runs cleanup / restore / alerting
//    6. Total damage: capped to whatever ran before the stop
//
//  REAL-TIME ALERTS:
//    onAlert() fires for any alert action (loop detected, budget exceeded, etc.)
//    Route these to Slack, PagerDuty, or your observability platform.
//
//  CHECKPOINTS:
//    Save state before risky operations. Restore if governance stops the agent.
//    Never lose progress to a runaway loop.
