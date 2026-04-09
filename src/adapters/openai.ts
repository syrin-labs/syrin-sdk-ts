/**
 * Syrin SDK — OpenAI Adapter
 *
 * Patches the OpenAI SDK so every client.chat.completions.create() call
 * is automatically instrumented. Uses SyrinCore for the provider-agnostic
 * lifecycle (governance, config injection, telemetry, OTel).
 *
 * Patching strategy:
 *  - If Completions.prototype.create exists (real SDK v4), patch the prototype.
 *  - If create is a class-field/instance property (some mocks/bundled SDKs),
 *    wrap the OpenAI class constructor so every new instance gets its
 *    completions.create wrapped immediately after construction.
 *
 * This file owns all OpenAI-specific code:
 *   - Prototype / constructor patching mechanics
 *   - Response field extraction (usage, choices, tool_calls)
 *   - Streaming chunk accumulation
 */

import type { ISyrinCore, SyrinAdapter, BeforeCallResult, NormalizedCallParams, NormalizedCallResult } from '@/adapters/types';

// Minimal interfaces for the optional openai module (avoid direct import of optional dep)
interface CompletionsInstance {
  create: (...args: unknown[]) => unknown;
  [key: string | symbol]: unknown;
}
interface OpenAIModule {
  default?: { new(opts: { apiKey: string }): { chat: { completions: CompletionsInstance } } };
  [key: string]: unknown;
}

// Module-level patch state (singleton per process)
let _patched = false;
let _patchedProto: CompletionsInstance | null = null;
let _originalProtoCreate: ((...args: unknown[]) => unknown) | null = null;

// ---------------------------------------------------------------------------
// OpenAIAdapter — implements SyrinAdapter
// ---------------------------------------------------------------------------

export class OpenAIAdapter implements SyrinAdapter {
  readonly name = 'openai';

  constructor(private readonly _openaiModule?: OpenAIModule) {}

  async install(core: ISyrinCore): Promise<void> {
    const mod = this._openaiModule ?? (await _loadOpenAI(core.config.debug));
    if (mod) {
      _patchWithModule(mod, core);
    }
  }

  uninstall(): void {
    unpatch();
  }

  isInstalled(): boolean {
    return _patched;
  }
}

