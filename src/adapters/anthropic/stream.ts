/**
 * Anthropic Adapter — Stream accumulator and wrapper
 */

import type { ISyrinCore, BeforeCallResult, NormalizedCallParams, NormalizedCallResult } from '@/adapters/types.js';

export function wrapAnthropicStream(
  stream: AsyncIterable<Record<string, unknown>>,
  ctx: BeforeCallResult,
  normalizedParams: NormalizedCallParams,
  startTime: number,
  core: ISyrinCore,
): unknown {
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = 'end_turn';
  let actualModel =
    (ctx.modifiedRaw['model'] as string | undefined) ?? normalizedParams.model;
  const contentChunks: string[] = [];

  const streamWithIter = stream as AsyncIterable<Record<string, unknown>> & {
    [key: string | symbol]: unknown;
  };

  const originalIterator = streamWithIter[Symbol.asyncIterator].bind(
    streamWithIter,
  ) as () => AsyncIterator<Record<string, unknown>>;

  const wrappedIterator = async function* (): AsyncGenerator<Record<string, unknown>> {
    try {
      for await (const chunk of { [Symbol.asyncIterator]: originalIterator }) {
        const type = chunk['type'] as string | undefined;

        if (type === 'message_start') {
          const msg = chunk['message'] as {
            model?: string;
            usage?: { input_tokens?: number };
          } | undefined;
          if (msg?.model) actualModel = msg.model;
          if (msg?.usage?.input_tokens != null) {
            inputTokens = msg.usage.input_tokens;
          }
        } else if (type === 'content_block_delta') {
          const delta = chunk['delta'] as {
            type?: string;
            text?: string;
          } | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            contentChunks.push(delta.text);
          }
        } else if (type === 'message_delta') {
          const delta = chunk['delta'] as { stop_reason?: string } | undefined;
          if (delta?.stop_reason) finishReason = delta.stop_reason;
          const usage = chunk['usage'] as { output_tokens?: number } | undefined;
          if (usage?.output_tokens != null) {
            outputTokens = usage.output_tokens;
          }
        }

        yield chunk;
      }
    } finally {
      const durationMs = Date.now() - startTime;
      const responseText = core.config.captureContent
        ? contentChunks.join('')
        : undefined;

      const result: NormalizedCallResult = {
        model: actualModel,
        inputTokens,
        outputTokens,
        finishReason,
        durationMs,
        stream: true,
        responseText,
      };

      core.onStreamComplete(ctx, normalizedParams, result);
    }
  };

  return new Proxy(streamWithIter, {
    get(target, prop: string | symbol) {
      if (prop === Symbol.asyncIterator) return wrappedIterator;
      const val = target[prop];
      if (typeof val === 'function')
        return (val as (...a: unknown[]) => unknown).bind(target);
      return val;
    },
  });
}
