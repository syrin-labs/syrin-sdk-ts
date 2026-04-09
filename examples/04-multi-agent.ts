/**
 * Example 4: Multi-Agent System
 *
 * Demonstrates Syrin's built-in multi-agent support:
 *   - Agent scoping via withAgent()
 *   - Parallel swarms via withSwarm()
 *   - Workflow grouping via withWorkflow()
 *   - All LLM calls traced with run_id, workflow_id, swarm_id
 *
 * Run with mock backend (no real OpenAI key needed — SDK in offline mode):
 *   SYRIN_API_KEY=syrin_test npx tsx examples/04-multi-agent.ts
 *
 * With a real backend + OpenAI key:
 *   SYRIN_API_KEY=syrin_test OPENAI_API_KEY=sk-... npx tsx examples/04-multi-agent.ts
 */

import { init, shutdown, withAgent, withWorkflow, withSwarm } from '../src/index.js';

const REAL_OPENAI = Boolean(process.env['OPENAI_API_KEY']?.startsWith('sk-'));
const BACKEND_URL = process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4318';

// ---------------------------------------------------------------------------
// Initialise SDK
// ---------------------------------------------------------------------------

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY'] ?? 'syrin_demo',
  backendUrl: BACKEND_URL,
  debug: true,
  offline: !REAL_OPENAI,
  idleFlushMs: 2_000,
});

console.log('='.repeat(60));
console.log('  SYRIN MULTI-AGENT DEMO (TypeScript)');
console.log('='.repeat(60));
if (!REAL_OPENAI) console.log('  (offline mode — no API key needed)');
console.log();

// ---------------------------------------------------------------------------
// Demo 1: Sequential workflow
// ---------------------------------------------------------------------------

async function demoWorkflow(): Promise<void> {
  console.log('─── Demo 1: Sequential Workflow ─────────────────────────');

  await withWorkflow('research-pipeline', async (wfCtx) => {
    console.log(`  workflow_id=${wfCtx.workflowId}`);

    const facts = await withAgent('researcher', async (ctx) => {
      console.log(`  [researcher] run_id=${ctx.runId.slice(0, 12)}  workflow=${ctx.workflowId}`);
      // In offline mode nothing is sent to network — but the event IS emitted to the queue
      return 'Simulated facts about quantum computing';
    });

    const summary = await withAgent('summariser', async (ctx) => {
      console.log(`  [summariser] run_id=${ctx.runId.slice(0, 12)}  workflow=${ctx.workflowId}`);
      return `Summary: ${facts.slice(0, 40)}...`;
    });

    console.log(`  Result: ${summary}`);
  });

  console.log();
}

// ---------------------------------------------------------------------------
// Demo 2: Parallel swarm
// ---------------------------------------------------------------------------

async function demoSwarm(): Promise<void> {
  console.log('─── Demo 2: Parallel Swarm (3 agents) ───────────────────');

  await withSwarm('parallel-research', async (swarmCtx) => {
    console.log(`  swarm_id=${swarmCtx.swarmId}`);

    const results = await Promise.all([
      withAgent('agent-climate', async (ctx) => {
        console.log(`  [agent-climate] run_id=${ctx.runId.slice(0, 12)}  swarm=${ctx.swarmId}`);
        return 'Climate answer';
      }),
      withAgent('agent-ai', async (ctx) => {
        console.log(`  [agent-ai] run_id=${ctx.runId.slice(0, 12)}  swarm=${ctx.swarmId}`);
        return 'AI answer';
      }),
      withAgent('agent-space', async (ctx) => {
        console.log(`  [agent-space] run_id=${ctx.runId.slice(0, 12)}  swarm=${ctx.swarmId}`);
        return 'Space answer';
      }),
    ]);

    console.log(`  All ${results.length} agents completed in parallel.`);
  });

  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await demoWorkflow();
  await demoSwarm();

  // Allow idle flush to trigger
  await new Promise((r) => setTimeout(r, 2_500));

  console.log('='.repeat(60));
  console.log('  Demo complete!');
  console.log('  Check mock backend output to see all events with run/swarm/workflow IDs');
  console.log('='.repeat(60));

  await shutdown();
}

main().catch(console.error);
