/**
 * 01 — Quickstart
 * ---------------
 * The complete Syrin SDK integration in under 25 lines of application code.
 *
 * What the SDK does automatically (zero code changes required):
 *   • Intercepts every OpenAI / Anthropic / LangChain call in your process
 *   • Emits LLM_CALL telemetry: tokens, cost, latency, finish reason
 *   • Applies remote config overrides (model, temperature, max_tokens, …)
 *   • Enforces governance actions (stop, inject_message, alert, checkpoint)
 *   • Sends OTel spans to your collector (configure SYRIN_OTEL_EXPORTER)
 *
 * Environment variables:
 *   SYRIN_API_KEY        Your Syrin API key (required)
 *   SYRIN_BACKEND_URL    Override backend URL (default: https://api.syrin.dev)
 *   OPENAI_API_KEY       Your OpenAI key (needed to run the live LLM call)
 *
 * Run:
 *   SYRIN_API_KEY=syrin_... OPENAI_API_KEY=sk-... npx ts-node examples/01_quickstart.ts
 *
 * Or against the local mock backend:
 *   npm run mock-backend &
 *   SYRIN_API_KEY=syrin_test SYRIN_BACKEND_URL=http://localhost:4318 npx ts-node examples/01_quickstart.ts
 */

import { init, shutdown, withSkip, GovernanceStopError, context } from '@syrin/sdk';

async function main() {
  // ── 1. Fail fast if the key is missing ──────────────────────────────────────
  const apiKey = process.env['SYRIN_API_KEY'];
  if (!apiKey) {
    console.error(
      'Error: SYRIN_API_KEY is not set.\n' +
      '  export SYRIN_API_KEY=syrin_test\n' +
      '  Then re-run this script.'
    );
    process.exit(1);
  }

  // ── 2. Init — everything is instrumented from this point on ─────────────────
  //
  //   agentId    → how this service appears in the Syrin dashboard
  //   backendUrl → your Syrin backend (SYRIN_BACKEND_URL env var also works)
  //   governance → opt in to destructive actions (stop, inject_message)
  //
  const sdk = await init({
    apiKey,
    agentId: 'quickstart-agent',
    backendUrl: process.env['SYRIN_BACKEND_URL'] ?? 'https://api.syrin.dev',
    sessionTtlMs: 3_600_000,       // auto-clean sessions older than 1 h
    governance: { allowStop: true, allowInjectMessage: true },
  });

  // Optional: verify backend reachability on startup
  const healthy = await sdk.healthCheck();
  if (!healthy) {
    console.warn('Warning: Syrin backend unreachable. Events will be queued locally.');
  }

  // ── 3. Declare remotely-configurable fields ──────────────────────────────────
  //
  // cfg() registers a field with the dashboard AND returns the current value.
  // The dashboard user can change these sliders without redeploying your code.
  //
  const model     = sdk.cfg('llm.model',            'gpt-4o-mini');
  const temp      = sdk.cfg('llm.temperature',       0.7);
  const maxTokens = sdk.cfg('llm.max_tokens',        1024);
  const sysPrompt = sdk.cfg('prompt.system_prompt', 'You are a helpful assistant.');

  console.log(`Config: model=${String(model)}  temp=${String(temp)}  max_tokens=${String(maxTokens)}`);

  // ── 4. Make LLM calls inside context() ──────────────────────────────────────
  //
  // context() creates a session + agent scope in a single flat call.
  // Everything inside the callback is attributed to this user and agent.
  //
  try {
    const { sessionId } = await sdk.context(
      { userId: 'alice', agent: 'quickstart-agent', window: 'day' },
      async (ctx) => {
        try {
          const { default: OpenAI } = await import('openai') as {
            default: new (opts: { apiKey: string }) => {
              chat: { completions: { create(opts: unknown): Promise<{ choices: Array<{ message: { content: string } }> }> } };
            };
          };
          const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] ?? '' });

          const response = await client.chat.completions.create({
            // Read cfg() at call time — picks up live dashboard changes
            model:       sdk.cfg('llm.model',            'gpt-4o-mini') as string,
            temperature: sdk.cfg('llm.temperature',       0.7) as number,
            max_tokens:  sdk.cfg('llm.max_tokens',        1024) as number,
            messages: [
              { role: 'system', content: sdk.cfg('prompt.system_prompt', 'You are a helpful assistant.') as string },
              { role: 'user',   content: 'Say hello in one sentence.' },
            ],
          });
          console.log('Reply:', response.choices[0].message.content);
        } catch (importErr) {
          if ((importErr as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
            console.log('(openai not installed — npm install openai to run a real LLM call)');
          } else {
            console.error('LLM call failed:', importErr);
          }
        }
        return ctx;
      }
    );
    console.log('Session ID:', sessionId);
  } catch (err) {
    if (err instanceof GovernanceStopError) {
      // The Syrin backend stopped this agent (cost limit, loop detection, etc.)
      // Always catch this so your server returns a clean response.
      console.warn('Agent stopped by governance:', (err as Error).message);
    } else {
      throw err;
    }
  }

  // ── 5. Module-level context() — no sdk reference needed ─────────────────────
  //    Useful in utility modules that don't have access to the sdk instance.
  await context({ agent: 'quickstart-agent' }, async (_ctx) => {
    // any LLM call here is scoped to 'quickstart-agent'
  });

  // ── 6. withSkip() — exclude specific calls from telemetry ───────────────────
  //    Use for health-check pings, PII-scrubbing calls, or any call you want
  //    excluded from the dashboard.
  await withSkip(async () => {
    // any LLM call here is invisible to Syrin
  });

  // ── 7. Shutdown — flush remaining events ─────────────────────────────────────
  await shutdown();
  console.log('Done. Check the Syrin dashboard for your session telemetry.');
}

main().catch(console.error);
