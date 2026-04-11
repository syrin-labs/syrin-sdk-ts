/**
 * Mastra Adapter — Generate and stream wrappers
 */

import { withFrameworkContext } from '@/agent/framework-context.js';
import { generateId } from '@/utils/helpers.js';
import type { BaseFrameworkAdapter } from '@/adapters/types.js';
import { extractModelInfo } from './adapter.js';

export interface MastraAdapterLike extends BaseFrameworkAdapter {
  readonly agentId: string | undefined;
  readonly sessionId: string | undefined;
  readonly captureContent: boolean;
  getConfig(namespace: string): Record<string, unknown>;
}

export function makeGenerateWrapper(
  adapter: MastraAdapterLike,
  origFn: (...args: unknown[]) => unknown,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedGenerate(
    this: Record<string, unknown>,
    prompt: unknown,
    opts?: Record<string, unknown>,
    ...rest: unknown[]
  ): Promise<unknown> {
    const agentName = typeof this['name'] === 'string' ? this['name'] : 'unknown';
    const { modelId, provider } = extractModelInfo(this['model']);

    const llmCfg = adapter.getConfig('llm');
    const mastraCfg = adapter.getConfig('mastra');
    const injectedOpts = _injectLlmConfig(opts, llmCfg, mastraCfg);

    const runId = generateId('mrun_');
    const start = Date.now();

    return withFrameworkContext(
      {
        framework: 'mastra',
        agentId: adapter.agentId,
        sessionId: adapter.sessionId ?? 'unknown',
        runId,
        extra: { agentName },
      },
      async () => {
        try {
          const result = (await origFn.call(this, prompt, injectedOpts, ...rest)) as {
            text?: string;
            usage?: {
              promptTokens?: number;
              completionTokens?: number;
              totalTokens?: number;
            } | null;
          } | null;

          const usage = result?.usage as Record<string, number> | null | undefined;
          const inputTokens = (usage?.['inputTokens'] ?? usage?.['promptTokens']) ?? 0;
          const outputTokens = (usage?.['outputTokens'] ?? usage?.['completionTokens']) ?? 0;

          // Build prompt messages for content capture
          const promptMsg: Array<{ role: string; content: string }> = [];
          if (typeof prompt === 'string') promptMsg.push({ role: 'user', content: prompt });

          adapter.emitLlmCallEvent({
            agentName,
            model: modelId,
            provider,
            inputTokens,
            outputTokens,
            durationMs: Date.now() - start,
            error: null,
            promptMessages: promptMsg.length > 0 ? promptMsg : undefined,
            completionText: result?.text,
          });

          return result;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          adapter.emitLlmCallEvent({
            agentName,
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

export function makeStreamWrapper(
  adapter: MastraAdapterLike,
  origFn: (...args: unknown[]) => unknown,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedStream(
    this: Record<string, unknown>,
    prompt: unknown,
    opts?: Record<string, unknown>,
    ...rest: unknown[]
  ): Promise<unknown> {
    const agentName = typeof this['name'] === 'string' ? this['name'] : 'unknown';
    const { modelId, provider } = extractModelInfo(this['model']);

    const llmCfg = adapter.getConfig('llm');
    const mastraCfg = adapter.getConfig('mastra');
    const injectedOpts = _injectLlmConfig(opts, llmCfg, mastraCfg);

    const start = Date.now();

    const streamResult = (await Promise.resolve(
      origFn.call(this, prompt, injectedOpts, ...rest),
    )) as Record<string, unknown>;

    if (streamResult && typeof streamResult === 'object' && 'textStream' in streamResult) {
      const originalTextStream = streamResult['textStream'] as AsyncIterable<string>;

      async function* patchedTextStream(): AsyncGenerator<string> {
        try {
          for await (const chunk of originalTextStream) {
            yield chunk;
          }
          const usageRaw = await Promise.resolve(streamResult['usage']);
          const usage = usageRaw as Record<string, number> | null | undefined;
          const inputTokens = (usage?.['inputTokens'] ?? usage?.['promptTokens']) ?? 0;
          const outputTokens = (usage?.['outputTokens'] ?? usage?.['completionTokens']) ?? 0;
          adapter.emitLlmCallEvent({
            agentName,
            model: modelId,
            provider,
            inputTokens,
            outputTokens,
            durationMs: Date.now() - start,
            error: null,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          adapter.emitLlmCallEvent({
            agentName,
            model: modelId,
            provider,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: Date.now() - start,
            error: error.message,
          });
          throw err;
        }
      }

      return { ...streamResult, textStream: patchedTextStream() };
    }

    const asyncIter = (streamResult as unknown as AsyncIterable<unknown>)?.[Symbol.asyncIterator];
    if (typeof asyncIter !== 'function') {
      adapter.emitLlmCallEvent({
        agentName, model: modelId, provider,
        inputTokens: 0, outputTokens: 0,
        durationMs: Date.now() - start, error: null,
      });
      return streamResult;
    }

    async function* wrappedIterable(): AsyncGenerator<unknown> {
      try {
        for await (const chunk of streamResult as unknown as AsyncIterable<unknown>) {
          yield chunk;
        }
        adapter.emitLlmCallEvent({
          agentName, model: modelId, provider,
          inputTokens: 0, outputTokens: 0,
          durationMs: Date.now() - start, error: null,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        adapter.emitLlmCallEvent({
          agentName, model: modelId, provider,
          inputTokens: 0, outputTokens: 0,
          durationMs: Date.now() - start, error: error.message,
        });
        throw err;
      }
    }

    return wrappedIterable();
  };
}

function _injectLlmConfig(
  opts: Record<string, unknown> | undefined,
  llmCfg: Record<string, unknown>,
  mastraCfg: Record<string, unknown> = {},
): Record<string, unknown> {
  const result = { ...(opts ?? {}) };

  // LLM params
  for (const key of ['temperature', 'model', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'] as const) {
    if (llmCfg[key] != null) result[key] = llmCfg[key];
  }
  if (llmCfg['max_tokens'] != null) result['maxTokens'] = llmCfg['max_tokens'];

  // Mastra-specific params
  if (mastraCfg['max_steps'] != null) result['maxSteps'] = mastraCfg['max_steps'];
  if (mastraCfg['max_retries'] != null) result['maxRetries'] = mastraCfg['max_retries'];

  return result;
}
