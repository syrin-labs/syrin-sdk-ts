/**
 * Syrin SDK — Mastra Adapter (TypeScript)
 *
 * Instruments @mastra/core Agent instances with Syrin observability and remote
 * config injection.
 *
 * Patches:
 *   Agent.prototype.generate — emits LLM_CALL event for every generate() call
 *   Agent.prototype.stream   — emits LLM_CALL event after stream is consumed
 *
 * Config injection:
 *   getConfig("llm") fields (temperature, max_tokens, model) merged into call opts
 *
 * Integration:
 *   import { init } from "@syrin/sdk";
 *   import { MastraAdapter } from "@syrin/sdk";
 *   init({ apiKey: "...", adapters: [new MastraAdapter()] });
 */

import { BaseFrameworkAdapter } from '@/adapters/types';
import { withFrameworkContext } from '@/framework-context';
import { generateId, nowIso } from '@/utils';
import type { ISyrinCore, SchemaField } from '@/adapters/types';

// ---------------------------------------------------------------------------
// Module-level patch state (singleton per process)
// ---------------------------------------------------------------------------

let _patchedMastra = false;
let _agentProto: Record<string, unknown> | null = null;
let _originalGenerate: ((...args: unknown[]) => unknown) | null = null;
let _originalStream: ((...args: unknown[]) => unknown) | null = null;

// ---------------------------------------------------------------------------
// Model extraction helpers
// ---------------------------------------------------------------------------

