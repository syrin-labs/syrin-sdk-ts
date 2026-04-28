/**
 * Google Gemini interceptor — patches @google/genai to emit Syrin telemetry,
 * inject remote config, and enforce governance.
 *
 * Supports: @google/genai  (npm install @google/genai)
 *   Patches GoogleGenAI.models.generateContent
 *
 * Design mirrors interceptors/openai.ts:
 *   - Class-level prototype patching, idempotent, fail-open.
 *   - unpatch() restores originals.
 *
 * @google/genai response shape:
 *   - usage: response.usageMetadata.promptTokenCount / candidatesTokenCount
 *   - finish_reason: response.candidates[0].finishReason (enum string)
 *   - text shortcut: response.text
 */

import type { ICallTarget, BeforeCallResult, NormalizedCallParams, NormalizedCallResult } from '@/core/call-types.js';

let _patched       = false;
let _modelsProto:   Record<string | symbol, unknown> | null = null;
let _originalGenerate: ((...args: unknown[]) => unknown) | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Patch @google/genai if available. Called by init(). */
export async function patchGemini(core: ICallTarget): Promise<void> {
  if (_patched) return;
  try {
    const mod = await import('@google/genai') as Record<string, unknown>;
    patchWithModule(mod, core);
  } catch {
    if (core.config.debug) {
      console.warn('[Syrin SDK] @google/genai not installed — skipping Gemini instrumentation');
    }
  }
}

/** Patch a specific @google/genai module instance (used by tests). */
export function patchWithModule(googleModule: Record<string, unknown>, core: ICallTarget): void {
  if (_patched) return;

  const GoogleGenAI = (googleModule['GoogleGenAI'] ?? googleModule['default']) as {
    new(opts: { apiKey: string }): { models: unknown };
    prototype?: Record<string, unknown>;
  } | undefined;

  if (!GoogleGenAI) return;

  // Try prototype-based patching first (real SDK: generateContent on Models.prototype).
  let patchedViaProto = false;
  try {
    const client = new GoogleGenAI({ apiKey: '_syrin_probe_' });
    const models = (client as { models: unknown }).models;
    const modelsProto = Object.getPrototypeOf(models) as Record<string | symbol, unknown>;
    if (modelsProto && typeof modelsProto['generateContent'] === 'function') {
      _originalGenerate = modelsProto['generateContent'] as (...args: unknown[]) => unknown;
      _modelsProto = modelsProto;
      modelsProto['generateContent'] = _makeWrapper(_originalGenerate, core);
      patchedViaProto = true;
    }
  } catch { /* ignore */ }

  if (!patchedViaProto) {
    // Fallback: generateContent is a class-field (mocks, bundled SDKs).
    // Use a constructor Proxy to wrap models.generateContent on each new instance.
    const WrappedClass = new Proxy(GoogleGenAI as new (...a: unknown[]) => unknown, {
      construct(Target, args, newTarget): object {
        const inst = Reflect.construct(Target, args, newTarget) as { models?: Record<string, unknown> };
        const models = inst.models;
        if (models && typeof models['generateContent'] === 'function') {
          const orig = models['generateContent'] as (...a: unknown[]) => unknown;
          models['generateContent'] = _makeWrapper(orig.bind(models), core);
        }
        return inst;
      },
    });
    const key = googleModule['GoogleGenAI'] ? 'GoogleGenAI' : 'default';
    try {
      Object.defineProperty(googleModule, key, { configurable: true, writable: true, value: WrappedClass });
    } catch {
      try { (googleModule as Record<string, unknown>)[key] = WrappedClass; } catch { /* ignore */ }
    }
  }

  _patched = true;
  if (core.config.debug) console.log('[Syrin SDK] Patched @google/genai generateContent');
}

export function unpatch(): void {
  if (_patched && _modelsProto && _originalGenerate) {
    _modelsProto['generateContent'] = _originalGenerate;
  }
  _modelsProto = null;
  _originalGenerate = null;
  _patched = false;
}

export function isPatched(): boolean {
  return _patched;
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function _makeWrapper(
  origGenerate: (...args: unknown[]) => unknown,
  core: ICallTarget,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedGeminiGenerate(this: unknown, ...args: unknown[]): Promise<unknown> {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    const normalized = _normalizeParams(params);
    const startTime = Date.now();
    const ctx: BeforeCallResult = await core.beforeCall(normalized);

    let response: Record<string, unknown>;
    try {
      response = await origGenerate.call(this, ctx.modifiedRaw, ...args.slice(1)) as Record<string, unknown>;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      core.onCallError(ctx, normalized, error, Date.now() - startTime);
      throw error;
    }

    const result = _extractResult(response, ctx.modifiedRaw, Date.now() - startTime, core.config.captureContent);
    core.afterCall(ctx, normalized, result);
    return response;
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function _normalizeParams(params: Record<string, unknown>): NormalizedCallParams {
  const model   = (params['model'] as string) ?? '';
  const contents = params['contents'];
  const config   = params['config'] as Record<string, unknown> | undefined;

  let messages: Array<{ role: string; content: unknown }> = [];
  if (typeof contents === 'string') {
    messages = [{ role: 'user', content: contents }];
  } else if (Array.isArray(contents)) {
    messages = (contents as Array<{ role?: string; parts?: Array<{ text?: string }> }>).map((c) => ({
      role: c.role ?? 'user',
      content: c.parts?.[0]?.text ?? '',
    }));
  }

  return {
    model: model || 'gemini-2.0-flash',
    messages,
    temperature: config?.['temperature'] as number | undefined,
    max_tokens:  config?.['maxOutputTokens'] as number | undefined,
    stream: false,
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
  captureContent?: boolean,
): NormalizedCallResult {
  return {
    model:        (modifiedRaw['model'] as string) ?? 'gemini-2.0-flash',
    inputTokens:  _extractInputTokens(response),
    outputTokens: _extractOutputTokens(response),
    finishReason: _extractFinishReason(response),
    durationMs,
    stream: false,
    responseText: captureContent ? _extractText(response) : undefined,
  };
}

function _extractInputTokens(response: Record<string, unknown>): number {
  const usage = (response['usageMetadata'] ?? response['usage_metadata']) as
    | { promptTokenCount?: number } | undefined;
  return usage?.promptTokenCount ?? 0;
}

function _extractOutputTokens(response: Record<string, unknown>): number {
  const usage = (response['usageMetadata'] ?? response['usage_metadata']) as
    | { candidatesTokenCount?: number } | undefined;
  return usage?.candidatesTokenCount ?? 0;
}

function _extractFinishReason(response: Record<string, unknown>): string {
  try {
    const candidates = response['candidates'] as Array<{ finishReason?: string | { name?: string } }> | undefined;
    if (candidates?.length) {
      const reason = candidates[0].finishReason;
      if (reason) {
        return typeof reason === 'object'
          ? (reason.name ?? 'stop').toLowerCase()
          : String(reason).toLowerCase();
      }
    }
  } catch { /* ignore */ }
  return 'stop';
}

function _extractText(response: Record<string, unknown>): string | undefined {
  if (typeof response['text'] === 'string') return response['text'];
  try {
    const candidates = response['candidates'] as Array<{
      content?: { parts?: Array<{ text?: string }> };
    }> | undefined;
    return candidates?.[0]?.content?.parts?.[0]?.text;
  } catch { return undefined; }
}
