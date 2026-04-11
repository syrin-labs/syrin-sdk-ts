/**
 * Anthropic Adapter — Parameter normalization and result extraction
 */

import type { NormalizedCallParams, NormalizedCallResult } from '@/adapters/types.js';

export function normalizeAnthropicParams(params: Record<string, unknown>, provider: string): NormalizedCallParams {
  const messages = (
    params['messages'] as Array<{ role: string; content?: unknown }> | undefined ?? []
  ).map((m) => ({
    role: m.role ?? '',
    content: m.content,
  }));

  const rawTools = params['tools'] as Array<{
    name?: string;
    description?: string;
    input_schema?: unknown;
  }> | undefined;

  const tools = rawTools
    ? rawTools.map((t) => ({
        name: t?.name,
        parameters: t?.input_schema,
      }))
    : undefined;

  return {
    model: (params['model'] as string) ?? 'claude-3-5-sonnet-20241022',
    messages,
    temperature: params['temperature'] as number | undefined,
    max_tokens: params['max_tokens'] as number | undefined,
    stream: params['stream'] === true,
    tools,
    raw: { ...params, _syrin_provider: provider },
  };
}

export function extractAnthropicResult(
  response: Record<string, unknown>,
  modifiedRaw: Record<string, unknown>,
  durationMs: number,
  stream: boolean,
  captureContent?: boolean,
): NormalizedCallResult {
  const actualModel =
    (response['model'] as string | undefined) ??
    (modifiedRaw['model'] as string | undefined) ??
    'unknown';

  const usage = (response['usage'] as { input_tokens?: number; output_tokens?: number }) ?? {};
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const finishReason = (response['stop_reason'] as string | undefined) ?? 'end_turn';

  const content = response['content'] as Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }> | undefined;

  // Extract text response
  const responseText = captureContent
    ? content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
    : undefined;

  // Extract tool calls from content blocks of type "tool_use"
  const rawToolCalls = (content ?? []).filter((b) => b.type === 'tool_use');
  const toolCalls =
    rawToolCalls.length > 0
      ? rawToolCalls.map((b) => ({
          id: b.id ?? '',
          name: b.name ?? '',
          arguments: JSON.stringify(b.input ?? {}),
        }))
      : undefined;

  // Extract tool definitions from raw request (Anthropic format)
  const rawTools = modifiedRaw['tools'] as Array<{
    name?: string;
    input_schema?: unknown;
  }> | undefined;
  const toolDefinitions =
    Array.isArray(rawTools) && rawTools.length > 0
      ? rawTools.map((t) => ({
          name: t?.name,
          parameters: t?.input_schema,
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
