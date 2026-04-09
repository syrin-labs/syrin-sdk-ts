/**
 * Syrin SDK — LangChain Adapter (TypeScript)
 *
 * Instruments LangChain.js chains and runnables with Syrin observability
 * and remote config injection.
 *
 * Two integration modes:
 *
 * 1. Callback handler (manual):
 *    const handler = adapter.callbackHandler();
 *    const result = await chain.invoke(input, { callbacks: [handler] });
 *
 * 2. Chain wrapping (automatic, recommended):
 *    const wrapped = adapter.wrap(chain);
 *    const result = await wrapped.invoke(input);
 *    // Callbacks + config injection handled automatically
 *
 * Emits:
 *   CHAIN_EXECUTION — one per chain.invoke() / ainvoke() call
 *   LLM_CALL events are emitted by Tier 1 (OpenAI/Anthropic adapter),
 *   enriched with framework="langchain" via FrameworkContext.
 *
 * Integration:
 *   import { init } from "@syrin/sdk";
 *   import { LangChainAdapter } from "@syrin/sdk/adapters";
 *   const adapter = new LangChainAdapter();
 *   init({ apiKey: "...", adapters: [adapter] });
 *
 * Duck-typed callbacks — no hard dependency on @langchain/core.
 * This enables testing without the library installed.
 */

import { generateId, nowIso } from '@/utils';
import { withFrameworkContext } from '@/framework-context';
import type { FrameworkContext } from '@/framework-context';
import { BaseFrameworkAdapter } from '@/adapters/types';
import type { ISyrinCore } from '@/adapters/types';

// ---------------------------------------------------------------------------
// SyrinLangChainCallback — duck-typed callback handler
// ---------------------------------------------------------------------------

/**
 * A LangChain-compatible callback handler (duck-typed — no @langchain/core dep).
 * Tracks chain execution timing and emits CHAIN_EXECUTION events via the adapter.
 *
 * Usage:
 *   const handler = adapter.callbackHandler('my_chain');
 *   await chain.invoke(input, { callbacks: [handler] });
 */
export class SyrinLangChainCallback {
  private readonly _adapter: LangChainAdapter;
  private readonly _chainName: string;
  private _runId: string | null = null;
  private _startTime = 0;

  constructor(adapter: LangChainAdapter, chainName = 'langchain') {
    this._adapter = adapter;
    this._chainName = chainName;
  }

  onChainStart(
    _serialized: unknown,
    _inputs: unknown,
    options?: { runId?: string },
  ): void {
    this._runId = options?.runId ?? generateId('lcrun_');
    this._startTime = Date.now();
  }

  onChainEnd(_outputs: unknown, _options?: unknown): void {
    const durationMs = Date.now() - this._startTime;
    this._adapter.emitEvent({
      eventId: generateId('evt_'),
      eventType: 'CHAIN_EXECUTION',
      timestamp: nowIso(),
      chainRunId: this._runId,
      chainName: this._chainName,
      durationMs,
      error: null,
      framework: 'langchain',
    });
  }

  onChainError(error: Error | unknown, _options?: unknown): void {
    const durationMs = Date.now() - this._startTime;
    this._adapter.emitEvent({
      eventId: generateId('evt_'),
      eventType: 'CHAIN_EXECUTION',
      timestamp: nowIso(),
      chainRunId: this._runId,
      chainName: this._chainName,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
      framework: 'langchain',
    });
  }

  // Stub handlers — LLM_CALL telemetry is handled by the Tier 1 adapter
  onLlmStart(_serialized: unknown, _prompts: unknown, _options?: unknown): void {}
  onLlmEnd(_response: unknown, _options?: unknown): void {}
  onLlmError(_error: unknown, _options?: unknown): void {}
}

// ---------------------------------------------------------------------------
// Minimal runnable type — duck-typed, no @langchain/core dep
// ---------------------------------------------------------------------------

interface RunnableLike {
  name?: string;
  invoke(...args: unknown[]): unknown;
  ainvoke?(...args: unknown[]): Promise<unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// LangChainAdapter
// ---------------------------------------------------------------------------

/**
 * Syrin adapter for LangChain.js.
 *
 * Does not globally monkey-patch LangChain. Instead it provides:
 *   - callbackHandler(): returns a SyrinLangChainCallback for manual use
 *   - wrap(chain): returns a Proxy that auto-injects the callback and
 *     runs the invoke inside a FrameworkContext
 */
export class LangChainAdapter extends BaseFrameworkAdapter {
  readonly name = 'langchain';

