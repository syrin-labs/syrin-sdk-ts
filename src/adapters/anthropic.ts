/**
 * Syrin SDK — Anthropic Adapter
 *
 * Patches the Anthropic SDK so every client.messages.create() call
 * is automatically instrumented. Uses SyrinCore for the provider-agnostic
 * lifecycle (governance, config injection, telemetry, OTel).
 *
 * Patching strategy:
 *  - Load @anthropic-ai/sdk dynamically (optional peer dependency).
 *  - Patch Messages.prototype.create on the class prototype so every
 *    Anthropic instance is instrumented with a single patch.
 *
 * Anthropic-specific differences from OpenAI:
 *  - Usage fields: input_tokens / output_tokens (not prompt_tokens / completion_tokens)
 *  - Stop signal: stop_reason (not finish_reason)
 *  - Tool definitions: tools[i].input_schema (not tools[i].function.parameters)
 *  - Tool calls in response: content blocks where type === "tool_use"
 *  - Streaming: AsyncIterable of typed event objects (not chunks with choices[])
 */

import type {
  ISyrinCore,
  SyrinAdapter,
  BeforeCallResult,
  NormalizedCallParams,
  NormalizedCallResult,
  SchemaField,
} from '@/adapters/types';
import { detectProvider } from '@/provider';

// ---------------------------------------------------------------------------
// Minimal type interfaces for the optional @anthropic-ai/sdk module
// ---------------------------------------------------------------------------

interface MessagesInstance {
  create: (...args: unknown[]) => unknown;
  [key: string | symbol]: unknown;
}

interface AnthropicConstructor {
  new(opts?: Record<string, unknown>): AnthropicInstance;
  prototype?: Record<string, unknown>;
}

interface AnthropicInstance {
  messages: MessagesInstance;
  baseURL?: string;
  [key: string]: unknown;
}

export interface AnthropicModule {
  default?: AnthropicConstructor;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Module-level patch state (singleton per process)
// ---------------------------------------------------------------------------

let _patched = false;
let _patchedProto: MessagesInstance | null = null;
let _originalCreate: ((...args: unknown[]) => unknown) | null = null;
/** Reference to the wrapped constructor (for constructor-proxy mode cleanup). */
let _wrappedAnthropicClass: AnthropicConstructor | null = null;
/** The original (pre-proxy) Anthropic class — for restoring on unpatch. */
let _originalAnthropicClass: AnthropicConstructor | null = null;
let _anthropicModuleRef: AnthropicModule | null = null;

// ---------------------------------------------------------------------------
// AnthropicAdapter — implements SyrinAdapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements SyrinAdapter {
  readonly name = 'anthropic';

  constructor(private readonly _anthropicModule?: AnthropicModule | null) {}

  configSchema(): Record<string, SchemaField[]> {
    return {
      llm: [
        { name: 'model', type: 'str', default: null },
        { name: 'temperature', type: 'float', default: null, constraints: { ge: 0.0, le: 2.0 } },
        { name: 'max_tokens', type: 'int', default: null, constraints: { ge: 1 } },
      ],
    };
  }

