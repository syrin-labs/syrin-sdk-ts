/**
 * Syrin SDK — Vercel AI SDK Adapter (TypeScript)
 *
 * Instruments the `ai` (Vercel AI SDK) standalone functions with Syrin observability
 * and remote config injection.
 *
 * Patches:
 *   generateText    — emits LLM_CALL event after completion
 *   streamText      — emits LLM_CALL event after stream+usage settle
 *   generateObject  — emits LLM_CALL event with operation="generateObject"
 *
 * Config injection:
 *   getConfig("llm") fields (temperature, max_tokens, model) merged into call opts
 *
 * Integration:
 *   import { init } from "@syrin/sdk";
 *   import { VercelAIAdapter } from "@syrin/sdk";
 *   init({ apiKey: "...", adapters: [new VercelAIAdapter()] });
 *
 * Note: `ai` is an optional peer dependency. If absent, adapter installs gracefully
 * (no-op). Guard all imports in try/catch.
 */

import { BaseFrameworkAdapter } from '@/adapters/types';
import { withFrameworkContext } from '@/framework-context';
import { generateId, nowIso } from '@/utils';
import type { ISyrinCore } from '@/adapters/types';

// ---------------------------------------------------------------------------
// Module-level patch state (singleton per process)
// ---------------------------------------------------------------------------

let _patchedVercelAI = false;
let _aiModuleRef: Record<string, unknown> | null = null;
let _originalGenerateText: ((...args: unknown[]) => unknown) | null = null;
let _originalStreamText: ((...args: unknown[]) => unknown) | null = null;
let _originalGenerateObject: ((...args: unknown[]) => unknown) | null = null;

// ---------------------------------------------------------------------------
// Model extraction helper
// ---------------------------------------------------------------------------

interface VercelAIModel {
  modelId?: string;
  provider?: string;
}

