/**
 * 03 — Multi-Agent Remote Config
 * --------------------------------
 * Use sdk.agent() to register each agent AND get a session handle in one step.
 * Call .run(fn) on the handle to enter the agent context — no separate
 * registerAgent() + withAgent() pair needed.
 *
 * Each agent has independent observability settings:
 *   captureContent    → include prompts/completions in telemetry
 *   captureToolCalls  → emit TOOL_CALL / TOOL_RESULT events
 *
 * Dashboard layout after this script:
 *   Agents
 *     query-enhancer         ← from fields map
 *       llm.temperature
 *       prompt.system_prompt
 *     summarizer             ← from fields map
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
    name: 'marketing-pipeline',
    url: process.env['SYRIN_URL'] ?? 'https://api.syrin.ai',
  });

  // --- sdk.agent() — register AND get a session handle in one step ----------
  // Keys use "section.fieldName" dot-notation.
  // The returned handle's .run(fn) enters the agent scope automatically.

  const queryEnhancer = sdk.agent('query-enhancer', {
    description: "Reformulates and expands the user's query",
    captureContent: true,
    captureToolCalls: true,
    fields: {
      'llm.temperature':      { default: 0.3, ge: 0.0, le: 2.0, label: 'Temperature' },
      'prompt.system_prompt': {
        default: 'You are an expert research planner.',
        multiline: true,
        label: 'System Prompt',
      },
    },
  });

  const summarizer = sdk.agent('summarizer', {
    description: 'Synthesises research into clear briefs',
    captureContent: false,
    captureToolCalls: false,
    fields: {
      'llm.temperature':        { default: 0.5, ge: 0.0, le: 2.0, label: 'Temperature' },
      'prompt.system_prompt':   {
        default: 'You synthesise research into clear marketing briefs.',
        multiline: true,
        label: 'System Prompt',
      },
      'output.output_format':   {
        default: 'markdown',
        enum: ['markdown', 'json', 'plaintext'],
        label: 'Output Format',
      },
    },
  });

  // --- Global defaults -------------------------------------------------------
  sdk.cfg('llm.model', 'gpt-4o');
  sdk.cfg('llm.temperature', 0.7);

  // --- Run the pipeline ------------------------------------------------------
  // .run(fn) enters the agent context — cfg() inside is scoped to that agent.

  await queryEnhancer.run(async () => {
    const temp   = sdk.cfg('llm.temperature', 0.3) as number;
    const prompt = sdk.cfg('prompt.system_prompt', 'You are an expert research planner.');
    console.log(`  query-enhancer: temp=${temp}, prompt=${String(prompt).slice(0, 40)}`);
    // ... your LLM call here
  });

  await summarizer.run(async () => {
    const temp   = sdk.cfg('llm.temperature', 0.5) as number;
    const format = sdk.cfg('output.output_format', 'markdown');
    const prompt = sdk.cfg('prompt.system_prompt', 'You synthesise research into clear marketing briefs.');
    console.log(`  summarizer: temp=${temp}, format=${String(format)}`);
    console.log(`  prompt: ${String(prompt).slice(0, 40)}`);
    // ... your LLM call here
  });

  await shutdown();
}

main().catch(console.error);
