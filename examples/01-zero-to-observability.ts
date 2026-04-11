/**
 * Example 01 — Zero to Observability
 * ====================================
 *
 * THE PROBLEM
 * -----------
 * You've shipped an AI customer-support agent. It's live. Users are talking to it.
 *
 * But you have no idea what's happening inside:
 *   - Which prompts are actually working? Which are confusing the model?
 *   - How much is each conversation costing you? (You'll find out when the bill arrives.)
 *   - Is the agent failing silently — confidently returning wrong answers?
 *   - How long are responses taking? Are some users getting 8-second waits?
 *   - Is the model changing its behavior between calls? Is context growing unbounded?
 *
 * You're flying blind. The only feedback loop is an angry user email or a surprise invoice.
 *
 * THE SYRIN SOLUTION
 * ------------------
 * One import. One `await init()`. That's the entire integration.
 *
 * From that point on, every LLM call is automatically observed:
 *   - Token counts and cost per call, running cumulative total
 *   - Latency (how long did the model take to respond?)
 *   - Model used, temperature, finish reason
 *   - Conversation hash — detects if the agent is stuck in a loop
 *   - Context utilization — how full is the context window?
 *   - Session ID — lets you replay any conversation in the dashboard
 *
 * You don't change your OpenAI code. Not a single line.
 *
 * Run:   npx tsx 01-zero-to-observability.ts
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { init } from '../src/index.js';

// ─── SETUP ───────────────────────────────────────────────────────────────────

// This is the only line you add to your existing code.
// Everything below (the OpenAI calls) is unchanged from what you already have.
const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  name: 'customer-support-agent',
  url: process.env.SYRIN_BACKEND_URL ?? 'http://localhost:4000',
  debug: false, // set to true to see all SDK activity in your terminal
});

// Your session ID — use this to find this exact conversation in the dashboard.
console.log('');
console.log('='.repeat(60));
console.log('  SESSION ID:', sdk.sessionId);
console.log('  Open the dashboard and search for this ID to see');
console.log('  every call below with full telemetry attached.');
console.log('='.repeat(60));
console.log('');

// Your regular OpenAI client — no changes here.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ─── A REALISTIC 3-TURN CONVERSATION ─────────────────────────────────────────

// Imagine this is a user chatting with your support agent.
// Each call below is intercepted by Syrin and reported to the dashboard.
// You write zero extra code — the interception is automatic.

const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
  {
    role: 'system',
    content: 'You are a helpful customer support agent for a SaaS product called Taskflow. Be concise.',
  },
];

const conversation = [
  'How do I cancel my subscription?',
  'Will I lose my data immediately when I cancel?',
  'Can I export my data before I cancel?',
];

console.log('Starting a 3-turn customer support conversation...');
console.log('(Every call is automatically sent to the Syrin dashboard)\n');

for (const userMessage of conversation) {
  messages.push({ role: 'user', content: userMessage });

  console.log(`User: "${userMessage}"`);

  const startTime = Date.now();

  // ─── THIS IS YOUR EXISTING CODE — UNCHANGED ──────────────────────────────
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.7,
    max_tokens: 200,
  });
  // ─────────────────────────────────────────────────────────────────────────

  const latencyMs = Date.now() - startTime;
  const reply = response.choices[0].message.content ?? '';
  const usage = response.usage!;

  // What Syrin automatically captured for this call and sent to the dashboard:
  //   model:               gpt-4o-mini
  //   input_tokens:        ~350 (grows each turn as conversation history grows)
  //   output_tokens:       ~80
  //   cost_usd:            ~$0.0001
  //   latency_ms:          as measured above
  //   finish_reason:       "stop"
  //   context_utilization: e.g. 0.04 (4% of the 128k context window used)
  //   conversation_hash:   fingerprint of the full conversation (loop detection)
  //   session_id:          links all 3 turns together in the dashboard

  messages.push({ role: 'assistant', content: reply });

  console.log(`Agent: "${reply.slice(0, 120)}${reply.length > 120 ? '...' : ''}"`);
  console.log(`  → ${latencyMs}ms | ${usage.prompt_tokens} in / ${usage.completion_tokens} out tokens`);
  console.log('');
}

// Flush any buffered events before the process exits.
await sdk.flush();
await sdk.shutdown();

// ─── WHAT YOU JUST GOT ───────────────────────────────────────────────────────
//
//  Without adding a single line to your LLM calls, you now have:
//
//  COST TRACKING
//    Every call is costed in real time. See cumulative cost per session.
//    Get alerted when a session or agent exceeds your budget.
//
//  LATENCY MONITORING
//    p50 / p95 / p99 latency per agent, model, and time period.
//    Spot regressions before users complain.
//
//  CONVERSATION REPLAY
//    Search by session ID in the dashboard and replay the full conversation.
//    See exactly what the user sent and what the model replied.
//
//  LOOP DETECTION
//    Each call has a conversation_hash. If the hash repeats, the backend
//    knows the agent is stuck. It can stop it automatically.
//
//  CONTEXT GROWTH TRACKING
//    See how context utilization grows turn-by-turn.
//    Know when you're approaching the context limit before it breaks.
//
//  ZERO CODE CHANGES
//    Your OpenAI code is identical. Syrin patches at the library level.
//    If Syrin crashes, your agent still runs. Telemetry is best-effort.
