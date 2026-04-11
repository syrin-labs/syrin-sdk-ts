/**
 * Syrin SDK — SyrinCore
 *
 * The provider-agnostic instrumentation engine. Owns:
 *   - Session resolution and governance action execution
 *   - Config override injection (temperature, model, system_prompt, tool filtering)
 *   - Telemetry event building and emission
 *   - OTel span recording
 *   - Loop signal observation
 *   - Checkpoint lifecycle (via CheckpointClient)
 *   - Adapter registry
 *
 * Adapters call beforeCall() / afterCall() / onStreamComplete() / onCallError()
 * to plug any LLM SDK into this engine without re-implementing any of the above.
 */

import type { SyrinConfig, SyrinEvent } from '@/types.js';
import { SDK_VERSION } from '@/config/config.js';
import type { SessionStore } from '@/core/session.js';
import { sessionStorage } from '@/core/session.js';
import type { Emitter } from '@/observability/emitter.js';
import type { OTelBridge } from '@/observability/otel.js';
import type { CheckpointClient } from '@/core/checkpoint.js';
import type {
  SyrinAdapter,
  ISyrinCore,
  NormalizedCallParams,
  NormalizedCallResult,
  BeforeCallResult,
  NormalizedMessage,
  SchemaField,
} from '@/adapters/types.js';
import { agentStorage } from '@/agent/context.js';
import { GovernanceStopError } from '@/core/governance.js';
import { getFrameworkContext } from '@/agent/framework-context.js';
import {
  generateId,
  nowIso,
  estimateCost,
  clampTemperature,
  isTemperatureUnsupported,
  hashSystemPrompt,
  hashToolSet,
  hashModelConfig,
  countMessages,
  contextSize,
  detectRefusal,
  stableHash,
} from '@/utils/helpers.js';
import { detectProvider } from '@/utils/provider.js';

// Re-export for convenience
export type { BeforeCallResult, NormalizedCallParams, NormalizedCallResult } from '@/adapters/types.js';

export class SyrinCore implements ISyrinCore {
  private readonly _adapters = new Map<string, SyrinAdapter>();

  constructor(
    readonly config: SyrinConfig,
    readonly sessionStore: SessionStore,
    private readonly _emitter: Emitter,
    private readonly _otelBridge: OTelBridge,
    readonly checkpointClient: CheckpointClient,
  ) {}

  // ── Adapter registry ────────────────────────────────────────────────────

  async registerAdapter(adapter: SyrinAdapter): Promise<void> {
    this._adapters.set(adapter.name, adapter);
    await adapter.install(this);
  }

  uninstallAdapter(name: string): void {
    this._adapters.get(name)?.uninstall();
    this._adapters.delete(name);
  }

  uninstallAll(): void {
    for (const adapter of this._adapters.values()) {
      adapter.uninstall();
    }
    this._adapters.clear();
  }

  isAdapterInstalled(name: string): boolean {
    return this._adapters.get(name)?.isInstalled() ?? false;
  }

  // ── Schema registration ──────────────────────────────────────────────────

  /**
   * Merge configSchema() from all installed adapters that expose it.
   * First-writer wins: if two adapters declare the same section+field, the first one wins.
   */
  buildSchema(): Record<string, unknown> {
    const sections: Record<string, Record<string, SchemaField>> = {};

    for (const adapter of this._adapters.values()) {
      const adapterSchema = adapter.configSchema();
      for (const [sectionName, fields] of Object.entries(adapterSchema)) {
        if (!sections[sectionName]) sections[sectionName] = {};
        for (const field of fields) {
          if (!sections[sectionName][field.name]) {
            sections[sectionName][field.name] = field;
          }
        }
      }
    }

    // Apply schemaDefaults — patch matching field defaults before returning.
    // Parity with Python SDK's schema_defaults option.
    const defaults = this.config.schemaDefaults ?? {};
    for (const [path, value] of Object.entries(defaults)) {
      const dot = path.indexOf('.');
      if (dot === -1) continue;
      const sec = path.slice(0, dot);
      const fieldName = path.slice(dot + 1);
      if (sections[sec]?.[fieldName]) {
        sections[sec][fieldName] = { ...sections[sec][fieldName], default: value };
      }
    }

    return {
      agent_id: this.config.agentId,
      sections: Object.fromEntries(
        Object.entries(sections).map(([sec, fields]) => [
          sec,
          { fields: Object.values(fields) },
        ])
      ),
    };
  }

