/**
 * 03 — Multi-Agent Remote Config
 * --------------------------------
 * When cfg() is called inside a withAgent("name", ...) context,
 * the field is registered under that agent's namespace in the dashboard.
 *
 * Dashboard layout:
 *   Global Config
 *     llm.model             ← declared outside withAgent
 *     llm.temperature       ← declared outside withAgent
 *   Agents
 *     query-enhancer
 *       llm.temperature     ← declared inside withAgent("query-enhancer")
 *       prompt.system_prompt
 *     summarizer
 *       llm.temperature     ← declared inside withAgent("summarizer")
 *       prompt.system_prompt
 *       output.format
 *
 * Run:
 *   SYRIN_API_KEY=syrin_... npx ts-node examples/03_multi_agent_config.ts
 */

import { init, shutdown, withAgent } from '@syrin/sdk';

async function main() {
  const sdk = await init({
    apiKey: process.env['SYRIN_API_KEY'] ?? '',
    name: 'marketing-pipeline',
    url: process.env['SYRIN_URL'] ?? 'https://api.syrin.ai',
  });

  // --- Global config --------------------------------------------------------
  const globalModel = sdk.cfg('llm.model', 'gpt-4o', {
    label: 'LLM Model',
    description: 'Default model for all pipeline stages',
  });
  const globalTemp = sdk.cfg('llm.temperature', 0.7, {
    label: 'Temperature',
    ge: 0.0,
    le: 2.0,
  });

  // --- Per-agent config -----------------------------------------------------
  let enhancerTemp: unknown;
  let enhancerPrompt: unknown;

  await withAgent('query-enhancer', async () => {
    enhancerTemp = sdk.cfg('llm.temperature', 0.3, {
      label: 'Temperature',
      description: 'Lower = more focused query plans',
      ge: 0.0,
      le: 2.0,
    });
    enhancerPrompt = sdk.cfg('prompt.system_prompt', 'You are an expert research planner.', {
      label: 'System Prompt',
      multiline: true,
    });
    // ... your LLM call here
  });

  let summarizerTemp: unknown;
  let summarizerPrompt: unknown;
  let summarizerFormat: unknown;

  await withAgent('summarizer', async () => {
    summarizerTemp = sdk.cfg('llm.temperature', 0.5, {
      label: 'Temperature',
      description: 'Moderate temp for readable summaries',
      ge: 0.0,
      le: 2.0,
    });
    summarizerPrompt = sdk.cfg('prompt.system_prompt',
      'You synthesise research into clear marketing briefs.', {
        label: 'System Prompt',
        multiline: true,
      });
    summarizerFormat = sdk.cfg('output.format', 'markdown', {
      label: 'Output Format',
      enum: ['markdown', 'json', 'plaintext'],
    });
    // ... your LLM call here
  });

  console.log('Pipeline config:');
  console.log(`  global model        = ${String(globalModel)}`);
  console.log(`  global temperature  = ${String(globalTemp)}`);
  console.log(`  enhancer temp       = ${String(enhancerTemp)}`);
  console.log(`  enhancer prompt     = ${String(enhancerPrompt)}`);
  console.log(`  summarizer temp     = ${String(summarizerTemp)}`);
  console.log(`  summarizer format   = ${String(summarizerFormat)}`);

  await shutdown();
}

main().catch(console.error);
