/**
 * Vercel AI Adapter — Module patching mechanics
 *
 * Strategy:
 *  1. Attempt to patch @ai-sdk/openai's OpenAIChatLanguageModel.prototype.doGenerate
 *     and doStream directly (prototype patch — works for ESM).
 *  2. Fall back to patching the ai module's generateText/streamText/generateObject
 *     exports via property assignment (works only for CJS or mutable module objects).
 *
 * The prototype patch is the primary path because the ai module's named exports
 * are ESM live bindings (read-only in strict ESM), so assignment silently fails.
 */

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';
import { dirname, resolve as pathResolve } from 'path';
import type { VercelAIAdapterLike } from './wrappers.js';
import { makeGenerateTextWrapper, makeStreamTextWrapper, makeGenerateObjectWrapper } from './wrappers.js';

// Module-level patch state (singleton per process)
export let _patchedVercelAI = false;
export let _aiModuleRef: Record<string, unknown> | null = null;
export let _originalGenerateText: ((...args: unknown[]) => unknown) | null = null;
export let _originalStreamText: ((...args: unknown[]) => unknown) | null = null;
export let _originalGenerateObject: ((...args: unknown[]) => unknown) | null = null;

// Prototype-level patch state for @ai-sdk/openai
let _patchedModelProto: Record<string, unknown> | null = null;
let _origDoGenerate: ((...args: unknown[]) => unknown) | null = null;
let _origDoStream: ((...args: unknown[]) => unknown) | null = null;

export async function patchVercelAI(adapter: VercelAIAdapterLike): Promise<void> {
  if (_patchedVercelAI) return;

  // ── Primary path: patch @ai-sdk/openai model prototype ──────────────────
  // This works regardless of whether the ai module exports are ESM live bindings.
  await _patchAiSdkOpenaiProto(adapter);

  // ── Secondary path: patch ai module exports (works for CJS / mutable ESM) ─
  let aiModule: Record<string, unknown>;
  try {
    aiModule = (await import('ai')) as Record<string, unknown>;
  } catch {
    _patchedVercelAI = true;
    return;
  }

  _aiModuleRef = aiModule;

  const trySet = (key: string, value: unknown): boolean => {
    try { aiModule[key] = value; return true; } catch { return false; }
  };

  if (typeof aiModule['generateText'] === 'function') {
    _originalGenerateText = aiModule['generateText'] as (...args: unknown[]) => unknown;
    trySet('generateText', makeGenerateTextWrapper(adapter, _originalGenerateText));
  }

  if (typeof aiModule['streamText'] === 'function') {
    _originalStreamText = aiModule['streamText'] as (...args: unknown[]) => unknown;
    trySet('streamText', makeStreamTextWrapper(adapter, _originalStreamText));
  }

  if (typeof aiModule['generateObject'] === 'function') {
    _originalGenerateObject = aiModule['generateObject'] as (...args: unknown[]) => unknown;
    trySet('generateObject', makeGenerateObjectWrapper(adapter, _originalGenerateObject));
  }

  _patchedVercelAI = true;
}

/**
 * Patch @ai-sdk/openai's OpenAIChatLanguageModel.prototype.doGenerate and doStream.
 * These are the actual HTTP call sites — patching them intercepts all Vercel AI
 * generateText / streamText calls regardless of ESM/CJS module boundaries.
 */
