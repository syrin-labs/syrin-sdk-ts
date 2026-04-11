/**
 * Anthropic Adapter — Patching mechanics
 */

import type { ISyrinCore, BeforeCallResult, NormalizedCallParams } from '@/adapters/types.js';
import { detectProvider } from '@/utils/provider.js';
import { normalizeAnthropicParams, extractAnthropicResult } from './normalize.js';
import { wrapAnthropicStream } from './stream.js';

export interface MessagesInstance {
  create: (...args: unknown[]) => unknown;
  [key: string | symbol]: unknown;
}

export interface AnthropicConstructor {
  new(opts?: Record<string, unknown>): AnthropicInstance;
  prototype?: Record<string, unknown>;
}

export interface AnthropicInstance {
  messages: MessagesInstance;
  baseURL?: string;
  [key: string]: unknown;
}

export interface AnthropicModule {
  default?: AnthropicConstructor;
  [key: string]: unknown;
}

// Module-level patch state (singleton per process)
export let _patched = false;
export let _patchedProto: MessagesInstance | null = null;
export let _originalCreate: ((...args: unknown[]) => unknown) | null = null;
export let _wrappedAnthropicClass: AnthropicConstructor | null = null;
export let _originalAnthropicClass: AnthropicConstructor | null = null;
export let _anthropicModuleRef: AnthropicModule | null = null;

export function patchWithModule(anthropicModule: AnthropicModule, core: ISyrinCore): void {
  _patchWithModule(anthropicModule, core);
}

function _patchWithModule(anthropicModule: AnthropicModule, core: ISyrinCore): void {
  if (_patched) return;

  const AnthropicClass = (
    anthropicModule.default ?? anthropicModule
  ) as AnthropicConstructor;

  let probeInstance: AnthropicInstance | null = null;
  try {
    probeInstance = new AnthropicClass({ apiKey: '_syrin_probe_' });
  } catch {
    probeInstance = null;
  }

  if (probeInstance) {
    const MessagesProto = Object.getPrototypeOf(probeInstance.messages) as MessagesInstance | null;
    if (MessagesProto && typeof MessagesProto['create'] === 'function') {
      _originalCreate = MessagesProto.create as (...args: unknown[]) => unknown;
      _patchedProto = MessagesProto;
      MessagesProto.create = _makePatchedCreate(_originalCreate, core);
      _patched = true;
      if (core.config.debug) {
        console.log('[Syrin] Patched Anthropic Messages.prototype.create (prototype mode)');
      }
      return;
    }
  }

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
        const clientBaseURL = (instance as Record<string, unknown>)['baseURL'] as string | undefined;
        instance.messages.create = _makePatchedCreate(origCreate, core, clientBaseURL);
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

export function _makePatchedCreate(
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

    const clientLike = capturedBaseURL
      ? { baseURL: capturedBaseURL }
      : (this as Record<string, unknown> | null | undefined);
    const provider = detectProvider(clientLike) || 'anthropic';

    const normalizedParams: NormalizedCallParams = normalizeAnthropicParams(params, provider);

    const startTime = Date.now();
    const ctx: BeforeCallResult = await core.beforeCall(normalizedParams);
    const { modifiedRaw } = ctx;

    if (modifiedRaw['stream'] === true) {
      return _handleStreamingCall(origCreate, this, modifiedRaw, options, ctx, normalizedParams, core, startTime);
    }

    let response: Record<string, unknown>;
    try {
      response = (await origCreate.call(this, modifiedRaw, options)) as Record<string, unknown>;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      core.onCallError(ctx, normalizedParams, error, Date.now() - startTime);
      throw error;
    }

    const durationMs = Date.now() - startTime;
    const result = extractAnthropicResult(response, modifiedRaw, durationMs, false, core.config.captureContent);
    core.afterCall(ctx, normalizedParams, result);
    return response;
  };
}

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

  return wrapAnthropicStream(stream, ctx, normalizedParams, startTime, core);
}

export function unpatch(): void {
  if (!_patched) return;
  if (_patchedProto && _originalCreate) {
    _patchedProto.create = _originalCreate;
  }
  if (_originalAnthropicClass && _anthropicModuleRef) {
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
