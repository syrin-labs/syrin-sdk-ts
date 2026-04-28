/**
 * OpenAI interceptor — patches OpenAI.prototype.chat.completions.create to emit
 * Syrin telemetry, inject remote config, and enforce governance.
 *
 * Design mirrors Python's _openai_patch.py:
 *   - Patched at the class prototype level (idempotent, not per-instance).
 *   - Fail-open: if the wrapper throws, the original call still runs.
 *   - unpatch() restores the original method exactly.
 */

import type {
  ICallTarget,
  BeforeCallResult,
  NormalizedCallParams,
  NormalizedCallResult,
} from '@/core/call-types.js';

// ---------------------------------------------------------------------------
// Minimal type stubs (avoid hard dependency on the optional openai package)
// ---------------------------------------------------------------------------

export interface CompletionsInstance {
  create: (...args: unknown[]) => unknown;
  [key: string | symbol]: unknown;
}

export interface OpenAIModule {
  default?: { new(opts: { apiKey: string }): { chat: { completions: CompletionsInstance } } };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Singleton patch state
// ---------------------------------------------------------------------------

let _patched = false;
let _patchedProto: CompletionsInstance | null = null;
let _originalProtoCreate: ((...args: unknown[]) => unknown) | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Patch the OpenAI SDK directly (called by init()).
 * Lazily imports `openai`; silently skips if not installed.
 */
export async function patchOpenAI(core: ICallTarget): Promise<void> {
  try {
    const mod = await import('openai') as unknown as OpenAIModule;
    patchWithModule(mod, core);
  } catch {
    if (core.config.debug) {
      console.warn('[Syrin SDK] openai not installed — skipping instrumentation');
    }
  }
}

/**
 * Patch a specific openai module instance (used by tests to inject a mock).
 */
export function patchWithModule(openaiModule: OpenAIModule, core: ICallTarget): void {
  if (_patched) return;

  const OpenAIClass = (openaiModule.default ?? openaiModule) as {
    new(opts: { apiKey: string }): { chat: { completions: CompletionsInstance } };
    prototype?: { create?: (...args: unknown[]) => unknown };
  };

  let probe: unknown = null;
  try { probe = new OpenAIClass({ apiKey: '_syrin_probe_' }); } catch { probe = null; }

  const probeObj = probe as { chat?: { completions?: { constructor?: unknown } } } | null;
  const ActualCompletions = probeObj?.chat?.completions?.constructor as {
    prototype?: { create?: (...args: unknown[]) => unknown };
  } | null | undefined;

  if (ActualCompletions?.prototype?.create) {
    _originalProtoCreate = ActualCompletions.prototype.create;
    _patchedProto = ActualCompletions.prototype as CompletionsInstance;
    _patchedProto.create = _makePatchedCreate(_originalProtoCreate, core);
    _patched = true;
    if (core.config.debug) console.log('[Syrin SDK] Patched Completions.prototype.create');
    return;
  }

  // Fallback: constructor proxy for bundled / mock SDKs
  const Wrapped = new Proxy(OpenAIClass, {
    construct(Target, args: unknown[], newTarget): object {
      const inst = Reflect.construct(Target as new (...a: unknown[]) => unknown, args, newTarget) as {
        chat?: { completions?: CompletionsInstance };
      };
      const completions = inst.chat?.completions;
      if (completions && typeof completions.create === 'function') {
        const orig = completions.create.bind(completions);
        completions.create = _makePatchedCreate(orig, core);
      }
      return inst;
    },
  });

  if (Object.isExtensible(openaiModule)) {
    try {
      Object.defineProperty(openaiModule, 'default', { configurable: true, writable: true, value: Wrapped });
    } catch {
      try { openaiModule.default = Wrapped as OpenAIModule['default']; } catch { /* ignore */ }
    }
  }

  _patched = true;
  if (core.config.debug) console.log('[Syrin SDK] Patched OpenAI via constructor proxy');
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
  return async function patchedCreate(this: unknown, ...args: unknown[]): Promise<unknown> {
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

    const result = _extractResult(response, ctx.modifiedRaw, Date.now() - startTime, false, core.config.captureContent);
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
// Parameter normalization
// ---------------------------------------------------------------------------

function _normalizeParams(params: Record<string, unknown>): NormalizedCallParams {
  return {
    model: (params['model'] as string) ?? 'gpt-4o',
    messages: ((params['messages'] as Array<{ role: string; content?: unknown }>) ?? []).map((m) => ({
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

// ---------------------------------------------------------------------------
// Result extraction
// ---------------------------------------------------------------------------

function _extractResult(
  response: Record<string, unknown>,
  modifiedRaw: Record<string, unknown>,
  durationMs: number,
  stream: boolean,
  captureContent?: boolean,
): NormalizedCallResult {
  const model = (response['model'] as string) ?? (modifiedRaw['model'] as string) ?? 'unknown';
  const usage = (response['usage'] as { prompt_tokens?: number; completion_tokens?: number }) ?? {};
  const choices = response['choices'] as Array<{
    finish_reason?: string;
    message?: { content?: string; tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }> };
  }> | undefined;

  const rawToolCalls = choices?.[0]?.message?.tool_calls ?? [];
  const rawTools = modifiedRaw['tools'] as Array<{ function?: { name?: string; parameters?: unknown } }> | undefined;

  return {
    model,
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    finishReason: choices?.[0]?.finish_reason ?? 'stop',
    durationMs,
    stream,
    responseText: captureContent ? choices?.[0]?.message?.content : undefined,
    toolCalls: rawToolCalls.length > 0
      ? rawToolCalls.map((tc) => ({ id: tc.id, name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' }))
      : undefined,
    toolDefinitions: Array.isArray(rawTools) && rawTools.length > 0
      ? rawTools.map((t) => ({ name: t?.function?.name, parameters: t?.function?.parameters }))
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Stream wrapper
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
  let finishReason = 'stop';
  let actualModel = (ctx.modifiedRaw['model'] as string | undefined) ?? normalized.model;
  const contentChunks: string[] = [];

  const streamWithIter = stream as AsyncIterable<Record<string, unknown>> & { [k: string | symbol]: unknown };
  const originalIter = streamWithIter[Symbol.asyncIterator].bind(streamWithIter) as () => AsyncIterator<Record<string, unknown>>;

  const wrapped = async function* (): AsyncGenerator<Record<string, unknown>> {
    try {
      for await (const chunk of { [Symbol.asyncIterator]: originalIter }) {
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

  return new Proxy(streamWithIter, {
    get(target, prop: string | symbol): unknown {
      if (prop === Symbol.asyncIterator) return wrapped;
      const val = target[prop];
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  });
}
