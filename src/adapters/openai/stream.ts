/**
 * OpenAI Adapter — Stream wrapper logic
 */

import type { ISyrinCore, BeforeCallResult, NormalizedCallParams, NormalizedCallResult } from '@/adapters/types.js';

export function wrapOpenAIStream(
  stream: AsyncIterable<Record<string, unknown>>,
  ctx: BeforeCallResult,
  normalizedParams: NormalizedCallParams,
  startTime: number,
  core: ISyrinCore,
): unknown {
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = 'stop';
  let actualModel = (ctx.modifiedRaw['model'] as string | undefined) ?? normalizedParams.model;
  const contentChunks: string[] = [];
  let ttftMs: number | undefined;

  const streamWithIter = stream as AsyncIterable<Record<string, unknown>> & {
    [key: string | symbol]: unknown;
  };
  const originalIterator = streamWithIter[Symbol.asyncIterator].bind(streamWithIter) as () => AsyncIterator<Record<string, unknown>>;

  const wrappedIterator = async function* (): AsyncGenerator<Record<string, unknown>> {
    try {
      for await (const chunk of { [Symbol.asyncIterator]: originalIterator }) {
        if (ttftMs === undefined) {
          ttftMs = Date.now() - startTime;
        }
        if (chunk['model']) actualModel = chunk['model'] as string;
        const choices = chunk['choices'] as Array<{ delta?: { content?: string }; finish_reason?: string }> | undefined;
        const delta = choices?.[0]?.delta;
        if (delta?.content) contentChunks.push(delta.content);
        const chunkFinish = choices?.[0]?.finish_reason;
        if (chunkFinish) finishReason = chunkFinish;
        const usage = chunk['usage'] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (usage) {
          inputTokens = usage.prompt_tokens ?? inputTokens;
          outputTokens = usage.completion_tokens ?? outputTokens;
        }
        yield chunk;
      }
    } finally {
      const durationMs = Date.now() - startTime;
      const responseText = core.config.captureContent ? contentChunks.join('') : undefined;

      const result: NormalizedCallResult = {
        model: actualModel,
        inputTokens,
        outputTokens,
        finishReason,
        durationMs,
        stream: true,
        responseText,
        ttftMs,
      };

      core.onStreamComplete(ctx, normalizedParams, result);
    }
  };

  return new Proxy(streamWithIter, {
    get(target, prop: string | symbol) {
      if (prop === Symbol.asyncIterator) return wrappedIterator;
      const val = target[prop];
      if (typeof val === 'function') return (val as (...a: unknown[]) => unknown).bind(target);
      return val;
    },
  });
}
