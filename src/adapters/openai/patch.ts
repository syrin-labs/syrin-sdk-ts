/**
 * OpenAI Adapter — Patching mechanics
 */

import { createRequire } from 'module';
import type { ISyrinCore, BeforeCallResult, NormalizedCallParams } from '@/adapters/types.js';
import { normalizeOpenAIParams, extractOpenAIResult } from './normalize.js';
import { wrapOpenAIStream } from './stream.js';

// createRequire from the user's CWD so we resolve the user's openai, not the SDK's copy.
// This is used to also patch the CJS version of openai (used by LangChain and other CJS packages).
const _cwdRequire = createRequire(process.cwd() + '/package.json');

// Minimal interfaces for the optional openai module (avoid direct import of optional dep)
export interface CompletionsInstance {
  create: (...args: unknown[]) => unknown;
  [key: string | symbol]: unknown;
}
export interface OpenAIModule {
  default?: { new(opts: { apiKey: string }): { chat: { completions: CompletionsInstance } } };
  [key: string]: unknown;
}

// Module-level patch state (singleton per process)
export let _patched = false;
export let _patchedProto: CompletionsInstance | null = null;
export let _originalProtoCreate: ((...args: unknown[]) => unknown) | null = null;

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
    _patchedProto.create = _makePatchedCreate(_originalProtoCreate, core);
    _patched = true;
    if (core.config.debug) {
      console.log('[Syrin] Patched Completions.prototype.create');
    }

    // Also patch the CJS entry point of openai if it's a different class instance.
    // Node.js loads ESM and CJS as separate module instances — frameworks like LangChain
    // use the CJS `require('openai')` even when the user imports via ESM `import OpenAI`.
    // Without patching the CJS prototype, their LLM calls would bypass instrumentation.
    try {
      const cjsOpenai = _cwdRequire('openai') as { default?: unknown; [k: string]: unknown };
      const CJSOpenAIClass = (cjsOpenai.default ?? cjsOpenai) as {
        new(opts: { apiKey: string }): { chat: { completions: CompletionsInstance } };
      };
      const cjsProbe = new CJSOpenAIClass({ apiKey: '_syrin_probe_cjs_' });
      const CJSCompletions = (cjsProbe as { chat?: { completions?: { constructor?: unknown } } })
        ?.chat?.completions?.constructor as { prototype?: { create?: (...args: unknown[]) => unknown } } | null | undefined;
      if (
        CJSCompletions &&
        typeof CJSCompletions.prototype?.create === 'function' &&
        CJSCompletions.prototype !== (ActualCompletions as { prototype?: unknown }).prototype
      ) {
        const origCJS = CJSCompletions.prototype.create;
        CJSCompletions.prototype.create = _makePatchedCreate(origCJS, core);
        if (core.config.debug) {
          console.log('[Syrin] Also patched CJS Completions.prototype.create (for LangChain/CJS frameworks)');
        }
      }
    } catch {
      // CJS patch is best-effort — not fatal if it fails
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
        completions.create = _makePatchedCreate(origCreate, core);
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

export function _makePatchedCreate(
  origCreate: (...args: unknown[]) => unknown,
  core: ISyrinCore,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedCreate(
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    const options: unknown = args[1];

    const normalizedParams = normalizeOpenAIParams(params);

    // --- Before call: governance + config injection ---
    const startTime = Date.now();
    const ctx: BeforeCallResult = await core.beforeCall(normalizedParams);
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
    const result = extractOpenAIResult(response, ctx.modifiedRaw, durationMs, false, core.config.captureContent);
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
    stream = await origCreate.call(thisArg, modifiedRaw, options) as AsyncIterable<Record<string, unknown>>;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    core.onCallError(ctx, normalizedParams, error, Date.now() - startTime);
    throw error;
  }

  return wrapOpenAIStream(stream, ctx, normalizedParams, startTime, core);
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
