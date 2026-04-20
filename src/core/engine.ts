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

  /** ConfigStore wired in by init() — exposes remote config to adapters. */
  _configStore: import('../config/store.js').ConfigStore | null = null;

  /** TunableRegistry wired in by init(). */
  private _tunableRegistry: import('../tunable/tunable.js').TunableRegistry | null = null;

  /** Code-scan defaults populated at init() time. */
  private _codeScannedDefaults: Array<{ path: string; default: unknown }> = [];

  /** Per-agent observability settings — populated via registerAgent(). */
  private readonly _agentRegistry = new Map<string, import('../types.js').AgentConfig>();

  /** Endpoint input schemas — populated via registerEndpoint(). */
  private readonly _endpointInputs = new Map<string, unknown>();

  constructor(
    readonly config: SyrinConfig,
    readonly sessionStore: SessionStore,
    private readonly _emitter: Emitter,
    private readonly _otelBridge: OTelBridge,
    readonly checkpointClient: CheckpointClient,
  ) {}

  // ── Config/tunable wiring ────────────────────────────────────────────────

  setConfigStore(store: import('../config/store.js').ConfigStore): void {
    this._configStore = store;
  }

  getConfigStore(): import('../config/store.js').ConfigStore | null {
    return this._configStore;
  }

  setTunableRegistry(registry: import('../tunable/tunable.js').TunableRegistry): void {
    this._tunableRegistry = registry;
  }

  getTunableRegistry(): import('../tunable/tunable.js').TunableRegistry | null {
    return this._tunableRegistry;
  }

  setCodeScannedDefaults(defaults: Array<{ path: string; default: unknown }>): void {
    this._codeScannedDefaults = defaults;
  }

  getEmitter(): Emitter {
    return this._emitter;
  }

  // ── Agent / endpoint registry ────────────────────────────────────────────

  registerAgent(config: import('../types.js').AgentConfig): void {
    this._agentRegistry.set(config.agentId, config);
    if (config.sections && this._configStore) {
      for (const [secName, secDef] of Object.entries(config.sections)) {
        const ns = `agents.${config.agentId}.${secName}`;
        try {
          const fields: Record<string, { type: unknown; default?: unknown }> = {};
          for (const f of (secDef as { fields?: Array<{ name: string; type?: string; default?: unknown }> }).fields ?? []) {
            fields[f.name] = { type: f.type ?? 'str', default: f.default };
          }
          this._configStore.registerSection(ns, fields as Parameters<typeof this._configStore.registerSection>[1]);
        } catch { /* ignore registration errors */ }
      }
    }
  }

  getAgentConfig(agentId: string): import('../types.js').AgentConfig | undefined {
    return this._agentRegistry.get(agentId);
  }

  async registerEndpoint(endpoint: string, schema: unknown): Promise<void> {
    this._endpointInputs.set(endpoint, schema);
  }

  // ── Adapter registry ────────────────────────────────────────────────────

  async registerAdapter(adapter: SyrinAdapter): Promise<void> {
    if (!adapter || typeof adapter !== 'object' ||
        typeof adapter.install !== 'function' ||
        typeof adapter.uninstall !== 'function' ||
        typeof adapter.isInstalled !== 'function' ||
        typeof adapter.name !== 'string' ||
        typeof adapter.configSchema !== 'function') {
      throw new Error(`[Syrin] registerAdapter() requires an object implementing SyrinSDKAdapter. Got: ${typeof adapter}`);
    }
    // Idempotent: if same adapter name is already installed, skip install() call
    const existing = this._adapters.get(adapter.name);
    if (existing?.isInstalled()) {
      this._adapters.set(adapter.name, adapter);
      return;
    }
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
    // v2 format: { version: 2, agent_id, global: { [section]: { fields: [...] } }, agents: {} }
    const globalSections: Record<string, Record<string, SchemaField>> = {};

    // 1. Adapter schemas (adapters are telemetry-only so typically return {})
    for (const adapter of this._adapters.values()) {
      const adapterSchema = adapter.configSchema();
      for (const [sectionName, fields] of Object.entries(adapterSchema)) {
        if (!globalSections[sectionName]) globalSections[sectionName] = {};
        for (const field of fields) {
          if (!globalSections[sectionName][field.name]) {
            globalSections[sectionName][field.name] = field;
          }
        }
      }
    }

    // 2. ConfigStore compound namespaces (from cfg() calls): 'global.llm' → 'llm' section
    const configStore = this._configStore;
    if (configStore) {
      const storeSections = (configStore as unknown as { _sections: Record<string, Record<string, Record<string, unknown>>> })._sections ?? {};
      for (const [ns, fields] of Object.entries(storeSections)) {
        // Only handle 'global.*' namespaces for the global schema
        if (!ns.startsWith('global.')) continue;
        const sectionName = ns.slice('global.'.length);
        if (!globalSections[sectionName]) globalSections[sectionName] = {};
        for (const [fieldName, rawField] of Object.entries(fields)) {
          if (!globalSections[sectionName][fieldName]) {
            // Normalize: flat ge/le into nested constraints object
            const field = rawField as Record<string, unknown>;
            const constraints: Record<string, number> = {};
            if (field['ge'] != null) constraints['ge'] = field['ge'] as number;
            if (field['le'] != null) constraints['le'] = field['le'] as number;
            if (field['gt'] != null) constraints['gt'] = field['gt'] as number;
            if (field['lt'] != null) constraints['lt'] = field['lt'] as number;
            const normalized: SchemaField = {
              name: fieldName,
              type: (field['type'] as SchemaField['type']) ?? 'str',
              default: field['default'] ?? null,
              ...(Object.keys(constraints).length ? { constraints } : {}),
            };
            globalSections[sectionName][fieldName] = normalized;
          }
        }
      }
    }

    // 3. Apply schemaDefaults
    const defaults = this.config.schemaDefaults ?? {};
    for (const [path, value] of Object.entries(defaults)) {
      const dot = path.indexOf('.');
      if (dot === -1) continue;
      const sec = path.slice(0, dot);
      const fieldName = path.slice(dot + 1);
      if (globalSections[sec]?.[fieldName]) {
        globalSections[sec][fieldName] = { ...globalSections[sec][fieldName], default: value };
      }
    }

    return {
      version: 2,
      agent_id: this.config.agentId,
      global: Object.fromEntries(
        Object.entries(globalSections).map(([sec, fields]) => [
          sec,
          { fields: Object.values(fields) },
        ])
      ),
      agents: {},
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

    const url = `${this.config.backendUrl}/api/v1/agents/${agentId}/register`;

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

  /** Optional manual override — set via setAgentFramework(). */
  private _agentFramework: string | undefined = undefined;

  setAgentFramework(framework: string): void {
    this._agentFramework = framework;
  }

  _detectFramework(): string | undefined {
    if (this._agentFramework) return this._agentFramework;
    // Return first orchestration/framework adapter — LLM providers (openai, anthropic) are NOT a framework
    const llmProviders = new Set(['openai', 'anthropic']);
    for (const adapter of this._adapters.values()) {
      if (!llmProviders.has(adapter.name)) {
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

    // mutation_hash — tracks how conversation changed between calls
    const prevConvHash = updatedSession?.lastConversationHash ?? null;
    const mutationHash = stableHash(`${prevConvHash ?? ''}|${conversationHash}`).slice(0, 16);
    if (updatedSession) {
      updatedSession.lastConversationHash = conversationHash;
    }

    // tool_call_hash — order-independent hash of tool calls in the response
    const toolCallHash = (() => {
      const calls = result.toolCalls;
      if (!calls?.length) return null;
      const entries = calls
        .map((tc) => ({ name: tc.name ?? '', args: tc.arguments ?? '' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return stableHash(JSON.stringify(entries)).slice(0, 16);
    })();

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
      mutation_hash: mutationHash,
      tool_call_hash: toolCallHash,
      response_char_count: responseText?.length,
      has_refusal: detectRefusal(responseText),
      last_checkpoint_id: updatedSession?.lastCheckpointId,
      // Full content — only when capture_content=true (off by default for privacy)
      ...(this.config.captureContent ? {
        prompt_messages: modifiedMessages,
        ...(responseText != null ? { completion_text: responseText } : {}),
      } : {}),
      // Framework context — injected by framework adapters via AsyncLocalStorage
      ...(() => {
        const fwCtx = getFrameworkContext();
        if (!fwCtx) return {};
        return {};
      })(),
    };

    // Emit TOOL_RESULT for each role='tool' message BEFORE the LLM_CALL event.
    for (const msg of ctx.modifiedMessages ?? []) {
      if ((msg as unknown as Record<string, unknown>)['role'] === 'tool') {
        const m = msg as unknown as Record<string, unknown>;
        try {
          this._emitter.emit({
            event_id: generateId('evt_'),
            event_type: 'TOOL_RESULT',
            timestamp: nowIso(),
            session_id: sessionId,
            agent_id: agentId ?? undefined,
            run_id: agentStorage.getStore()?.runId,
            trace_id: agentStorage.getStore()?.traceId,
            tool_call_id: m['tool_call_id'] ?? '',
            tool_name: m['name'] ?? '',
            tool_result: String(m['content'] ?? ''),
            model,
            provider,
            duration_ms: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
            stream: false,
            config_applied: false,
          } as SyrinEvent, sessionId);
        } catch { /* fail-open */ }
      }
    }

    this._emitter.emit(event, sessionId);

    // Emit TOOL_CALL for each tool call in the LLM response AFTER the LLM_CALL event.
    for (const tc of toolCalls ?? []) {
      try {
        this._emitter.emit({
          event_id: generateId('evt_'),
          event_type: 'TOOL_CALL',
          timestamp: nowIso(),
          session_id: sessionId,
          agent_id: agentId ?? undefined,
          run_id: agentStorage.getStore()?.runId,
          trace_id: agentStorage.getStore()?.traceId,
          tool_name: tc.name ?? '',
          tool_call_id: tc.id ?? '',
          tool_arguments: tc.arguments ?? '',
          model,
          provider,
          duration_ms: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          stream: false,
          config_applied: false,
        } as SyrinEvent, sessionId);
      } catch { /* fail-open */ }
    }

    if (this.config.toolValidation && toolCalls?.length) {
      this._emitter.flush().catch((err) => {
        if (this.config.debug) console.warn('[Syrin] Tool validation flush error:', err);
      });
    }

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
      // Framework context (reserved for future framework adapters)
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

// Alias for backward compat with tests and older imports
export { SyrinCore as SyrinSDKCore };