async function _patchAiSdkOpenaiProto(adapter: VercelAIAdapterLike): Promise<void> {
  try {
    const cwdReq = createRequire(process.cwd() + '/package.json');
    const resolvedCJSPath = cwdReq.resolve('@ai-sdk/openai');

    // Resolve the ESM entry point from the package's exports map.
    // @ai-sdk/openai ships both CJS (dist/index.js) and ESM (dist/index.mjs).
    // Users import the ESM version; we must patch THAT class, not the CJS wrapper.
    let esmPath = resolvedCJSPath; // fallback to CJS path if ESM entry not found
    let dir = dirname(resolvedCJSPath);
    outer: while (dir !== dirname(dir)) {
      try {
        const pkgPath = pathResolve(dir, 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: string;
          exports?: Record<string, Record<string, string> | string>;
        };
        if (pkg.name === '@ai-sdk/openai') {
          const exportsRoot = pkg.exports?.['.'] as Record<string, string> | undefined;
          const esmRelPath = exportsRoot?.['import'] ?? './dist/index.mjs';
          esmPath = pathResolve(dir, esmRelPath);
          break outer;
        }
      } catch { /* keep walking */ }
      dir = dirname(dir);
    }

    // Import the ESM module — same instance all ESM callers (vercel-ts, mastra-ts) see.
    const mod = await import(pathToFileURL(esmPath).href) as Record<string, unknown>;
    const createOpenAI = (mod['createOpenAI'] ?? mod['default']) as
      ((opts: { apiKey: string }) => (modelId: string) => unknown) | undefined;

    if (typeof createOpenAI !== 'function') return;

    const provider = createOpenAI({ apiKey: '_syrin_probe_' });
    const modelInstance = provider('gpt-4o-mini') as Record<string, unknown>;
    const ModelClass = modelInstance.constructor as { prototype: Record<string, unknown> };
    const proto = ModelClass.prototype;

    if (
      typeof proto['doGenerate'] !== 'function' ||
      (proto['doGenerate'] as { name?: string }).name === 'patchedDoGenerate'
    ) return;

    _origDoGenerate = proto['doGenerate'] as (...args: unknown[]) => unknown;
    _origDoStream = proto['doStream'] as ((...args: unknown[]) => unknown) | null ?? null;
    _patchedModelProto = proto;

    proto['doGenerate'] = async function patchedDoGenerate(
      this: { modelId?: string; provider?: string },
      ...args: unknown[]
    ): Promise<unknown> {
      const start = Date.now();
      const modelId = this.modelId ?? 'unknown';
      const providerName = this.provider ?? 'openai';
      let response: Record<string, unknown> | null = null;
      try {
        response = await _origDoGenerate!.apply(this, args) as Record<string, unknown>;
        const usage = response?.['usage'] as Record<string, number> | null | undefined;
        adapter.emitLlmCallEvent({
          model: modelId,
          provider: providerName,
          inputTokens: usage?.['promptTokens'] ?? 0,
          outputTokens: usage?.['completionTokens'] ?? 0,
          durationMs: Date.now() - start,
          error: null,
        });
        return response;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        adapter.emitLlmCallEvent({
          model: modelId,
          provider: providerName,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: Date.now() - start,
          error: error.message,
        });
        throw err;
      }
    };

    if (_origDoStream && typeof proto['doStream'] === 'function') {
      proto['doStream'] = async function patchedDoStream(
        this: { modelId?: string; provider?: string },
        ...args: unknown[]
      ): Promise<unknown> {
        const start = Date.now();
        const modelId = this.modelId ?? 'unknown';
        const providerName = this.provider ?? 'openai';
        try {
          const streamResult = await _origDoStream!.apply(this, args) as Record<string, unknown>;
          // Wrap the stream to capture usage when it completes
          const originalStream = streamResult?.['stream'] as ReadableStream | AsyncIterable<unknown> | undefined;
          if (originalStream && Symbol.asyncIterator in Object(originalStream)) {
            const wrappedStream = _wrapStreamForUsage(
              originalStream as AsyncIterable<Record<string, unknown>>,
              adapter, modelId, providerName, start,
            );
            return { ...streamResult, stream: wrappedStream };
          }
          return streamResult;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          adapter.emitLlmCallEvent({
            model: modelId,
            provider: providerName,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: Date.now() - start,
            error: error.message,
          });
          throw err;
        }
      };
    }
  } catch {
    // Best-effort — not fatal if @ai-sdk/openai is not installed or patching fails
  }
}

async function* _wrapStreamForUsage(
  originalStream: AsyncIterable<Record<string, unknown>>,
  adapter: VercelAIAdapterLike,
  modelId: string,
  provider: string,
  start: number,
): AsyncGenerator<Record<string, unknown>> {
  let promptTokens = 0;
  let completionTokens = 0;
  try {
    for await (const chunk of originalStream) {
      if (chunk?.['type'] === 'finish') {
        const usage = chunk['usage'] as Record<string, number> | null | undefined;
        promptTokens = usage?.['promptTokens'] ?? 0;
        completionTokens = usage?.['completionTokens'] ?? 0;
      }
      yield chunk;
    }
    adapter.emitLlmCallEvent({
      model: modelId,
      provider,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      durationMs: Date.now() - start,
      error: null,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    adapter.emitLlmCallEvent({
      model: modelId,
      provider,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      durationMs: Date.now() - start,
      error: error.message,
    });
    throw err;
  }
}

export function unpatchVercelAI(): void {
  if (!_patchedVercelAI) return;

  // Restore prototype patches
  if (_patchedModelProto) {
    if (_origDoGenerate) _patchedModelProto['doGenerate'] = _origDoGenerate;
    if (_origDoStream) _patchedModelProto['doStream'] = _origDoStream;
  }
  _patchedModelProto = null;
  _origDoGenerate = null;
  _origDoStream = null;

  // Restore ai module exports
  const trySet = (ref: Record<string, unknown>, key: string, value: unknown) => {
    try { ref[key] = value; } catch { /* read-only ESM binding */ }
  };
  if (_aiModuleRef) {
    if (_originalGenerateText) trySet(_aiModuleRef, 'generateText', _originalGenerateText);
    if (_originalStreamText) trySet(_aiModuleRef, 'streamText', _originalStreamText);
    if (_originalGenerateObject) trySet(_aiModuleRef, 'generateObject', _originalGenerateObject);
  }
  _aiModuleRef = null;
  _originalGenerateText = null;
  _originalStreamText = null;
  _originalGenerateObject = null;
  _patchedVercelAI = false;
}
