/**
 * LangChain Adapter — Callback handler
 *
 * Uses LangChain v0.3+ handler method names (handleLLMStart, handleLLMEnd, etc.)
 * Duck-typed — no @langchain/core dependency required.
 */

import { generateId, nowIso } from '@/utils/helpers.js';
import { isLLMPatched } from './patch-llm.js';

// Forward declaration to avoid circular import
export interface LangChainAdapterLike {
  emitEvent(event: Record<string, unknown>): void;
  readonly sessionId: string | undefined;
  readonly agentId: string | undefined;
}

/**
 * A LangChain-compatible callback handler (duck-typed — no @langchain/core dep).
 * Emits CHAIN_EXECUTION and LLM_CALL events via the adapter.
 *
 * LangChain v0.3+ callback API:
 *   Chain lifecycle: handleChainStart / handleChainEnd / handleChainError
 *   LLM  lifecycle:  handleLLMStart  / handleLLMEnd  / handleLLMError
 */
export class SyrinLangChainCallback {
  private readonly _adapter: LangChainAdapterLike;
  private readonly _chainName: string;

  // Chain timing
  private _chainRunId: string | null = null;
  private _chainStartTime = 0;

  // LLM timing
  private _llmStartTime = 0;
  private _llmModel = 'unknown';
  private _llmProvider = 'unknown';

  constructor(adapter: LangChainAdapterLike, chainName = 'langchain') {
    this._adapter = adapter;
    this._chainName = chainName;
  }

  // ── Chain lifecycle (LangChain v0.3+) ──────────────────────────────────────

  handleChainStart(
    _serialized: unknown,
    _inputs: unknown,
    runId?: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runType?: string,
    _runName?: string,
    _extra?: unknown,
  ): void {
    this._chainRunId = runId ?? generateId('lcrun_');
    this._chainStartTime = Date.now();
  }

  handleChainEnd(_outputs: unknown, _runId?: string, _parentRunId?: string, _tags?: string[], _kwargs?: unknown): void {
    const durationMs = Date.now() - this._chainStartTime;
    this._adapter.emitEvent({
      event_id: generateId('evt_'),
      event_type: 'CHAIN_EXECUTION',
      timestamp: nowIso(),
      session_id: this._adapter.sessionId,
      agent_id: this._adapter.agentId,
      chain_run_id: this._chainRunId,
      chain_name: this._chainName,
      duration_ms: durationMs,
      error: null,
      framework: 'langchain',
    });
  }

  handleChainError(error: Error | unknown, _runId?: string, _parentRunId?: string, _tags?: string[], _kwargs?: unknown): void {
    const durationMs = Date.now() - this._chainStartTime;
    this._adapter.emitEvent({
      event_id: generateId('evt_'),
      event_type: 'CHAIN_EXECUTION',
      timestamp: nowIso(),
      session_id: this._adapter.sessionId,
      agent_id: this._adapter.agentId,
      chain_run_id: this._chainRunId,
      chain_name: this._chainName,
      duration_ms: durationMs,
      error: error instanceof Error ? error.message : String(error),
      framework: 'langchain',
    });
  }

  // ── LLM lifecycle (LangChain v0.3+) ────────────────────────────────────────

  handleLLMStart(
    serialized: Record<string, unknown>,
    _prompts: unknown,
    _runId?: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runName?: string,
  ): void {
    this._llmStartTime = Date.now();
    // Best-effort model extraction from serialized LangChain object
    const kwargs = (serialized?.['kwargs'] as Record<string, unknown>) ?? {};
    const modelName = (kwargs['model_name'] ?? kwargs['model'] ?? serialized?.['name'] ?? 'unknown') as string;
    this._llmModel = String(modelName);
    // Infer provider from model name
    if (this._llmModel.includes('gpt') || this._llmModel.includes('o1')) {
      this._llmProvider = 'openai';
    } else if (this._llmModel.includes('claude')) {
      this._llmProvider = 'anthropic';
    } else if (this._llmModel.includes('gemini')) {
      this._llmProvider = 'google';
    } else {
      this._llmProvider = 'unknown';
    }
  }

  handleLLMEnd(
    response: Record<string, unknown>,
    _runId?: string,
    _parentRunId?: string,
    _tags?: string[],
    _extraParams?: unknown,
  ): void {
    // When BaseChatModel.prototype.generate is patched, Tier 1 already emits LLM_CALL.
    // Skip to avoid double-counting token costs.
    if (isLLMPatched()) return;

    const durationMs = Date.now() - this._llmStartTime;

    // Extract token usage from LangChain LLMResult
    let inputTokens = 0;
    let outputTokens = 0;

    const llmOutput = response?.['llmOutput'] as Record<string, unknown> | undefined;
    if (llmOutput) {
      const tokenUsage = (llmOutput['tokenUsage'] ?? llmOutput['token_usage']) as Record<string, number> | undefined;
      inputTokens = tokenUsage?.['promptTokens'] ?? tokenUsage?.['prompt_tokens'] ?? 0;
      outputTokens = tokenUsage?.['completionTokens'] ?? tokenUsage?.['completion_tokens'] ?? 0;
    }

    // Fallback: try generation-level info
    if (!inputTokens && !outputTokens) {
      const generations = (response?.['generations'] as unknown[][]) ?? [];
      const gen = generations[0]?.[0] as Record<string, unknown> | undefined;
      const genInfo = gen?.['generationInfo'] as Record<string, unknown> | undefined;
      inputTokens = Number(genInfo?.['prompt_tokens'] ?? 0);
      outputTokens = Number(genInfo?.['completion_tokens'] ?? 0);
    }

    this._adapter.emitEvent({
      event_id: generateId('evt_'),
      event_type: 'LLM_CALL',
      timestamp: nowIso(),
      session_id: this._adapter.sessionId,
      agent_id: this._adapter.agentId,
      framework: 'langchain',
      model: this._llmModel,
      provider: this._llmProvider,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms: durationMs,
      error: null,
    });
  }

  handleLLMError(
    error: Error | unknown,
    _runId?: string,
    _parentRunId?: string,
    _tags?: string[],
    _extraParams?: unknown,
  ): void {
    // When BaseChatModel.prototype.generate is patched, Tier 1 already emits LLM_CALL.
    if (isLLMPatched()) return;

    const durationMs = Date.now() - this._llmStartTime;
    this._adapter.emitEvent({
      event_id: generateId('evt_'),
      event_type: 'LLM_CALL',
      timestamp: nowIso(),
      session_id: this._adapter.sessionId,
      agent_id: this._adapter.agentId,
      framework: 'langchain',
      model: this._llmModel,
      provider: this._llmProvider,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
