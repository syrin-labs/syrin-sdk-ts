/**
 * OpenAI Adapter — Parameter normalization and result extraction
 */

import type { NormalizedCallParams, NormalizedCallResult } from '@/adapters/types.js';

export function normalizeOpenAIParams(params: Record<string, unknown>): NormalizedCallParams {
  return {
    model: (params['model'] as string) ?? 'gpt-4o',
    messages: (params['messages'] as Array<{ role: string; content?: unknown }> | undefined ?? []).map((m) => ({
      role: m.role ?? '',
      content: m.content,
    })),
    temperature: params['temperature'] as number | undefined,
    max_tokens: params['max_tokens'] as number | undefined,
    stream: params['stream'] === true,
    tools: params['tools']
      ? (params['tools'] as Array<{ function?: { name?: string; parameters?: unknown } }>).map((t) => ({
          name: t?.function?.name,
          parameters: t?.function?.parameters,
        }))
      : undefined,
    raw: { ...params },
  };
}

export function extractOpenAIResult(
  response: Record<string, unknown>,
  modifiedRaw: Record<string, unknown>,
  durationMs: number,
  stream: boolean,
  captureContent?: boolean,
): NormalizedCallResult {
  const actualModel: string = (response['model'] as string) ?? (modifiedRaw['model'] as string) ?? 'unknown';
  const usage = (response['usage'] as { prompt_tokens?: number; completion_tokens?: number }) ?? {};
  const inputTokens: number = usage.prompt_tokens ?? 0;
  const outputTokens: number = usage.completion_tokens ?? 0;

  const choices = response['choices'] as Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
    };
  }> | undefined;

  const finishReason: string = choices?.[0]?.finish_reason ?? 'stop';
  const responseText = captureContent ? choices?.[0]?.message?.content : undefined;

  const rawToolCalls = choices?.[0]?.message?.tool_calls ?? [];
  const toolCalls = rawToolCalls.length > 0
    ? rawToolCalls.map((tc) => ({
        id: tc.id,
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '',
      }))
    : undefined;

  const rawTools = modifiedRaw['tools'] as Array<{ function?: { name?: string; parameters?: unknown } }> | undefined;
  const toolDefinitions = Array.isArray(rawTools) && rawTools.length > 0
    ? rawTools.map((t) => ({
        name: t?.function?.name,
        parameters: t?.function?.parameters,
      }))
    : undefined;

  return {
    model: actualModel,
    inputTokens,
    outputTokens,
    finishReason,
    durationMs,
    toolCalls,
    toolDefinitions,
    responseText,
    stream,
  };
}

export function _estimateInputTokens(messages: unknown[]): number {
  // Rough estimate: ~4 chars per token
  let total = 0;
  for (const msg of messages) {
    const content = (msg as Record<string, unknown>)['content'];
    if (typeof content === 'string') {
      total += Math.ceil(content.length / 4);
    }
  }
  return total;
}