  /**
   * POST the agent's config schema to the backend.
   * Applies any configDelta returned by the backend into the ConfigStore.
   * Non-fatal — network errors are silently swallowed.
   */
  async register(): Promise<void> {
    const agentId = this.config.agentId;
    if (!agentId) return;

    const schema = this.buildSchema();
    const payload = {
      agent_id: agentId,
      agent_framework: this._detectFramework(),
      sdk: { language: 'typescript', version: SDK_VERSION },
      schema,
      server_url: this.config.serverUrl ?? null,
    };

    const url = `${this.config.backendUrl}/agents/${agentId}/register`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = await res.json() as { configDelta?: Record<string, unknown> };
        const delta = body.configDelta ?? {};
        const configStore = (this as unknown as { _configStore?: { set(ns: string, key: string, value: unknown): void } })._configStore;
        if (configStore) {
          for (const [path, value] of Object.entries(delta)) {
            const dot = path.indexOf('.');
            if (dot !== -1) {
              const section = path.slice(0, dot);
              const key = path.slice(dot + 1);
              configStore.set(section, key, value);
            }
          }
        }
      }
    } catch {
      // Non-fatal — backend unreachable at startup is acceptable
    }
  }

  private _detectFramework(): string | undefined {
    // Tier 1: framework/orchestration adapters (preferred)
    const llmProviders = new Set(['openai', 'anthropic']);
    for (const adapter of this._adapters.values()) {
      if (!llmProviders.has(adapter.name)) {
        return adapter.name;
      }
    }
    // Tier 2: fall back to LLM provider name (parity with Python SDK)
    for (const adapter of this._adapters.values()) {
      if (llmProviders.has(adapter.name)) {
        return adapter.name;
      }
    }
    return undefined;
  }

  // ── Call lifecycle ───────────────────────────────────────────────────────

  /**
   * Called by the adapter BEFORE invoking the underlying SDK.
   *
   * Executes pending governance actions (stop → throw GovernanceStopError,
   * restore → swap messages, checkpoint → save to backend), applies effective
   * config overrides, and returns the modified params the adapter should use.
   *
   * @throws GovernanceStopError if the backend sent a stop action.
   */
  async beforeCall(params: NormalizedCallParams): Promise<BeforeCallResult> {
    // 1. Resolve session + agent context
    const sessionId = sessionStorage.getStore() ?? this.config.sessionId ?? generateId('ses_');
    const runCtx = agentStorage.getStore();
    const resolvedAgentId = runCtx?.agentId ?? this.config.agentId;
    const session = await this.sessionStore.getOrCreate(sessionId, resolvedAgentId);

    let modifiedRaw: Record<string, unknown> = { ...params.raw };
    let governanceApplied = false;

    // 2. Execute pending governance actions
    const pendingActions = this.sessionStore.popGovernanceActions(sessionId);
    const injectedMsgs = this.sessionStore.popInjectedMessages(sessionId);

    if (pendingActions.length > 0 || injectedMsgs.length > 0) {
      governanceApplied = true;
    }

    for (const action of pendingActions) {
      if (action.type === 'stop') {
        throw new GovernanceStopError(
          (action['reason'] as string) ?? 'Stopped by Syrin governance',
          action['incident_id'] as string | undefined
        );
      } else if (action.type === 'restore') {
        const checkpointId = action['checkpoint_id'] as string | undefined;
        if (checkpointId) {
          const cp = await this.checkpointClient.getById(checkpointId);
          if (cp) {
            modifiedRaw = { ...modifiedRaw, messages: [...cp.messages] };
          }
        }
      } else if (action.type === 'checkpoint') {
        const currentMsgs = Array.isArray(modifiedRaw['messages'])
          ? (modifiedRaw['messages'] as Array<Record<string, unknown>>)
          : [];
        const cp = await this.checkpointClient.save(sessionId, currentMsgs, {
          label: action['label'] as string | undefined,
          activeConfig: this.sessionStore.getEffectiveConfig(sessionId),
          callCount: session.callCount,
          cumulativeCostUsd: session.cumulativeCostUsd,
        });
        session.lastCheckpointId = cp.checkpointId;
      }
    }

    // Prepend injected messages
    if (injectedMsgs.length > 0) {
      const existing: Record<string, unknown>[] = Array.isArray(modifiedRaw['messages'])
        ? [...(modifiedRaw['messages'] as Record<string, unknown>[])]
        : [];
      modifiedRaw = { ...modifiedRaw, messages: [...injectedMsgs, ...existing] };
    }

    // 3. Apply effective config overrides
    const effectiveConfig = this.sessionStore.getEffectiveConfig(sessionId);
    let configApplied = governanceApplied;
    const model: string = (modifiedRaw['model'] as string) ?? params.model ?? 'gpt-4o';
    const tempUnsupported = isTemperatureUnsupported(model);

    if (!tempUnsupported && effectiveConfig['temperature'] !== undefined) {
      modifiedRaw['temperature'] = clampTemperature(effectiveConfig['temperature'] as number, model);
      configApplied = true;
    }
    if (effectiveConfig['max_tokens'] !== undefined) {
      modifiedRaw['max_tokens'] = effectiveConfig['max_tokens'];
      configApplied = true;
    }
    if (effectiveConfig['model'] !== undefined) {
      modifiedRaw['model'] = effectiveConfig['model'];
      configApplied = true;
    }

    // Sampling / decoding parameters — schema-controlled per adapter so only
    // applicable fields are ever present in effectiveConfig.
    for (const field of [
      'top_p', 'frequency_penalty', 'presence_penalty',
      'seed', 'n', 'top_k',
    ] as const) {
      if (effectiveConfig[field] !== undefined) {
        modifiedRaw[field] = effectiveConfig[field];
        configApplied = true;
      }
    }

    // System prompt injection
    if ('system_prompt' in effectiveConfig) {
      const systemPrompt = effectiveConfig['system_prompt'] as string | null;
      const isAnthropicFormat = 'system' in modifiedRaw;

      if (isAnthropicFormat) {
        // Anthropic: system prompt is a top-level `system` string field
        if (systemPrompt === null) {
          delete modifiedRaw['system'];
        } else {
          modifiedRaw['system'] = String(systemPrompt);
        }
      } else {
        // OpenAI-style: system prompt is the first message with role=system
        const msgs: Record<string, unknown>[] = Array.isArray(modifiedRaw['messages'])
          ? [...(modifiedRaw['messages'] as Record<string, unknown>[])]
          : [];
        if (systemPrompt === null) {
          modifiedRaw['messages'] = msgs.filter((m: Record<string, unknown>) => m?.role !== 'system');
        } else if (msgs.length > 0 && msgs[0]?.role === 'system') {
          modifiedRaw['messages'] = [{ role: 'system', content: String(systemPrompt) }, ...msgs.slice(1)];
        } else {
          modifiedRaw['messages'] = [{ role: 'system', content: String(systemPrompt) }, ...msgs];
        }
      }
      configApplied = true;
    }

    // Tool filtering
    const disabledTools = effectiveConfig['disabled_tools'] as string[] | undefined;
    const enabledTools  = effectiveConfig['enabled_tools']  as string[] | null | undefined;
    if ((disabledTools?.length || enabledTools !== undefined) && Array.isArray(modifiedRaw['tools'])) {
      const disabled = new Set<string>(disabledTools ?? []);
      const enabled  = enabledTools != null ? new Set<string>(enabledTools) : null;
      const filtered = (modifiedRaw['tools'] as Record<string, unknown>[]).filter((t: Record<string, unknown>) => {
        const name: string = ((t?.['function'] as { name?: string } | undefined)?.name) ?? '';
        if (disabled.has(name)) return false;
        if (enabled !== null && !enabled.has(name)) return false;
        return true;
      });
      if (filtered.length > 0) {
        modifiedRaw['tools'] = filtered;
      } else {
        delete modifiedRaw['tools'];
        delete modifiedRaw['tool_choice'];
        if (this.config.debug) console.log('[Syrin] All tools filtered out by remote config.');
      }
      configApplied = true;
    }

    const rawMessages = Array.isArray(modifiedRaw['messages']) ? modifiedRaw['messages'] : [];
    // Anthropic passes the system prompt as a separate top-level `system` field
    // (not inside the messages array). Prepend it as a synthetic system message
    // so it appears in prompt_messages in the dashboard context window.
    const anthropicSystem = modifiedRaw['system'];
    const modifiedMessages = (
      anthropicSystem && typeof anthropicSystem === 'string'
        ? [{ role: 'system', content: anthropicSystem }, ...rawMessages]
        : rawMessages
    ) as NormalizedMessage[];

    return {
      sessionId,
      agentId: resolvedAgentId,
      initialCumulativeCostUsd: session.cumulativeCostUsd,
      configApplied,
      governanceApplied,
      modifiedRaw,
      modifiedMessages,
      tempUnsupported,
    };
  }

  /**
   * Called by the adapter after a successful non-streaming LLM call.
   * Records cost, emits SyrinEvent (LLM_CALL), records OTel span.
   */
  afterCall(
    ctx: BeforeCallResult,
    _params: NormalizedCallParams,
    result: NormalizedCallResult,
  ): void {
    this._recordAndEmit(ctx, result);
  }

  /**
   * Called by the adapter once a streaming response has been fully consumed
   * (from the adapter's stream-wrapping `finally` block).
   */
  onStreamComplete(
    ctx: BeforeCallResult,
    _params: NormalizedCallParams,
    result: NormalizedCallResult,
  ): void {
    this._recordAndEmit(ctx, result);
  }

  /**
   * Called by the adapter when the underlying SDK throws an error.
   * `ctx` may be null if the error occurred before beforeCall() resolved.
   */
  onCallError(
    ctx: BeforeCallResult | null,
    params: NormalizedCallParams,
    error: Error,
    durationMs: number,
  ): void {
    const sessionId = ctx?.sessionId ?? (this.config.sessionId ?? 'unknown');
    const model = params.model ?? 'unknown';
    const provider = detectProvider(model);
    const tempUnsupported = ctx?.tempUnsupported ?? isTemperatureUnsupported(model);
    const configApplied = ctx?.configApplied ?? false;

    const errorEvent: SyrinEvent = {
      event_id: generateId('evt_'),
      event_type: 'LLM_ERROR',
      timestamp: nowIso(),
      duration_ms: durationMs,
      model,
      provider,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      temperature: tempUnsupported ? undefined : params.temperature,
      max_tokens: params.max_tokens,
      stream: params.stream,
      error: error.message,
      config_applied: configApplied,
      ..._runCtxFields(),
    };

    this._emitter.emit(errorEvent, sessionId);

    this._otelBridge.recordSpan({
      model,
      provider,
      temperature: tempUnsupported ? undefined : params.temperature,
      maxTokens: params.max_tokens,
      inputTokens: 0,
      outputTokens: 0,
      finishReason: 'error',
      durationMs,
      costUsd: 0,
      cumulativeCostUsd: ctx?.initialCumulativeCostUsd ?? 0,
      agentId: ctx?.agentId,
      sessionId,
      configApplied,
      error,
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _recordAndEmit(ctx: BeforeCallResult, result: NormalizedCallResult): void {
    const {
      sessionId, agentId, configApplied, governanceApplied,
      modifiedMessages, modifiedRaw, tempUnsupported,
    } = ctx;
    const {
      model, inputTokens, outputTokens, finishReason, durationMs,
      toolCalls, toolDefinitions, responseText, stream,
    } = result;

    const costUsd = estimateCost(model, inputTokens, outputTokens);
    const provider = detectProvider(model);

    this.sessionStore.recordCall(sessionId, costUsd);
    this.sessionStore.incrementCallIndex(sessionId);
    const updatedSession = this.sessionStore.getSession(sessionId);

    const ctxSize = contextSize(model);
    const totalTokens = inputTokens + outputTokens;

    // Compute conversationHash as a raw signal (backend decides if there's a loop)
    const conversationHash = stableHash(
      JSON.stringify(modifiedMessages.map((m) => ({ role: m.role ?? '', content: String(m.content ?? '') })))
    );

    const event: SyrinEvent = {
      event_id: generateId('evt_'),
      event_type: 'LLM_CALL',
      timestamp: nowIso(),
      duration_ms: durationMs,
      model,
      provider,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      temperature: tempUnsupported ? undefined : (modifiedRaw['temperature'] as number | undefined),
      max_tokens: modifiedRaw['max_tokens'] as number | undefined,
      finish_reason: finishReason,
      stream,
      config_applied: configApplied,
      governance_applied: governanceApplied,
      ..._runCtxFields(),
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      ...(toolDefinitions?.length ? { tool_definitions: toolDefinitions } : {}),
      call_index: updatedSession?.callIndex ?? 0,
      message_count: modifiedMessages.length,
      message_counts: countMessages(modifiedMessages),
      system_prompt_hash: hashSystemPrompt(modifiedMessages),
      tool_set_hash: hashToolSet(modifiedRaw['tools'] as Array<Record<string, unknown>> | undefined),
      model_config_hash: hashModelConfig({
        model,
        temperature: tempUnsupported ? undefined : (modifiedRaw['temperature'] as number | undefined),
        max_tokens: modifiedRaw['max_tokens'] as number | undefined,
      }),
      ...(ctxSize ? {
        context_tokens_used: totalTokens,
        context_utilization: parseFloat((totalTokens / ctxSize).toFixed(4)),
      } : {}),
      conversation_hash: conversationHash,
      response_char_count: responseText?.length,
      has_refusal: detectRefusal(responseText),
      last_checkpoint_id: updatedSession?.lastCheckpointId,
      // Full content — only when capture_content=true (off by default for privacy)
      ...(this.config.captureContent ? {
        prompt_messages: modifiedMessages,
        ...(responseText != null ? { completion_text: responseText } : {}),
      } : {}),
      // Framework context — injected by Tier 2 adapters (LangGraph, LangChain, etc.)
      ...(() => {
        const fwCtx = getFrameworkContext();
        if (!fwCtx) return {};
        return {
          framework: fwCtx.framework,
          ...(fwCtx.graphId ? { graph_id: fwCtx.graphId } : {}),
          ...(fwCtx.nodeName ? { node_name: fwCtx.nodeName } : {}),
        };
      })(),
    };

    this._emitter.emit(event, sessionId);

    if (this.config.toolValidation && toolCalls?.length) {
      this._emitter.flush().catch((err) => {
        if (this.config.debug) console.warn('[Syrin] Tool validation flush error:', err);
      });
    }

    // Read framework context for OTel attributes
    const fwCtx = getFrameworkContext();

    this._otelBridge.recordSpan({
      model,
      provider,
      temperature: tempUnsupported ? undefined : (modifiedRaw['temperature'] as number | undefined),
      maxTokens: modifiedRaw['max_tokens'] as number | undefined,
      topP: modifiedRaw['top_p'] as number | undefined,
      frequencyPenalty: modifiedRaw['frequency_penalty'] as number | undefined,
      presencePenalty: modifiedRaw['presence_penalty'] as number | undefined,
      stop: modifiedRaw['stop'] as string | string[] | undefined,
      inputTokens,
      outputTokens,
      finishReason,
      durationMs,
      costUsd,
      cumulativeCostUsd: updatedSession?.cumulativeCostUsd ?? costUsd,
      agentId,
      sessionId,
      configApplied,
      messages: this.config.captureContent ? (modifiedMessages as unknown[]) : undefined,
      responseText: this.config.captureContent ? responseText : undefined,
      // Framework context
      framework: fwCtx?.framework,
      langgraphGraphId: fwCtx?.graphId,
      langgraphNodeName: fwCtx?.nodeName,
      // Telemetry signal attributes
      callIndex: updatedSession?.callIndex ?? 0,
      contextUtilization: ctxSize ? parseFloat((totalTokens / ctxSize).toFixed(4)) : undefined,
      conversationHash,
      systemPromptHash: event.system_prompt_hash,
      toolSetHash: event.tool_set_hash,
      modelConfigHash: event.model_config_hash,
      messageCount: modifiedMessages.length,
    });
  }
}

/** Read current run context fields — safe to call anywhere. */
function _runCtxFields(): Pick<SyrinEvent, 'run_id' | 'workflow_id' | 'swarm_id' | 'parent_run_id'> {
  const ctx = agentStorage.getStore();
  if (!ctx) return {};
  return {
    run_id: ctx.runId,
    workflow_id: ctx.workflowId,
    swarm_id: ctx.swarmId,
    parent_run_id: ctx.parentRunId,
  };
}
