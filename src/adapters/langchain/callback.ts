/**
 * LangChain Adapter — Callback handler
 */

import { generateId, nowIso } from '@/utils/helpers.js';

// Forward declaration to avoid circular import
export interface LangChainAdapterLike {
  emitEvent(event: Record<string, unknown>): void;
}

/**
 * A LangChain-compatible callback handler (duck-typed — no @langchain/core dep).
 * Tracks chain execution timing and emits CHAIN_EXECUTION events via the adapter.
 */
export class SyrinLangChainCallback {
  private readonly _adapter: LangChainAdapterLike;
  private readonly _chainName: string;
  private _runId: string | null = null;
  private _startTime = 0;

  constructor(adapter: LangChainAdapterLike, chainName = 'langchain') {
    this._adapter = adapter;
    this._chainName = chainName;
  }

  onChainStart(
    _serialized: unknown,
    _inputs: unknown,
    options?: { runId?: string },
  ): void {
    this._runId = options?.runId ?? generateId('lcrun_');
    this._startTime = Date.now();
  }

  onChainEnd(_outputs: unknown, _options?: unknown): void {
    const durationMs = Date.now() - this._startTime;
    this._adapter.emitEvent({
      eventId: generateId('evt_'),
      eventType: 'CHAIN_EXECUTION',
      timestamp: nowIso(),
      chainRunId: this._runId,
      chainName: this._chainName,
      durationMs,
      error: null,
      framework: 'langchain',
    });
  }

  onChainError(error: Error | unknown, _options?: unknown): void {
    const durationMs = Date.now() - this._startTime;
    this._adapter.emitEvent({
      eventId: generateId('evt_'),
      eventType: 'CHAIN_EXECUTION',
      timestamp: nowIso(),
      chainRunId: this._runId,
      chainName: this._chainName,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
      framework: 'langchain',
    });
  }

  // Stub handlers — LLM_CALL telemetry is handled by the Tier 1 adapter
  onLlmStart(_serialized: unknown, _prompts: unknown, _options?: unknown): void {}
  onLlmEnd(_response: unknown, _options?: unknown): void {}
  onLlmError(_error: unknown, _options?: unknown): void {}
}
