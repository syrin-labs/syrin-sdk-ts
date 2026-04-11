/**
 * Vercel AI Adapter — Function wrappers
 */

import { withFrameworkContext } from '@/agent/framework-context.js';
import { generateId } from '@/utils/helpers.js';
import type { BaseFrameworkAdapter } from '@/adapters/types.js';

export interface VercelAIAdapterLike extends BaseFrameworkAdapter {
  readonly agentId: string | undefined;
  readonly sessionId: string | undefined;
  readonly captureContent: boolean;
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
  vercelCfg: Record<string, unknown> = {},
): Record<string, unknown> {
  const result = { ...opts };

  // LLM params (snake_case → camelCase where Vercel AI expects it)
  for (const key of ['temperature', 'model', 'seed'] as const) {
    if (llmCfg[key] != null) result[key] = llmCfg[key];
  }
  if (llmCfg['max_tokens'] != null)        result['maxTokens']        = llmCfg['max_tokens'];
  if (llmCfg['top_p'] != null)             result['topP']             = llmCfg['top_p'];
  if (llmCfg['frequency_penalty'] != null) result['frequencyPenalty'] = llmCfg['frequency_penalty'];
  if (llmCfg['presence_penalty'] != null)  result['presencePenalty']  = llmCfg['presence_penalty'];

  // Vercel-specific params
  if (vercelCfg['max_steps'] != null)   result['maxSteps']   = vercelCfg['max_steps'];
  if (vercelCfg['max_retries'] != null) result['maxRetries'] = vercelCfg['max_retries'];
  if (vercelCfg['abort_after_ms'] != null && Number(vercelCfg['abort_after_ms']) > 0) {
    result['abortSignal'] = AbortSignal.timeout(Number(vercelCfg['abort_after_ms']));
  }

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
    const vercelCfg = adapter.getConfig('vercel');
    const injectedOpts = _injectLlmConfig(opts, llmCfg, vercelCfg);

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
              inputTokens?: number;
              outputTokens?: number;
            } | null;
          } | null;

          const usage = result?.usage as Record<string, number> | null | undefined;
          // Support both legacy (promptTokens/completionTokens) and new Responses API (inputTokens/outputTokens)
          const inputTokens = usage?.['inputTokens'] ?? usage?.['promptTokens'] ?? 0;
          const outputTokens = usage?.['outputTokens'] ?? usage?.['completionTokens'] ?? 0;

          // Build prompt messages for content capture
          const promptMessages: Array<{ role: string; content: string }> = [];
          if (injectedOpts['system']) promptMessages.push({ role: 'system', content: String(injectedOpts['system']) });
          if (injectedOpts['prompt']) promptMessages.push({ role: 'user', content: String(injectedOpts['prompt']) });
          if (Array.isArray(injectedOpts['messages'])) {
            for (const m of injectedOpts['messages'] as Array<{ role: string; content: string }>) {
              promptMessages.push({ role: m.role, content: String(m.content) });
            }
          }

          adapter.emitLlmCallEvent({
            model: modelId,
            provider,
            inputTokens,
            outputTokens,
            durationMs: Date.now() - start,
            error: null,
            promptMessages: promptMessages.length > 0 ? promptMessages : undefined,
            completionText: result?.text,
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
    const vercelCfg = adapter.getConfig('vercel');
    const injectedOpts = _injectLlmConfig(opts, llmCfg, vercelCfg);

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
            inputTokens?: number;
            outputTokens?: number;
          } | null | undefined>;
        };

        const wrappedUsage: Promise<unknown> = streamResult.usage.then(
          (usage) => {
            const u = usage as Record<string, number> | null | undefined;
            const inputTokens = u?.['inputTokens'] ?? u?.['promptTokens'] ?? 0;
            const outputTokens = u?.['outputTokens'] ?? u?.['completionTokens'] ?? 0;
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
    const vercelCfg = adapter.getConfig('vercel');
    const injectedOpts = _injectLlmConfig(opts, llmCfg, vercelCfg);

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
              inputTokens?: number;
              outputTokens?: number;
            } | null;
          } | null;

          const usage = result?.usage as Record<string, number> | null | undefined;
          const inputTokens = usage?.['inputTokens'] ?? usage?.['promptTokens'] ?? 0;
          const outputTokens = usage?.['outputTokens'] ?? usage?.['completionTokens'] ?? 0;

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
