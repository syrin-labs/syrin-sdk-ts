/**
 * 03 — Multi-Agent Remote Config
 * --------------------------------
 * Use sdk.agent() to get an AgentHandle per agent, then declare config with
 * .field() chaining and enter scopes via .run() or .session().
 *
 * Each agent has independent observability settings:
 *   captureContent    → include prompts/completions in telemetry
 *   captureToolCalls  → emit TOOL_CALL / TOOL_RESULT events
 *
 * Dashboard layout after this script:
 *   Agents
 *     query-enhancer         ← from .field() declarations
 *       llm.temperature
 *       prompt.system_prompt
 *     summarizer             ← from .field() declarations
 *       llm.temperature
 *       prompt.system_prompt
 *       output.output_format
 *
 * Config priority per agent: governance > configure() > remote push > default
 *
 * Run:
 *   SYRIN_API_KEY=syrin_... npx ts-node examples/03_multi_agent_config.ts
 */

import { init, shutdown } from '@syrin/sdk';

async function main() {
  const sdk = await init({
    apiKey: process.env['SYRIN_API_KEY'] ?? '',
    agentId: 'marketing-pipeline',
    backendUrl: process.env['SYRIN_BACKEND_URL'] ?? 'https://api.syrin.dev',
  });

  // --- sdk.agent() — get an AgentHandle, then chain .field() calls ----------
  // Keys use "section.fieldName" dot-notation.
  // .field() declares the field AND returns `this` for chaining.

  const queryEnhancer = sdk.agent('query-enhancer', {
    description: "Reformulates and expands the user's query",
    captureContent: true,
    captureToolCalls: true,
  });
  queryEnhancer
    .field('llm.temperature', 0.3, { ge: 0.0, le: 2.0, label: 'Temperature' })
    .field('prompt.system_prompt', 'You are an expert research planner.', {
      multiline: true,
      label: 'System Prompt',
    });

  const summarizer = sdk.agent('summarizer', {
    description: 'Synthesises research into clear briefs',
    captureContent: false,
    captureToolCalls: false,
  });
  summarizer
    .field('llm.temperature', 0.5, { ge: 0.0, le: 2.0, label: 'Temperature' })
    .field('prompt.system_prompt', 'You synthesise research into clear marketing briefs.', {
      multiline: true,
      label: 'System Prompt',
    })
    .field('output.output_format', 'markdown', {
      enum: ['markdown', 'json', 'plaintext'],
      label: 'Output Format',
    });

  // --- Pattern 1: .run(fn) — agent scope only (no user session) --------------
  console.log('\n--- Pattern 1: .run() ---');
  await queryEnhancer.run(async () => {
    const temp   = queryEnhancer.cfg('llm.temperature', 0.3) as number;
    const prompt = queryEnhancer.cfg('prompt.system_prompt', 'You are an expert research planner.');
    console.log(`  query-enhancer: temp=${temp}, prompt=${String(prompt).slice(0, 40)}`);
    // ... your LLM call here
  });

  // --- Pattern 2: .session(options, fn) — session + agent scope --------------
  console.log('\n--- Pattern 2: .session() ---');
  const ctx = await summarizer.session(
    { userId: 'demo-user', window: 'day' },
    async (ctx) => {
      const temp   = summarizer.cfg('llm.temperature', 0.5) as number;
      const format = summarizer.cfg('output.output_format', 'markdown');
      const prompt = summarizer.cfg('prompt.system_prompt', 'You synthesise research into clear marketing briefs.');
      console.log(`  summarizer: temp=${temp}, format=${String(format)}, session=${ctx.sessionId}`);
      console.log(`  prompt: ${String(prompt).slice(0, 40)}`);
      // ... your LLM call here
      return ctx;
    }
  );
  console.log(`  session resolved: ${ctx.sessionId}`);

  // --- Pattern 3: sdk.workflow() wrapping multiple agents --------------------
  console.log('\n--- Pattern 3: sdk.workflow() ---');
  await sdk.workflow('research-pipeline', async (wfCtx) => {
    console.log(`  workflow_id=${wfCtx.workflowId}`);

    await queryEnhancer.run(async () => {
      const temp = queryEnhancer.cfg('llm.temperature', 0.3) as number;
      console.log(`  [workflow] query-enhancer: temp=${temp}`);
      // ... your LLM call here
    });

    await summarizer.run(async () => {
      const fmt = summarizer.cfg('output.output_format', 'markdown');
      console.log(`  [workflow] summarizer: format=${String(fmt)}`);
      // ... your LLM call here
    });
  });

  await shutdown();
  console.log('\nDone. Check the Syrin dashboard for per-agent config fields.');
}

main().catch(console.error);
