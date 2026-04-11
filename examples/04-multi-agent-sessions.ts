/**
 * Example 04 — Multi-Agent Sessions: Know Which Agent Did What
 * =============================================================
 *
 * THE PROBLEM
 * -----------
 * You have a pipeline: 3 agents running in parallel.
 *   - "researcher" — searches and gathers information
 *   - "analyst"    — processes and finds patterns
 *   - "writer"     — turns findings into a report
 *
 * You open your dashboard. You see 30 LLM calls. No structure.
 * Which calls belong to which agent? Which agent is slow?
 * Which one is burning the most tokens? Which failed?
 *
 * You can't answer any of these questions because all calls look identical.
 * They're just a flat list of OpenAI requests.
 *
 * THE SYRIN SOLUTION
 * ------------------
 * Wrap each agent's work in `withAgent()` or `withWorkflow()`.
 * Syrin automatically tags every LLM call made inside that scope:
 *   - agent_id:    which agent made this call
 *   - run_id:      unique ID for this specific agent run
 *   - workflow_id: which workflow these agents belong to
 *   - trace_id:    spans the entire multi-agent tree (all 3 agents share it)
 *   - call_depth:  nesting level (0 = outermost workflow, 1 = agent inside)
 *
 * In the dashboard: calls are grouped by agent. You see timing, cost, and
 * run IDs per agent. The full trace shows the call tree visually.
 *
 * No changes to your OpenAI code. Just wrap the agent functions.
 *
 * Run:   npx tsx 04-multi-agent-sessions.ts
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { init, withWorkflow, withAgent } from '../src/index.js';
import type { RunContext } from '../src/index.js';

// ─── SETUP ───────────────────────────────────────────────────────────────────

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  name: 'multi-agent-pipeline',
  url: process.env.SYRIN_BACKEND_URL ?? 'http://localhost:4000',
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// ─── AGENT TASK DEFINITIONS ──────────────────────────────────────────────────

// Each of these functions makes real LLM calls.
// The withAgent() wrapper is the ONLY addition — your existing logic is unchanged.

async function runResearcher(topic: string, ctx: RunContext): Promise<string> {
  console.log(`  [researcher] Starting | runId: ${ctx.runId}`);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a research specialist. Return 3 key facts.' },
      { role: 'user', content: `Find key facts about: ${topic}` },
    ],
    max_tokens: 150,
  });

  // In the dashboard this call is tagged with:
  //   agent_id:    "researcher"
  //   run_id:      ctx.runId  (unique to this invocation)
  //   workflow_id: the parent workflow's ID
  //   trace_id:    shared across ALL agents in this pipeline run

  const result = response.choices[0].message.content ?? '';
  console.log(`  [researcher] Done    | ${response.usage?.total_tokens} tokens`);
  return result;
}

async function runAnalyst(facts: string, ctx: RunContext): Promise<string> {
  console.log(`  [analyst] Starting | runId: ${ctx.runId}`);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a data analyst. Find patterns and insights.' },
      { role: 'user', content: `Analyse these research findings:\n${facts}` },
    ],
    max_tokens: 150,
  });

  const result = response.choices[0].message.content ?? '';
  console.log(`  [analyst] Done    | ${response.usage?.total_tokens} tokens`);
  return result;
}

async function runWriter(insights: string, ctx: RunContext): Promise<string> {
  console.log(`  [writer] Starting | runId: ${ctx.runId}`);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a technical writer. Write a 2-sentence summary.' },
      { role: 'user', content: `Write a summary based on:\n${insights}` },
    ],
    max_tokens: 100,
  });

  const result = response.choices[0].message.content ?? '';
  console.log(`  [writer] Done    | ${response.usage?.total_tokens} tokens`);
  return result;
}

// ─── RUN 3 PIPELINES CONCURRENTLY ────────────────────────────────────────────

const topics = [
  'the rise of edge computing',
  'advances in battery technology',
  'the economics of open-source software',
];

console.log('Launching 3 parallel pipelines (each: researcher → analyst → writer)...\n');
console.log('In the dashboard, you will see:');
console.log('  - 3 workflows, each with 3 nested agents');
console.log('  - All calls grouped by agent_id and workflow_id');
console.log('  - A single trace_id spanning the entire parallel run\n');

// ─── THE ORCHESTRATION ───────────────────────────────────────────────────────

// Run all 3 pipelines concurrently using Promise.all.
// Each pipeline is scoped to a workflow. Inside each workflow, 3 agents run sequentially.
// AsyncLocalStorage ensures each async branch gets the right context — automatically.

const results = await Promise.all(
  topics.map((topic) =>
    // withWorkflow groups all agents in a pipeline under one workflow ID.
    // Every LLM call inside inherits the workflow_id automatically.
    withWorkflow(`pipeline-${topic.slice(0, 10).replace(/\s/g, '-')}`, async (wf: RunContext) => {
      console.log(`[workflow: ${wf.workflowId}] Starting pipeline for: "${topic}"`);

      // Step 1: Researcher
      const facts = await withAgent('researcher', async (ctx: RunContext) => {
        return runResearcher(topic, ctx);
      });

      // Step 2: Analyst (sequential — waits for researcher to finish)
      const insights = await withAgent('analyst', async (ctx: RunContext) => {
        return runAnalyst(facts, ctx);
      });

      // Step 3: Writer (sequential — waits for analyst)
      const summary = await withAgent('writer', async (ctx: RunContext) => {
        return runWriter(insights, ctx);
      });

      console.log(`[workflow: ${wf.workflowId}] Complete`);
      console.log(`  Final summary: "${summary.slice(0, 100)}..."\n`);

      return { topic, summary, workflowId: wf.workflowId, traceId: wf.traceId };
    })
  )
);

// ─── PRINT RESULTS ───────────────────────────────────────────────────────────

console.log('='.repeat(60));
console.log('ALL 3 PIPELINES COMPLETE');
console.log('='.repeat(60));

for (const result of results) {
  console.log(`\nTopic: "${result.topic}"`);
  console.log(`  Workflow ID: ${result.workflowId}`);
  console.log(`  Trace ID:    ${result.traceId}`);
  console.log(`  Summary:     "${result.summary.slice(0, 120)}..."`);
}

console.log(`\nSession ID: ${sdk.sessionId}`);
console.log('Open the dashboard and search for any of the IDs above.');
console.log('You will see every LLM call, grouped by agent, under each workflow.');

await sdk.flush();
await sdk.shutdown();

// ─── WHAT YOU JUST SAW ───────────────────────────────────────────────────────
//
//  BEFORE SYRIN:  30 LLM calls in a flat list. No idea which agent made which.
//                 To debug slow pipelines: grep logs, manually correlate IDs.
//
//  WITH SYRIN:
//    withWorkflow() → groups all agents in a pipeline under one workflow_id
//    withAgent()    → tags every LLM call with agent_id and a unique run_id
//    traceId        → one ID that spans the ENTIRE multi-agent tree
//    AsyncLocalStorage → automatically propagates into each Promise.all branch
//
//  IN THE DASHBOARD:
//    - "researcher" made 3 calls, avg 120ms, avg $0.00012 each
//    - "analyst" made 3 calls, avg 200ms
//    - "writer" made 3 calls, avg 90ms — fastest agent
//    - Pipeline for "edge computing" was slowest overall: 1.2s total
//    - Click any trace_id to see the full call tree as a waterfall diagram