  protected _doInstall(_core: ISyrinCore): void {
    // No global patching — callback-based approach, nothing to patch
  }

  protected _doUninstall(): void {
    // Nothing to clean up globally
  }

  /**
   * Create a new callback handler instance for a given chain name.
   * Use this for manual integration:
   *   const handler = adapter.callbackHandler('my_chain');
   *   await chain.invoke(input, { callbacks: [handler] });
   */
  callbackHandler(chainName = 'langchain'): SyrinLangChainCallback {
    return new SyrinLangChainCallback(this, chainName);
  }

  /**
   * Wrap a LangChain Runnable (or any object with invoke / ainvoke) so that:
   *  1. Every invoke / ainvoke call is wrapped in a FrameworkContext.
   *  2. A SyrinLangChainCallback is injected automatically.
   *  3. LLM config from the 'llm' config section is propagated via `configurable`.
   *
   * All other properties are transparently proxied.
   */
  wrap<T extends RunnableLike>(
    chain: T,
    options?: { chainName?: string },
  ): T & { ainvoke(...args: unknown[]): Promise<unknown> } {
    const adapter = this;
    const chainName =
      options?.chainName ?? (chain.name as string | undefined) ?? 'langchain';

    const originalInvoke = chain.invoke.bind(chain) as (...args: unknown[]) => unknown;
    const originalAInvoke = (chain.ainvoke?.bind(chain) ?? originalInvoke) as (
      ...args: unknown[]
    ) => Promise<unknown>;

    return new Proxy(chain, {
      get(target: T, prop: string | symbol) {
        if (prop === 'invoke') {
          return async function (
            inputs: unknown,
            config?: Record<string, unknown>,
            ...rest: unknown[]
          ): Promise<unknown> {
            const handler = adapter.callbackHandler(chainName);
            const enrichedConfig = adapter._buildConfig(config, handler);
            const runId = generateId('lcrun_');
            const ctx: FrameworkContext = {
              framework: 'langchain',
              agentId: adapter.agentId,
              sessionId: adapter.sessionId ?? 'unknown',
              runId,
              extra: {},
            };
            return withFrameworkContext(ctx, () =>
              originalInvoke(inputs, enrichedConfig, ...rest) as Promise<unknown>,
            );
          };
        }

        if (prop === 'ainvoke') {
          return async function (
            inputs: unknown,
            config?: Record<string, unknown>,
            ...rest: unknown[]
          ): Promise<unknown> {
            const handler = adapter.callbackHandler(chainName);
            const enrichedConfig = adapter._buildConfig(config, handler);
            const runId = generateId('lcrun_');
            const ctx: FrameworkContext = {
              framework: 'langchain',
              agentId: adapter.agentId,
              sessionId: adapter.sessionId ?? 'unknown',
              runId,
              extra: {},
            };
            return withFrameworkContext(ctx, () =>
              originalAInvoke(inputs, enrichedConfig, ...rest),
            );
          };
        }

        return (target as Record<string | symbol, unknown>)[prop];
      },
    }) as T & { ainvoke(...args: unknown[]): Promise<unknown> };
  }

  /**
   * Build the merged config object: injects the Syrin callback and any
   * pending LLM config updates (temperature, max_tokens, model) via `configurable`.
   *
   * @param config   Original config passed by user code (may be undefined).
   * @param handler  The SyrinLangChainCallback instance to inject.
   */
  _buildConfig(
    config: Record<string, unknown> | undefined,
    handler: SyrinLangChainCallback,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...(config ?? {}) };

    // Merge callbacks
    const existing = Array.isArray(result['callbacks'])
      ? (result['callbacks'] as unknown[])
      : [];
    result['callbacks'] = [...existing, handler];

    // Inject LLM config updates via `configurable` (LangChain reads these)
    const llmCfg = this.getConfig('llm');
    const hasLlmUpdates = (['temperature', 'max_tokens', 'model'] as const).some(
      (k) => llmCfg[k] != null,
    );

    if (hasLlmUpdates) {
      const configurable: Record<string, unknown> = {
        ...((result['configurable'] as Record<string, unknown>) ?? {}),
      };
      for (const key of ['temperature', 'max_tokens', 'model'] as const) {
        if (llmCfg[key] != null) {
          configurable[key] = llmCfg[key];
        }
      }
      result['configurable'] = configurable;
    }

    return result;
  }
}
