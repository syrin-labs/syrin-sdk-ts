/**
 * 02 — Remote Config  (the most important feature)
 * --------------------------------------------------
 * cfg() is the universal API for setting remotely configurable defaults.
 *
 *   sdk.cfg("section.field", default)
 *
 * - The SDK pre-registers standard LLM fields (model, temperature, max_tokens,
 *   top_p, frequency_penalty, presence_penalty, seed, system_prompt) with their
 *   labels, descriptions, and constraints — so the dashboard is immediately
 *   useful without any cfg() calls.
 * - Call cfg() to set your preferred defaults. The dashboard user can then
 *   change values at runtime without redeploying.
 * - cfg() returns the CURRENT value: governance > configure() > remote > default.
 * - You only need label/description/ge/le/enum for custom (app-specific) fields.
 *
 * Config priority (highest → lowest):
 *   1. Governance override (set by a rule in the dashboard)
 *   2. Anchor (immutable lock set programmatically)
 *   3. Local override  →  sdk.configure({ temperature: 0.2 })
 *   4. Remote push     →  backend /config endpoint or dashboard slider
 *   5. Default         →  second argument to cfg()
 *
 * Run:
 *   SYRIN_API_KEY=syrin_... npx ts-node examples/02_remote_config.ts
 */

import { init, shutdown, cfg as moduleCfg } from '@syrin/sdk';

async function main() {
  const sdk = await init({
    apiKey: process.env['SYRIN_API_KEY'] ?? '',
    name: 'my-agent',
    url: process.env['SYRIN_URL'] ?? 'https://api.syrin.ai',
  });

  // --- Set your preferred defaults for built-in LLM fields ------------------
  // No label/description needed — the SDK already knows about these fields.
  const model     = sdk.cfg('llm.model',            'gpt-4o');
  const temp      = sdk.cfg('llm.temperature',       0.7);
  const maxTokens = sdk.cfg('llm.max_tokens',        1024);
  const sysPrompt = sdk.cfg('prompt.system_prompt', 'You are a helpful assistant.');

  // Custom app-specific field — provide metadata since the SDK doesn't know it
  const mode = sdk.cfg('agent.mode', 'balanced', {
    label: 'Agent Mode',
    enum: ['fast', 'balanced', 'thorough'],
  });

  // Module-level cfg() — uses the primary SDK instance
  moduleCfg('agent.retry_limit', 3, { label: 'Retry Limit', ge: 0, le: 10 });

  // --- Read and use the current values ---------------------------------------
  console.log('Current config:');
  console.log(`  model       = ${String(model)}`);
  console.log(`  temperature = ${String(temp)}`);
  console.log(`  max_tokens  = ${String(maxTokens)}`);
  console.log(`  mode        = ${String(mode)}`);
  console.log(`  sys_prompt  = ${String(sysPrompt)}`);
  console.log();

  // Use these values when making LLM calls (read at call time to pick up
  // live dashboard changes):
  //
  //   const response = await client.chat.completions.create({
  //     model:       sdk.cfg('llm.model',            'gpt-4o') as string,
  //     temperature: sdk.cfg('llm.temperature',       0.7) as number,
  //     max_tokens:  sdk.cfg('llm.max_tokens',        1024) as number,
  //     messages: [
  //       { role: 'system', content: sdk.cfg('prompt.system_prompt', '...') as string },
  //       { role: 'user',   content: userMessage },
  //     ],
  //   });

  // --- Inspect registered fields (includes SDK built-ins) -------------------
  const ref = sdk.configReference();
  console.log('Registered config fields:');
  for (const [section, fields] of Object.entries(ref)) {
    console.log(`  [${section}]`);
    for (const [name, info] of Object.entries(fields)) {
      console.log(
        `    ${name.padEnd(20)}  current=${String(info.current).padEnd(14)}  ` +
        `default=${String(info.default).padEnd(14)}  source=${info.source}`,
      );
    }
  }

  // --- Local override --------------------------------------------------------
  sdk.configure({ temperature: 0.2 });
  const tempNow = sdk.cfg('llm.temperature', 0.7);
  console.log(`\nAfter configure({ temperature: 0.2 }): temp = ${String(tempNow)}`);

  // --- Push schema to dashboard ---------------------------------------------
  await sdk.refreshSchema();

  await shutdown();
}

main().catch(console.error);
