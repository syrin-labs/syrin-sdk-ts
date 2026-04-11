/**
 * LangChain Adapter — Adapter class and wrap() method
 */

import { generateId, nowIso } from '@/utils/helpers.js';
import { withFrameworkContext } from '@/agent/framework-context.js';
import type { FrameworkContext } from '@/agent/framework-context.js';
import { SyrinSDKBaseFrameworkAdapter } from '@/adapters/types.js';
import type { ISyrinCore, SchemaField } from '@/adapters/types.js';
import { SyrinLangChainCallback } from './callback.js';
import { patchBaseChatModel, unpatchBaseChatModel } from './patch-llm.js';

interface RunnableLike {
  name?: string;
  invoke(...args: unknown[]): unknown;
  ainvoke?(...args: unknown[]): Promise<unknown>;
  [key: string]: unknown;
}

export class LangChainAdapter extends SyrinSDKBaseFrameworkAdapter {
  readonly name = 'langchain';

  override configSchema(): Record<string, SchemaField[]> {
    return {
      llm: [
        { name: 'model',             type: 'str',   default: null },
        { name: 'temperature',       type: 'float', default: null, constraints: { ge: 0.0, le: 2.0 } },
        { name: 'max_tokens',        type: 'int',   default: null, constraints: { ge: 1 } },
        { name: 'top_p',             type: 'float', default: null, constraints: { ge: 0.0, le: 1.0 } },
        { name: 'frequency_penalty', type: 'float', default: null, constraints: { ge: -2.0, le: 2.0 } },
        { name: 'presence_penalty',  type: 'float', default: null, constraints: { ge: -2.0, le: 2.0 } },
        { name: 'seed',              type: 'int',   default: null },
      ],
    };
  }

  protected async _doInstall(_core: ISyrinCore): Promise<void> {
    await patchBaseChatModel(this);
  }

  protected _doUninstall(): void {
    unpatchBaseChatModel();
  }

  callbackHandler(chainName = 'langchain'): SyrinLangChainCallback {
    return new SyrinLangChainCallback(this, chainName);
  }

  wrap<T extends RunnableLike>(
    chain: T,
    options?: { chainName?: string },
  ): T & { ainvoke(...args: unknown[]): Promise<unknown> } {
    const adapter = this;
    const chainName =
      options?.chainName ?? (chain.name) ?? 'langchain';

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
            const enrichedConfig = adapter._buildConfig(config);
            const runId = generateId('lcrun_');
            const ctx: FrameworkContext = {
              framework: 'langchain',
              agentId: adapter.agentId,
              sessionId: adapter.sessionId ?? 'unknown',
              runId,
              extra: {},
            };
            const start = Date.now();
            return withFrameworkContext(ctx, async () => {
              try {
                const result = await (originalInvoke(inputs, enrichedConfig, ...rest) as Promise<unknown>);
                adapter.emitEvent({
                  event_id: generateId('evt_'),
                  event_type: 'CHAIN_EXECUTION',
                  timestamp: nowIso(),
                  session_id: adapter.sessionId,
                  agent_id: adapter.agentId,
                  chain_run_id: runId,
                  chain_name: chainName,
                  duration_ms: Date.now() - start,
                  error: null,
                  framework: 'langchain',
                });
                return result;
              } catch (err) {
                adapter.emitEvent({
                  event_id: generateId('evt_'),
                  event_type: 'CHAIN_EXECUTION',
                  timestamp: nowIso(),
                  session_id: adapter.sessionId,
                  agent_id: adapter.agentId,
                  chain_run_id: runId,
                  chain_name: chainName,
                  duration_ms: Date.now() - start,
                  error: err instanceof Error ? err.message : String(err),
                  framework: 'langchain',
                });
                throw err;
              }
            });
          };
        }

        if (prop === 'ainvoke') {
          return async function (
            inputs: unknown,
            config?: Record<string, unknown>,
            ...rest: unknown[]
          ): Promise<unknown> {
            const enrichedConfig = adapter._buildConfig(config);
            const runId = generateId('lcrun_');
            const ctx: FrameworkContext = {
              framework: 'langchain',
              agentId: adapter.agentId,
              sessionId: adapter.sessionId ?? 'unknown',
              runId,
              extra: {},
            };
            const start = Date.now();
            return withFrameworkContext(ctx, async () => {
              try {
                const result = await originalAInvoke(inputs, enrichedConfig, ...rest);
                adapter.emitEvent({
                  event_id: generateId('evt_'),
                  event_type: 'CHAIN_EXECUTION',
                  timestamp: nowIso(),
                  session_id: adapter.sessionId,
                  agent_id: adapter.agentId,
                  chain_run_id: runId,
                  chain_name: chainName,
                  duration_ms: Date.now() - start,
                  error: null,
                  framework: 'langchain',
                });
                return result;
              } catch (err) {
                adapter.emitEvent({
                  event_id: generateId('evt_'),
                  event_type: 'CHAIN_EXECUTION',
                  timestamp: nowIso(),
                  session_id: adapter.sessionId,
                  agent_id: adapter.agentId,
                  chain_run_id: runId,
                  chain_name: chainName,
                  duration_ms: Date.now() - start,
                  error: err instanceof Error ? err.message : String(err),
                  framework: 'langchain',
                });
                throw err;
              }
            });
          };
        }

        return (target as Record<string | symbol, unknown>)[prop];
      },
    }) as T & { ainvoke(...args: unknown[]): Promise<unknown> };
  }

  _buildConfig(
    config: Record<string, unknown> | undefined,
    handler?: SyrinLangChainCallback,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...(config ?? {}) };

    // Optionally merge a callback handler
    if (handler) {
      const existing = Array.isArray(result['callbacks'])
        ? (result['callbacks'] as unknown[])
        : [];
      result['callbacks'] = [...existing, handler];
    }

    // Inject LLM config updates via `configurable` (LangChain reads these)
    const llmCfg = this.getConfig('llm');
    const llmKeys = ['temperature', 'max_tokens', 'model', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'] as const;
    const hasLlmUpdates = llmKeys.some((k) => llmCfg[k] != null);

    if (hasLlmUpdates) {
      const configurable: Record<string, unknown> = {
        ...((result['configurable'] as Record<string, unknown>) ?? {}),
      };
      for (const key of llmKeys) {
        if (llmCfg[key] != null) {
          configurable[key] = llmCfg[key];
        }
      }
      result['configurable'] = configurable;
    }

    return result;
  }
}