  async install(core: ISyrinCore): Promise<void> {
    // If a null module was explicitly passed (e.g. for testing missing package),
    // skip patching gracefully.
    if (this._anthropicModule === null) return;

    const mod = this._anthropicModule ?? (await _loadAnthropic(core.config.debug));
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

// ---------------------------------------------------------------------------
// _loadAnthropic — dynamic import with graceful fallback
// ---------------------------------------------------------------------------

async function _loadAnthropic(debug?: boolean): Promise<AnthropicModule | null> {
  try {
    return (await import('@anthropic-ai/sdk')) as AnthropicModule;
  } catch {
    if (debug) {
      console.warn('[Syrin] @anthropic-ai/sdk not found. Install with: npm install @anthropic-ai/sdk');
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// _patchWithModule — monkey-patch Messages.prototype.create
// ---------------------------------------------------------------------------

function _patchWithModule(anthropicModule: AnthropicModule, core: ISyrinCore): void {
  if (_patched) return;

  const AnthropicClass = (
    anthropicModule.default ?? anthropicModule
  ) as AnthropicConstructor;

  // Probe an instance to locate the Messages prototype
  let probeInstance: AnthropicInstance | null = null;
  try {
    probeInstance = new AnthropicClass({ apiKey: '_syrin_probe_' });
  } catch {
    probeInstance = null;
  }

  if (probeInstance) {
    const MessagesProto = Object.getPrototypeOf(probeInstance.messages) as MessagesInstance | null;
    if (MessagesProto && typeof MessagesProto['create'] === 'function') {
      // Real SDK: create lives on the prototype — patch once for all instances
      _originalCreate = MessagesProto.create as (...args: unknown[]) => unknown;
      _patchedProto = MessagesProto;
      MessagesProto.create = _makePatched(_originalCreate, core);
      _patched = true;
      if (core.config.debug) {
        console.log('[Syrin] Patched Anthropic Messages.prototype.create (prototype mode)');
      }
      return;
    }
  }

  // Fallback: create is a class-field / instance property (mock SDKs, bundled SDKs).
  // Wrap the Anthropic constructor so every new instance gets its messages.create patched.
  _originalAnthropicClass = AnthropicClass;
  _anthropicModuleRef = anthropicModule;

  const WrappedAnthropic = new Proxy(AnthropicClass, {
    construct(Target, args: unknown[], newTarget) {
      const instance = Reflect.construct(
        Target as new (...a: unknown[]) => unknown,
        args,
        newTarget,
      ) as AnthropicInstance;
      if (instance.messages && typeof instance.messages.create === 'function') {
        const origCreate = instance.messages.create.bind(instance.messages);
        // Capture the client-level baseURL at construction time for provider detection
        const clientBaseURL = (instance as Record<string, unknown>)['baseURL'] as string | undefined;
        instance.messages.create = _makePatched(origCreate, core, clientBaseURL);
      }
      return instance;
    },
  });

  _wrappedAnthropicClass = WrappedAnthropic;

  if (Object.isExtensible(anthropicModule)) {
    try {
      Object.defineProperty(anthropicModule, 'default', {
        configurable: true,
        writable: true,
        value: WrappedAnthropic,
      });
    } catch {
      try {
        anthropicModule.default = WrappedAnthropic as AnthropicModule['default'];
      } catch {
        if (core.config.debug) {
          console.warn('[Syrin] Could not replace Anthropic module.default — patching may not work.');
        }
      }
    }
  }

  _patched = true;
  if (core.config.debug) {
    console.log('[Syrin] Patched Anthropic via constructor proxy (instance-property mode)');
  }
}

// ---------------------------------------------------------------------------
// _makePatched — wraps Messages.prototype.create
// ---------------------------------------------------------------------------

function _makePatched(
  origCreate: (...args: unknown[]) => unknown,
  core: ISyrinCore,
  capturedBaseURL?: string,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedAnthropicCreate(
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    const options: unknown = args[1];

    // Detect provider from the captured baseURL (constructor-proxy mode) or
    // from `this` (prototype-patch mode, where this = messages instance with access to client).
    const clientLike = capturedBaseURL
      ? { baseURL: capturedBaseURL }
      : (this as Record<string, unknown> | null | undefined);
    const provider = detectProvider(clientLike) || 'anthropic';

    // Normalise Anthropic-specific params to the provider-agnostic form
    const normalizedParams: NormalizedCallParams = _normalizeParams(params, provider);

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
      response = (await origCreate.call(this, modifiedRaw, options)) as Record<string, unknown>;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      core.onCallError(ctx, normalizedParams, error, Date.now() - startTime);
      throw error;
    }

    const durationMs = Date.now() - startTime;
    const result = _extractResult(response, modifiedRaw, durationMs, false, core.config.captureContent);

    core.afterCall(ctx, normalizedParams, result);
    return response;
  };
}

// ---------------------------------------------------------------------------
// _normalizeParams — Anthropic → NormalizedCallParams
// ---------------------------------------------------------------------------

function _normalizeParams(params: Record<string, unknown>, provider: string): NormalizedCallParams {
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

// ---------------------------------------------------------------------------
// _extractResult — Anthropic response → NormalizedCallResult
// ---------------------------------------------------------------------------

function _extractResult(
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

// ---------------------------------------------------------------------------
// _handleStreamingCall + _wrapStream — Anthropic streaming specifics
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
    stream = (await origCreate.call(
      thisArg,
      modifiedRaw,
      options,
    )) as AsyncIterable<Record<string, unknown>>;
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

// ---------------------------------------------------------------------------
// unpatch / isPatched — named exports for direct use in tests
// ---------------------------------------------------------------------------

export function unpatch(): void {
  if (!_patched) return;
  if (_patchedProto && _originalCreate) {
    // Prototype-mode: restore the original function on the prototype
    _patchedProto.create = _originalCreate;
  }
  if (_originalAnthropicClass && _anthropicModuleRef) {
    // Constructor-proxy mode: restore the original class on the module
    try {
      Object.defineProperty(_anthropicModuleRef, 'default', {
        configurable: true,
        writable: true,
        value: _originalAnthropicClass,
      });
    } catch {
      try {
        _anthropicModuleRef.default = _originalAnthropicClass as AnthropicModule['default'];
      } catch {
        // Best-effort
      }
    }
  }
  _patchedProto = null;
  _originalCreate = null;
  _wrappedAnthropicClass = null;
  _originalAnthropicClass = null;
  _anthropicModuleRef = null;
  _patched = false;
}

export function isPatched(): boolean {
  return _patched;
}