function _extractModel(model: unknown): { modelId: string; provider: string } {
  if (model == null) {
    return { modelId: 'unknown', provider: 'unknown' };
  }
  if (typeof model === 'string') {
    return { modelId: model, provider: 'unknown' };
  }
  const m = model as VercelAIModel;
  return {
    modelId: m.modelId ?? 'unknown',
    provider: m.provider ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------
// VercelAIAdapter
// ---------------------------------------------------------------------------

export class VercelAIAdapter extends BaseFrameworkAdapter {
  readonly name = 'vercel-ai';

  protected async _doInstall(_core: ISyrinCore): Promise<void> {
    await this._patchAiModule();
  }

  protected _doUninstall(): void {
    this._unpatchAiModule();
  }

  // -------------------------------------------------------------------------
  // Patch `ai` module functions
  // -------------------------------------------------------------------------

  private async _patchAiModule(): Promise<void> {
    if (_patchedVercelAI) return;

    let aiModule: Record<string, unknown>;
    try {
      aiModule = (await import('ai')) as Record<string, unknown>;
    } catch {
      return;
    }

    _aiModuleRef = aiModule;

    if (typeof aiModule['generateText'] === 'function') {
      _originalGenerateText = aiModule['generateText'] as (...args: unknown[]) => unknown;
      aiModule['generateText'] = this._makeGenerateTextWrapper(_originalGenerateText);
    }

    if (typeof aiModule['streamText'] === 'function') {
      _originalStreamText = aiModule['streamText'] as (...args: unknown[]) => unknown;
      aiModule['streamText'] = this._makeStreamTextWrapper(_originalStreamText);
    }

    if (typeof aiModule['generateObject'] === 'function') {
      _originalGenerateObject = aiModule['generateObject'] as (...args: unknown[]) => unknown;
      aiModule['generateObject'] = this._makeGenerateObjectWrapper(_originalGenerateObject);
    }

    _patchedVercelAI = true;
  }

  private _unpatchAiModule(): void {
    if (!_patchedVercelAI) return;
    if (_aiModuleRef) {
      if (_originalGenerateText) _aiModuleRef['generateText'] = _originalGenerateText;
      if (_originalStreamText) _aiModuleRef['streamText'] = _originalStreamText;
      if (_originalGenerateObject) _aiModuleRef['generateObject'] = _originalGenerateObject;
    }
    _aiModuleRef = null;
    _originalGenerateText = null;
    _originalStreamText = null;
    _originalGenerateObject = null;
    _patchedVercelAI = false;
  }

  // -------------------------------------------------------------------------
  // generateText wrapper
  // -------------------------------------------------------------------------

  private _makeGenerateTextWrapper(
    origFn: (...args: unknown[]) => unknown,
  ): (...args: unknown[]) => Promise<unknown> {
    const adapter = this;

    return async function patchedGenerateText(
      opts: Record<string, unknown>,
      ...rest: unknown[]
    ): Promise<unknown> {
      const { modelId, provider } = _extractModel(opts['model']);

      // Inject config
      const llmCfg = adapter.getConfig('llm');
      const injectedOpts = adapter._injectLlmConfig(opts, llmCfg);

      const runId = generateId('vairun_');
      const start = Date.now();

      return withFrameworkContext(
        {
          framework: 'vercel-ai',
          agentId: adapter.agentId,
          sessionId: adapter.sessionId ?? 'unknown',
          runId,
          extra: {},
        },
        async () => {
          try {
            const result = (await origFn(injectedOpts, ...rest)) as {
              text?: string;
              usage?: {
                promptTokens?: number;
                completionTokens?: number;
              } | null;
            } | null;

            const usage = result?.usage;
            const inputTokens = usage?.promptTokens ?? 0;
            const outputTokens = usage?.completionTokens ?? 0;

            adapter._emitLlmCallEvent({
              model: modelId,
              provider,
              inputTokens,
              outputTokens,
              durationMs: Date.now() - start,
              error: null,
              operation: 'generateText',
            });

            return result;
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            adapter._emitLlmCallEvent({
              model: modelId,
              provider,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: Date.now() - start,
              error: error.message,
              operation: 'generateText',
            });
            throw err;
          }
        },
      );
    };
  }

  // -------------------------------------------------------------------------
  // streamText wrapper
  // -------------------------------------------------------------------------

  private _makeStreamTextWrapper(
    origFn: (...args: unknown[]) => unknown,
  ): (...args: unknown[]) => unknown {
    const adapter = this;

    return function patchedStreamText(
      opts: Record<string, unknown>,
      ...rest: unknown[]
    ): unknown {
      const { modelId, provider } = _extractModel(opts['model']);

      // Inject config
      const llmCfg = adapter.getConfig('llm');
      const injectedOpts = adapter._injectLlmConfig(opts, llmCfg);

      const start = Date.now();

      return withFrameworkContext(
        {
          framework: 'vercel-ai',
          agentId: adapter.agentId,
          sessionId: adapter.sessionId ?? 'unknown',
          runId: generateId('vairun_'),
          extra: {},
        },
        () => {
          const streamResult = origFn(injectedOpts, ...rest) as {
            textStream: AsyncIterable<string>;
            usage: Promise<{
              promptTokens?: number;
              completionTokens?: number;
            } | null | undefined>;
          };

          // Wrap usage promise to emit event after usage settles
          const wrappedUsage: Promise<unknown> = streamResult.usage.then(
            (usage) => {
              const inputTokens = usage?.promptTokens ?? 0;
              const outputTokens = usage?.completionTokens ?? 0;
              adapter._emitLlmCallEvent({
                model: modelId,
                provider,
                inputTokens,
                outputTokens,
                durationMs: Date.now() - start,
                error: null,
                operation: 'streamText',
              });
              return usage;
            },
            (err: unknown) => {
              const error = err instanceof Error ? err : new Error(String(err));
              adapter._emitLlmCallEvent({
                model: modelId,
                provider,
                inputTokens: 0,
                outputTokens: 0,
                durationMs: Date.now() - start,
                error: error.message,
                operation: 'streamText',
              });
              throw err;
            },
          );

          return {
            ...streamResult,
            usage: wrappedUsage,
          };
        },
      );
    };
  }

  // -------------------------------------------------------------------------
  // generateObject wrapper
  // -------------------------------------------------------------------------

  private _makeGenerateObjectWrapper(
    origFn: (...args: unknown[]) => unknown,
  ): (...args: unknown[]) => Promise<unknown> {
    const adapter = this;

    return async function patchedGenerateObject(
      opts: Record<string, unknown>,
      ...rest: unknown[]
    ): Promise<unknown> {
      const { modelId, provider } = _extractModel(opts['model']);

      // Inject config
      const llmCfg = adapter.getConfig('llm');
      const injectedOpts = adapter._injectLlmConfig(opts, llmCfg);

      const runId = generateId('vairun_');
      const start = Date.now();

      return withFrameworkContext(
        {
          framework: 'vercel-ai',
          agentId: adapter.agentId,
          sessionId: adapter.sessionId ?? 'unknown',
          runId,
          extra: {},
        },
        async () => {
          try {
            const result = (await origFn(injectedOpts, ...rest)) as {
              object?: unknown;
              usage?: {
                promptTokens?: number;
                completionTokens?: number;
              } | null;
            } | null;

            const usage = result?.usage;
            const inputTokens = usage?.promptTokens ?? 0;
            const outputTokens = usage?.completionTokens ?? 0;

            adapter._emitLlmCallEvent({
              model: modelId,
              provider,
              inputTokens,
              outputTokens,
              durationMs: Date.now() - start,
              error: null,
              operation: 'generateObject',
            });

            return result;
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            adapter._emitLlmCallEvent({
              model: modelId,
              provider,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: Date.now() - start,
              error: error.message,
              operation: 'generateObject',
            });
            throw err;
          }
        },
      );
    };
  }

  // -------------------------------------------------------------------------
  // Config injection helper
  // -------------------------------------------------------------------------

  private _injectLlmConfig(
    opts: Record<string, unknown>,
    llmCfg: Record<string, unknown>,
  ): Record<string, unknown> {
    const hasOverrides = Object.values(llmCfg).some((v) => v != null);
    if (!hasOverrides) return opts;

    const result = { ...opts };
    for (const key of ['temperature', 'max_tokens', 'model'] as const) {
      if (llmCfg[key] != null) result[key] = llmCfg[key];
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // LLM_CALL event emitter
  // -------------------------------------------------------------------------

  private _emitLlmCallEvent(data: {
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    error: string | null;
    operation: string;
  }): void {
    this.emitEvent({
      event_id: generateId('evt_'),
      event_type: 'LLM_CALL',
      timestamp: nowIso(),
      session_id: this.sessionId,
      agent_id: this.agentId,
      framework: 'vercel-ai',
      model: data.model,
      provider: data.provider,
      input_tokens: data.inputTokens,
      output_tokens: data.outputTokens,
      duration_ms: data.durationMs,
      error: data.error,
      operation: data.operation,
    });
  }
}
