/**
 * Anthropic interceptor — patches Anthropic.prototype.messages.create to emit
 * Syrin telemetry, inject remote config, and enforce governance.
 *
 * Design mirrors interceptors/openai.ts:
 *   - Class-level prototype patching (idempotent, not per-instance).
 *   - Fail-open: if the wrapper throws, the original call still runs.
 *   - unpatch() restores the original method exactly.
 *
 * Anthropic response differences vs OpenAI:
 *   - usage.input_tokens / usage.output_tokens  (not prompt/completion_tokens)
 *   - stop_reason at top level  (not choices[0].finish_reason)
 *   - content is ContentBlock[] — text blocks and tool_use blocks
 *   - Tool use: { type: "tool_use", id, name, input: {} }
 */

import type { ICallTarget, BeforeCallResult, NormalizedCallParams, NormalizedCallResult } from '@/core/call-types.js';

// ---------------------------------------------------------------------------
// Minimal type stubs — no hard dependency on @anthropic-ai/sdk
// ---------------------------------------------------------------------------

export interface AnthropicMessagesInstance {
  create: (...args: unknown[]) => unknown;
  [key: string | symbol]: unknown;
}

export interface AnthropicModule {
  default?: { new(opts: { apiKey: string }): { messages: AnthropicMessagesInstance } };
  Anthropic?: { new(opts: { apiKey: string }): { messages: AnthropicMessagesInstance } };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Singleton patch state
// ---------------------------------------------------------------------------

let _patched = false;
let _patchedProto: AnthropicMessagesInstance | null = null;
let _originalProtoCreate: ((...args: unknown[]) => unknown) | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Patch the Anthropic SDK (called by init()).
 * Lazily imports `@anthropic-ai/sdk`; silently skips if not installed.
 */
export async function patchAnthropic(core: ICallTarget): Promise<void> {
  try {
    const mod = await import('@anthropic-ai/sdk') as unknown as AnthropicModule;
    patchWithModule(mod, core);
  } catch {
    if (core.config.debug) {
      console.warn('[Syrin SDK] @anthropic-ai/sdk not installed — skipping Anthropic instrumentation');
    }
  }
}

/**
 * Patch a specific Anthropic module instance (used by tests to inject a mock).
 */
export function patchWithModule(anthropicModule: AnthropicModule, core: ICallTarget): void {
  if (_patched) return;

  const AnthropicClass = (anthropicModule.default ?? anthropicModule.Anthropic ?? anthropicModule) as {
    new(opts: { apiKey: string }): { messages: AnthropicMessagesInstance };
    prototype?: { messages?: { create?: (...args: unknown[]) => unknown } };
  };

  // Probe: try to get the Messages class prototype via constructor
  let probe: unknown = null;
  try { probe = new AnthropicClass({ apiKey: '_syrin_probe_' }); } catch { probe = null; }

  const probeObj = probe as { messages?: { constructor?: unknown } } | null;
  const ActualMessages = probeObj?.messages?.constructor as {
    prototype?: { create?: (...args: unknown[]) => unknown };
  } | null | undefined;

  if (ActualMessages?.prototype?.create) {
    _originalProtoCreate = ActualMessages.prototype.create;
    _patchedProto = ActualMessages.prototype as AnthropicMessagesInstance;
    _patchedProto.create = _makePatchedCreate(_originalProtoCreate, core);
    _patched = true;
    if (core.config.debug) console.log('[Syrin SDK] Patched Anthropic Messages.prototype.create');
    return;
  }

  // Fallback: constructor proxy for mocked/bundled SDKs
  const Wrapped = new Proxy(AnthropicClass, {
    construct(Target, args: unknown[], newTarget): object {
      const inst = Reflect.construct(Target as new (...a: unknown[]) => unknown, args, newTarget) as {
        messages?: AnthropicMessagesInstance;
      };
      const messages = inst.messages;
      if (messages && typeof messages.create === 'function') {
        const orig = messages.create.bind(messages);
        messages.create = _makePatchedCreate(orig, core);
      }
      return inst;
    },
  });

  if (Object.isExtensible(anthropicModule)) {
    try {
      const key = anthropicModule.default ? 'default' : 'Anthropic';
      Object.defineProperty(anthropicModule, key, { configurable: true, writable: true, value: Wrapped });
    } catch {
      try { (anthropicModule as Record<string, unknown>)['Anthropic'] = Wrapped; } catch { /* ignore */ }
    }
  }

  _patched = true;
  if (core.config.debug) console.log('[Syrin SDK] Patched Anthropic via constructor proxy');
}

export function unpatch(): void {
  if (!_patched) return;
  if (_patchedProto && _originalProtoCreate) {
    _patchedProto.create = _originalProtoCreate;
  }
  _patchedProto = null;
  _originalProtoCreate = null;
  _patched = false;
}

export function isPatched(): boolean {
  return _patched;
}

// ---------------------------------------------------------------------------
// Patched create wrapper
// ---------------------------------------------------------------------------

function _makePatchedCreate(
  origCreate: (...args: unknown[]) => unknown,
  core: ICallTarget,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedAnthropicCreate(this: unknown, ...args: unknown[]): Promise<unknown> {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    const options = args[1];
    const normalized = _normalizeParams(params);
    const startTime = Date.now();
    const ctx: BeforeCallResult = await core.beforeCall(normalized);

    if (ctx.modifiedRaw['stream'] === true) {
      return _handleStream(origCreate, this, ctx, normalized, options, core, startTime);
    }

    let response: Record<string, unknown>;
    try {
      response = await origCreate.call(this, ctx.modifiedRaw, options) as Record<string, unknown>;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      core.onCallError(ctx, normalized, error, Date.now() - startTime);
      throw error;
    }

    // Fall back to original params for tools if beforeCall didn't propagate them
    const rawForExtract = (ctx.modifiedRaw['tools'] !== undefined) ? ctx.modifiedRaw : { ...ctx.modifiedRaw, tools: params['tools'] };
    const result = _extractResult(response, rawForExtract, Date.now() - startTime, false, core.config.captureContent);
    core.afterCall(ctx, normalized, result);
    return response;
  };
}

async function _handleStream(
  origCreate: (...args: unknown[]) => unknown,
  thisArg: unknown,
  ctx: BeforeCallResult,
  normalized: NormalizedCallParams,
  options: unknown,
  core: ICallTarget,
  startTime: number,
): Promise<unknown> {
  let stream: AsyncIterable<Record<string, unknown>>;
  try {
    stream = await origCreate.call(thisArg, ctx.modifiedRaw, options) as AsyncIterable<Record<string, unknown>>;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    core.onCallError(ctx, normalized, error, Date.now() - startTime);
    throw error;
  }
  return _wrapStream(stream, ctx, normalized, startTime, core);
}

// ---------------------------------------------------------------------------
// Parameter normalization (Anthropic → NormalizedCallParams)
// ---------------------------------------------------------------------------

function _normalizeParams(params: Record<string, unknown>): NormalizedCallParams {
  const messages = (params['messages'] as Array<{ role: string; content?: unknown }> ?? []).map((m) => ({
    role: m.role ?? '',
    content: m.content,
  }));

  // Include system as a synthetic message if present
  const system = params['system'] as string | undefined;
  const allMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  return {
    model: (params['model'] as string) ?? 'claude-3-5-sonnet-20241022',
    messages: allMessages,
    temperature: params['temperature'] as number | undefined,
    max_tokens: params['max_tokens'] as number | undefined,
    stream: params['stream'] === true,
    tools: params['tools']
      ? (params['tools'] as Array<{ name?: string; input_schema?: unknown }>).map((t) => ({
          name: t?.name,
          parameters: t?.input_schema,
        }))
      : undefined,
    raw: { ...params },
  };
}

// ---------------------------------------------------------------------------
// Result extraction (Anthropic response → NormalizedCallResult)
// ---------------------------------------------------------------------------

function _extractResult(
  response: Record<string, unknown>,
  modifiedRaw: Record<string, unknown>,
  durationMs: number,
  stream: boolean,
  captureContent?: boolean,
): NormalizedCallResult {
  const model = (response['model'] as string) ?? (modifiedRaw['model'] as string) ?? 'unknown';

  // Anthropic uses input_tokens / output_tokens directly
  const usage = (response['usage'] as { input_tokens?: number; output_tokens?: number }) ?? {};
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;

  // stop_reason at top level (not choices[0].finish_reason)
  const finishReason = (response['stop_reason'] as string) ?? 'end_turn';

  const contentBlocks = response['content'] as Array<{
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }> | undefined;

  const textBlock = contentBlocks?.find((b) => b.type === 'text');
  const toolUseBlocks = contentBlocks?.filter((b) => b.type === 'tool_use') ?? [];

  return {
    model,
    inputTokens,
    outputTokens,
    finishReason,
    durationMs,
    stream,
    responseText: captureContent ? textBlock?.text : undefined,
    toolCalls: toolUseBlocks.length > 0
      ? toolUseBlocks.map((tb) => ({
          id: tb.id ?? '',
          name: tb.name ?? '',
          arguments: JSON.stringify(tb.input ?? {}),
        }))
      : undefined,
    // Anthropic tools format: { name, input_schema } — remap to { name, parameters }
    toolDefinitions: Array.isArray(modifiedRaw['tools'])
      ? (modifiedRaw['tools'] as Array<{ name?: string; input_schema?: unknown }>).map((t) => ({
          name: t?.name,
          parameters: t?.input_schema,
        }))
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Stream wrapper (Anthropic SSE stream)
// ---------------------------------------------------------------------------

function _wrapStream(
  stream: AsyncIterable<Record<string, unknown>>,
  ctx: BeforeCallResult,
  normalized: NormalizedCallParams,
  startTime: number,
  core: ICallTarget,
): unknown {
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = 'end_turn';
  let actualModel = (ctx.modifiedRaw['model'] as string | undefined) ?? normalized.model;
  const contentChunks: string[] = [];

  const streamObj = stream as AsyncIterable<Record<string, unknown>> & { [k: string | symbol]: unknown };

  // Handle both iterator-based streams and Anthropic's event-stream objects
  const getIter = (): (() => AsyncIterator<Record<string, unknown>>) => {
    if (Symbol.asyncIterator in streamObj) {
      const origIter = streamObj[Symbol.asyncIterator].bind(streamObj) as () => AsyncIterator<Record<string, unknown>>;
      return origIter;
    }
    // Fallback for objects without asyncIterator
    return () => ({
      next: async () => ({ done: true as const, value: undefined }),
      return: async () => ({ done: true as const, value: undefined }),
    });
  };

  const originalIter = getIter();

  const wrapped = async function* (): AsyncGenerator<Record<string, unknown>> {
    try {
      for await (const event of { [Symbol.asyncIterator]: originalIter }) {
        const eventType = event['type'] as string | undefined;

        // message_start: has model
        if (eventType === 'message_start') {
          const msg = event['message'] as Record<string, unknown> | undefined;
          if (msg?.['model']) actualModel = msg['model'] as string;
          const u = msg?.['usage'] as { input_tokens?: number } | undefined;
          if (u?.input_tokens) inputTokens = u.input_tokens;
        }

        // content_block_delta: has text
        if (eventType === 'content_block_delta') {
          const delta = (event['delta'] as Record<string, unknown> | undefined);
          if (delta?.['type'] === 'text_delta' && typeof delta?.['text'] === 'string') {
            contentChunks.push(delta['text'] as string);
          }
        }

        // message_delta: has stop_reason and output tokens
        if (eventType === 'message_delta') {
          const delta = event['delta'] as Record<string, unknown> | undefined;
          if (delta?.['stop_reason']) finishReason = delta['stop_reason'] as string;
          const u = event['usage'] as { output_tokens?: number } | undefined;
          if (u?.output_tokens) outputTokens = u.output_tokens;
        }

        yield event;
      }
    } finally {
      const result: NormalizedCallResult = {
        model: actualModel,
        inputTokens,
        outputTokens,
        finishReason,
        durationMs: Date.now() - startTime,
        stream: true,
        responseText: core.config.captureContent ? contentChunks.join('') : undefined,
      };
      core.onStreamComplete(ctx, normalized, result);
    }
  };

  if (!(Symbol.asyncIterator in streamObj)) {
    // No asyncIterator — just emit a minimal event and return the stream as-is
    const result: NormalizedCallResult = {
      model: actualModel,
      inputTokens: 0,
      outputTokens: 0,
      finishReason: 'end_turn',
      durationMs: Date.now() - startTime,
      stream: true,
    };
    core.onStreamComplete(ctx, normalized, result);
    return stream;
  }

  return new Proxy(streamObj, {
    get(target, prop: string | symbol): unknown {
      if (prop === Symbol.asyncIterator) return wrapped;
      const val = target[prop];
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  });
}