interface ModelObject {
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
  const m = model as ModelObject;
  return {
    modelId: m.modelId ?? 'unknown',
    provider: m.provider ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------
// MastraAdapter
// ---------------------------------------------------------------------------

export class MastraAdapter extends BaseFrameworkAdapter {
  readonly name = 'mastra';

  override configSchema(): Record<string, SchemaField[]> {
    return {
      llm: [
        { name: 'model', type: 'str', default: null },
        { name: 'temperature', type: 'float', default: null, constraints: { ge: 0.0, le: 2.0 } },
        { name: 'max_tokens', type: 'int', default: null, constraints: { ge: 1 } },
      ],
    };
  }

  protected async _doInstall(_core: ISyrinCore): Promise<void> {
    await this._patchAgent();
  }

  protected _doUninstall(): void {
    this._unpatchAgent();
  }

  // -------------------------------------------------------------------------
  // Agent patching — wrap generate() and stream()
  // -------------------------------------------------------------------------

  private async _patchAgent(): Promise<void> {
    if (_patchedMastra) return;

    let mastraModule: Record<string, unknown>;
    try {
      mastraModule = (await import('@mastra/core')) as Record<string, unknown>;
    } catch {
      return;
    }

    const AgentClass = mastraModule['Agent'] as
      | { prototype: Record<string, unknown> }
      | undefined;

    if (!AgentClass?.prototype) return;

    const proto = AgentClass.prototype;
    _agentProto = proto;

    if (typeof proto['generate'] === 'function') {
      _originalGenerate = proto['generate'] as (...args: unknown[]) => unknown;
      proto['generate'] = this._makeGenerateWrapper(_originalGenerate);
    }

    if (typeof proto['stream'] === 'function') {
      _originalStream = proto['stream'] as (...args: unknown[]) => unknown;
      proto['stream'] = this._makeStreamWrapper(_originalStream);
    }

    _patchedMastra = true;
  }

  private _unpatchAgent(): void {
    if (!_patchedMastra) return;
    if (_agentProto) {
      if (_originalGenerate) _agentProto['generate'] = _originalGenerate;
      if (_originalStream) _agentProto['stream'] = _originalStream;
    }
    _agentProto = null;
    _originalGenerate = null;
    _originalStream = null;
    _patchedMastra = false;
  }

  // -------------------------------------------------------------------------
  // generate() wrapper
  // -------------------------------------------------------------------------

  private _makeGenerateWrapper(
    origFn: (...args: unknown[]) => unknown,
  ): (...args: unknown[]) => Promise<unknown> {
    const adapter = this;

    return async function patchedGenerate(
      this: Record<string, unknown>,
      prompt: unknown,
      opts?: Record<string, unknown>,
      ...rest: unknown[]
    ): Promise<unknown> {
      const agentName = typeof this['name'] === 'string' ? this['name'] : 'unknown';
      const { modelId, provider } = _extractModel(this['model']);

      // Inject config
      const llmCfg = adapter.getConfig('llm');
      const injectedOpts = adapter._injectLlmConfig(opts, llmCfg);

      const runId = generateId('mrun_');
      const start = Date.now();

      return withFrameworkContext(
        {
          framework: 'mastra',
          agentId: adapter.agentId,
          sessionId: adapter.sessionId ?? 'unknown',
          runId,
          extra: { agentName },
        },
        async () => {
          try {
            const result = (await origFn.call(this, prompt, injectedOpts, ...rest)) as {
              text?: string;
              usage?: {
                promptTokens?: number;
                completionTokens?: number;
                totalTokens?: number;
              } | null;
            } | null;

            const usage = result?.usage;
            const inputTokens = usage?.promptTokens ?? 0;
            const outputTokens = usage?.completionTokens ?? 0;

            adapter._emitLlmCallEvent({
              agentName,
              model: modelId,
              provider,
              inputTokens,
              outputTokens,
              durationMs: Date.now() - start,
              error: null,
            });

            return result;
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            adapter._emitLlmCallEvent({
              agentName,
              model: modelId,
              provider,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: Date.now() - start,
              error: error.message,
            });
            throw err;
          }
        },
      );
    };
  }

  // -------------------------------------------------------------------------
  // stream() wrapper
  // -------------------------------------------------------------------------

  private _makeStreamWrapper(
    origFn: (...args: unknown[]) => unknown,
  ): (...args: unknown[]) => AsyncGenerator<unknown> {
    const adapter = this;

    return async function* patchedStream(
      this: Record<string, unknown>,
      prompt: unknown,
      opts?: Record<string, unknown>,
      ...rest: unknown[]
    ): AsyncGenerator<unknown> {
      const agentName = typeof this['name'] === 'string' ? this['name'] : 'unknown';
      const { modelId, provider } = _extractModel(this['model']);

      // Inject config
      const llmCfg = adapter.getConfig('llm');
      const injectedOpts = adapter._injectLlmConfig(opts, llmCfg);

      const start = Date.now();

      // Call original — may return an AsyncGenerator or object with textStream
      const streamResult = origFn.call(this, prompt, injectedOpts, ...rest);

      // Determine if result is an async iterable
      const asyncIter = (streamResult as AsyncIterable<unknown>)?.[Symbol.asyncIterator];

      try {
        if (typeof asyncIter === 'function') {
          for await (const chunk of streamResult as AsyncIterable<unknown>) {
            yield chunk;
          }
        } else {
          // Resolve promise if needed, then iterate
          const resolved = await Promise.resolve(streamResult);
          const resolvedIter = (resolved as AsyncIterable<unknown>)?.[Symbol.asyncIterator];
          if (typeof resolvedIter === 'function') {
            for await (const chunk of resolved as AsyncIterable<unknown>) {
              yield chunk;
            }
          }
        }

        adapter._emitLlmCallEvent({
          agentName,
          model: modelId,
          provider,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: Date.now() - start,
          error: null,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        adapter._emitLlmCallEvent({
          agentName,
          model: modelId,
          provider,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: Date.now() - start,
          error: error.message,
        });
        throw err;
      }
    };
  }

  // -------------------------------------------------------------------------
  // Config injection helper
  // -------------------------------------------------------------------------

  private _injectLlmConfig(
    opts: Record<string, unknown> | undefined,
    llmCfg: Record<string, unknown>,
  ): Record<string, unknown> {
    const hasOverrides = Object.values(llmCfg).some((v) => v != null);
    if (!hasOverrides) return opts ?? {};

    const result = { ...(opts ?? {}) };
    for (const key of ['temperature', 'max_tokens', 'model'] as const) {
      if (llmCfg[key] != null) result[key] = llmCfg[key];
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // LLM_CALL event emitter
  // -------------------------------------------------------------------------

  private _emitLlmCallEvent(data: {
    agentName: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    error: string | null;
  }): void {
    this.emitEvent({
      event_id: generateId('evt_'),
      event_type: 'LLM_CALL',
      timestamp: nowIso(),
      session_id: this.sessionId,
      agent_id: this.agentId,
      framework: 'mastra',
      agent_name: data.agentName,
      model: data.model,
      provider: data.provider,
      input_tokens: data.inputTokens,
      output_tokens: data.outputTokens,
      duration_ms: data.durationMs,
      error: data.error,
    });
  }
}
