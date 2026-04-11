/**
 * Vercel AI Adapter — Function wrappers
 */

import { withFrameworkContext } from '@/agent/framework-context.js';
import { generateId } from '@/utils/helpers.js';
import type { BaseFrameworkAdapter } from '@/adapters/types.js';

export interface VercelAIAdapterLike extends BaseFrameworkAdapter {
  readonly agentId: string | undefined;
  readonly sessionId: string | undefined;
  getConfig(namespace: string): Record<string, unknown>;
}

interface VercelAIModel {
  modelId?: string;
  provider?: string;
}

export function extractModelInfo(model: unknown): { modelId: string; provider: string } {
  if (model == null) {
    return { modelId: 'unknown', provider: 'unknown' };
  }
  if (typeof model === 'string') {
    return { modelId: model, provider: 'unknown' };
  }
  const m = model as VercelAIModel;
  return {
    modelId: m.modelId ?? 'unknown',
    provider: m.provider ?? 'unknown',
  };
}

function _injectLlmConfig(
  opts: Record<string, unknown>,
  llmCfg: Record<string, unknown>,
): Record<string, unknown> {
  const hasOverrides = Object.values(llmCfg).some((v) => v != null);
  if (!hasOverrides) return opts;

  const result = { ...opts };
  for (const key of ['temperature', 'max_tokens', 'model', 'seed'] as const) {
    if (llmCfg[key] != null) result[key] = llmCfg[key];
  }
  if (llmCfg['top_p'] != null)             result['topP']             = llmCfg['top_p'];
  if (llmCfg['frequency_penalty'] != null) result['frequencyPenalty'] = llmCfg['frequency_penalty'];
  if (llmCfg['presence_penalty'] != null)  result['presencePenalty']  = llmCfg['presence_penalty'];
  if (llmCfg['max_retries'] != null)       result['maxRetries']       = llmCfg['max_retries'];
  if (llmCfg['max_steps'] != null)         result['maxSteps']         = llmCfg['max_steps'];
  return result;
}

export function makeGenerateTextWrapper(
  adapter: VercelAIAdapterLike,
  origFn: (...args: unknown[]) => unknown,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedGenerateText(
    opts: Record<string, unknown>,
    ...rest: unknown[]
  ): Promise<unknown> {
    const { modelId, provider } = extractModelInfo(opts['model']);

    const llmCfg = adapter.getConfig('llm');
    const injectedOpts = _injectLlmConfig(opts, llmCfg);

    const runId = generateId('vairun_');
    const start = Date.now();

    return withFrameworkContext(
      {
        framework: 'vercel-ai',
        agentId: adapter.agentId,
        sessionId: adapter.sessionId ?? 'unknown',
        runId,
        extra: {},
      },
      async () => {
        try {
          const result = (await origFn(injectedOpts, ...rest)) as {
            text?: string;
            usage?: {
              promptTokens?: number;
              completionTokens?: number;
            } | null;
          } | null;

          const usage = result?.usage;
          const inputTokens = usage?.promptTokens ?? 0;
          const outputTokens = usage?.completionTokens ?? 0;

          adapter.emitLlmCallEvent({
            model: modelId,
            provider,
            inputTokens,
            outputTokens,
            durationMs: Date.now() - start,
            error: null,
          });

          return result;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          adapter.emitLlmCallEvent({
            model: modelId,
            provider,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: Date.now() - start,
            error: error.message,
          });
          throw err;
        }
      },
    );
  };
}

export function makeStreamTextWrapper(
  adapter: VercelAIAdapterLike,
  origFn: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  return function patchedStreamText(
    opts: Record<string, unknown>,
    ...rest: unknown[]
  ): unknown {
    const { modelId, provider } = extractModelInfo(opts['model']);

    const llmCfg = adapter.getConfig('llm');
    const injectedOpts = _injectLlmConfig(opts, llmCfg);

    const start = Date.now();

    return withFrameworkContext(
      {
        framework: 'vercel-ai',
        agentId: adapter.agentId,
        sessionId: adapter.sessionId ?? 'unknown',
        runId: generateId('vairun_'),
        extra: {},
      },
      () => {
        const streamResult = origFn(injectedOpts, ...rest) as {
          textStream: AsyncIterable<string>;
          usage: Promise<{
            promptTokens?: number;
            completionTokens?: number;
          } | null | undefined>;
        };

        const wrappedUsage: Promise<unknown> = streamResult.usage.then(
          (usage) => {
            const inputTokens = usage?.promptTokens ?? 0;
            const outputTokens = usage?.completionTokens ?? 0;
            adapter.emitLlmCallEvent({
              model: modelId,
              provider,
              inputTokens,
              outputTokens,
              durationMs: Date.now() - start,
              error: null,
            });
            return usage;
          },
          (err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            adapter.emitLlmCallEvent({
              model: modelId,
              provider,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: Date.now() - start,
              error: error.message,
            });
            throw err;
          },
        );

        return {
          ...streamResult,
          usage: wrappedUsage,
        };
      },
    );
  };
}

export function makeGenerateObjectWrapper(
  adapter: VercelAIAdapterLike,
  origFn: (...args: unknown[]) => unknown,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedGenerateObject(
    opts: Record<string, unknown>,
    ...rest: unknown[]
  ): Promise<unknown> {
    const { modelId, provider } = extractModelInfo(opts['model']);

    const llmCfg = adapter.getConfig('llm');
    const injectedOpts = _injectLlmConfig(opts, llmCfg);

    const runId = generateId('vairun_');
    const start = Date.now();

    return withFrameworkContext(
      {
        framework: 'vercel-ai',
        agentId: adapter.agentId,
        sessionId: adapter.sessionId ?? 'unknown',
        runId,
        extra: {},
      },
      async () => {
        try {
          const result = (await origFn(injectedOpts, ...rest)) as {
            object?: unknown;
            usage?: {
              promptTokens?: number;
              completionTokens?: number;
            } | null;
          } | null;

          const usage = result?.usage;
          const inputTokens = usage?.promptTokens ?? 0;
          const outputTokens = usage?.completionTokens ?? 0;

          adapter.emitLlmCallEvent({
            model: modelId,
            provider,
            inputTokens,
            outputTokens,
            durationMs: Date.now() - start,
            error: null,
            operation: 'generateObject',
          });

          return result;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          adapter.emitLlmCallEvent({
            model: modelId,
            provider,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: Date.now() - start,
            error: error.message,
            operation: 'generateObject',
          });
          throw err;
        }
      },
    );
  };
}