async function _loadOpenAI(debug?: boolean): Promise<OpenAIModule | null> {
  try {
    return await import('openai') as unknown as OpenAIModule;
  } catch {
    if (debug) {
      console.warn('[Syrin] openai module not found. Install with: npm install openai');
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// patchWithModule — public entry point
// ---------------------------------------------------------------------------

/**
 * Patch an already-loaded OpenAI module object with Syrin instrumentation.
 */
export function patchWithModule(openaiModule: OpenAIModule, core: ISyrinCore): void {
  _patchWithModule(openaiModule, core);
}

function _patchWithModule(openaiModule: OpenAIModule, core: ISyrinCore): void {
  if (_patched) return;

  const OpenAIClass = (openaiModule.default ?? openaiModule) as {
    new(opts: { apiKey: string }): { chat: { completions: CompletionsInstance } };
    prototype?: { create?: (...args: unknown[]) => unknown };
  };

  let probeInstance: unknown = null;
  try {
    probeInstance = new OpenAIClass({ apiKey: '_syrin_probe_' });
  } catch {
    probeInstance = null;
  }

  const probeObj = probeInstance as { chat?: { completions?: { constructor?: unknown } } } | null;
  const ActualCompletions = probeObj?.chat?.completions?.constructor as {
    prototype?: { create?: (...args: unknown[]) => unknown };
  } | null | undefined;

  if (ActualCompletions && typeof ActualCompletions.prototype?.create === 'function') {
    _originalProtoCreate = ActualCompletions.prototype.create;
    _patchedProto = ActualCompletions.prototype as CompletionsInstance;
    _patchedProto.create = _makePatched(_originalProtoCreate, core);
    _patched = true;
    if (core.config.debug) {
      console.log('[Syrin] Patched Completions.prototype.create');
    }
    return;
  }

  // Fallback: constructor proxy for bundled / mock SDKs
  const WrappedOpenAI = new Proxy(OpenAIClass, {
    construct(Target, args: unknown[], newTarget) {
      const instance = Reflect.construct(Target as new (...a: unknown[]) => unknown, args, newTarget) as {
        chat?: { completions?: CompletionsInstance };
      };
      const completions = instance.chat?.completions;
      if (completions && typeof completions.create === 'function') {
        const origCreate = completions.create.bind(completions);
        completions.create = _makePatched(origCreate, core);
      }
      return instance;
    },
  });

  if (Object.isExtensible(openaiModule)) {
    try {
      Object.defineProperty(openaiModule, 'default', {
        configurable: true,
        writable: true,
        value: WrappedOpenAI,
      });
    } catch {
      try {
        openaiModule.default = WrappedOpenAI as OpenAIModule['default'];
      } catch {
        if (core.config.debug) {
          console.warn('[Syrin] Could not replace module.default — patching may not work.');
        }
      }
    }
  }

  _patched = true;
  if (core.config.debug) {
    console.log('[Syrin] Patched OpenAI via constructor proxy (instance-property mode)');
  }
}

// ---------------------------------------------------------------------------
// _makePatched — wraps a single completions.create function
// ---------------------------------------------------------------------------

function _makePatched(
  origCreate: (...args: unknown[]) => unknown,
  core: ISyrinCore,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedCreate(
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    const options: unknown = args[1];

    // Normalise the OpenAI params into provider-agnostic form for core
    const normalizedParams: NormalizedCallParams = {
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

    // --- Before call: governance + config injection ---
    const startTime = Date.now();
    const ctx = await core.beforeCall(normalizedParams);
    const { modifiedRaw } = ctx;

    // --- Route: streaming vs non-streaming ---
    if (modifiedRaw['stream'] === true) {
      return _handleStreamingCall(origCreate, this, modifiedRaw, options, ctx, normalizedParams, core, startTime);
    }

    // --- Non-streaming call ---
    let response: Record<string, unknown>;
    try {
      response = await origCreate.call(this, modifiedRaw, options) as Record<string, unknown>;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      core.onCallError(ctx, normalizedParams, error, Date.now() - startTime);
      throw error;
    }

    const durationMs = Date.now() - startTime;

    // Extract result from OpenAI response
    const result = _extractResult(response, ctx.modifiedRaw, durationMs, false, core.config.captureContent);

    core.afterCall(ctx, normalizedParams, result);

    return response;
  };
}

// ---------------------------------------------------------------------------
// _handleStreamingCall + _wrapStream — OpenAI streaming specifics
// ---------------------------------------------------------------------------

async function _handleStreamingCall(
  origCreate: (...args: unknown[]) => unknown,
  thisArg: unknown,
  modifiedRaw: Record<string, unknown>,
  options: unknown,
  ctx: BeforeCallResult,
  normalizedParams: NormalizedCallParams,
  core: ISyrinCore,
  startTime: number,
): Promise<unknown> {
  let stream: AsyncIterable<Record<string, unknown>>;
  try {
    stream = await origCreate.call(thisArg, modifiedRaw, options) as AsyncIterable<Record<string, unknown>>;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    core.onCallError(ctx, normalizedParams, error, Date.now() - startTime);
    throw error;
  }

  return _wrapStream(stream, ctx, normalizedParams, startTime, core);
}

function _wrapStream(
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

  const streamWithIter = stream as AsyncIterable<Record<string, unknown>> & {
    [key: string | symbol]: unknown;
  };
  const originalIterator = streamWithIter[Symbol.asyncIterator].bind(streamWithIter) as () => AsyncIterator<Record<string, unknown>>;

  const wrappedIterator = async function* (): AsyncGenerator<Record<string, unknown>> {
    try {
      for await (const chunk of { [Symbol.asyncIterator]: originalIterator }) {
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

// ---------------------------------------------------------------------------
// _extractResult — parse OpenAI response → NormalizedCallResult
// ---------------------------------------------------------------------------

function _extractResult(
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

// ---------------------------------------------------------------------------
// unpatch / isPatched — public exports
// ---------------------------------------------------------------------------

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
