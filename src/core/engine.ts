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

import type { SyrinSDKConfig, SyrinEvent } from '@/types.js';
import { SDK_VERSION } from '@/config/config.js';
import type { SessionStore } from '@/core/session.js';
import { sessionStorage } from '@/core/session.js';
import type { Emitter } from '@/observability/emitter.js';
import type { OTelBridge } from '@/observability/otel.js';
import type { CheckpointClient } from '@/core/checkpoint.js';
import type { ConfigStore } from '@/config/store.js';
import type { TunableRegistry } from '@/tunable/tunable.js';
import type {
  SyrinSDKAdapter,
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
import { inferFieldType } from '@/utils/code-scanner.js';

// Re-export for convenience
export type { BeforeCallResult, NormalizedCallParams, NormalizedCallResult } from '@/adapters/types.js';

export class SyrinSDKCore implements ISyrinCore {
  private readonly _adapters = new Map<string, SyrinSDKAdapter>();

  /**
   * Optional ConfigStore wired in by init() — exposes remote config to framework adapters.
   * @internal Set by init() after construction; typed via getter.
   */
  private _configStore: ConfigStore | null = null;

  /**
   * Optional TunableRegistry wired in by init() — exposes @tunable params to the core.
   * @internal Set by init() after construction; typed via getter.
   */
  private _tunableRegistry: TunableRegistry | null = null;

  /** Code-scan state — populated at init() from static analysis of the user's source files. */
  private _codeScannedDefaults: Array<{ path: string; default: unknown }> = [];

  /** Auto-detection state — populated from the first LLM call's params. */
  private _autoDetectedDefaults: Record<string, unknown> = {};
  private _autoDetectedSections: Record<string, SchemaField[]> = {};
  private _autoDetectDone = false;

  constructor(
    readonly config: SyrinSDKConfig,
    readonly sessionStore: SessionStore,
    private readonly _emitter: Emitter,
    private readonly _otelBridge: OTelBridge,
    readonly checkpointClient: CheckpointClient,
  ) {}

  // ── Typed accessors ──────────────────────────────────────────────────────

  /**
   * Typed accessor for the ConfigStore wired in by init().
   * @returns The ConfigStore instance, or null if not yet wired.
   */
  getConfigStore(): ConfigStore | null {
    return this._configStore;
  }

  /**
   * Wire a ConfigStore into the core. Called by init() after construction.
   * @param store - The ConfigStore instance to wire.
   */
  setConfigStore(store: ConfigStore): void {
    this._configStore = store;
  }

  /**
   * Typed accessor for the TunableRegistry wired in by init().
   * @returns The TunableRegistry instance, or null if not yet wired.
   */
  getTunableRegistry(): TunableRegistry | null {
    return this._tunableRegistry;
  }

  /**
   * Wire a TunableRegistry into the core. Called by init() after construction.
   * @param registry - The TunableRegistry instance to wire.
   */
  setTunableRegistry(registry: TunableRegistry): void {
    this._tunableRegistry = registry;
  }

  /**
   * Store defaults detected by scanning the user's source files at init() time.
   * Called by init() once, before the first LLM call.
   */
  setCodeScannedDefaults(defaults: Array<{ path: string; default: unknown }>): void {
    this._codeScannedDefaults = defaults;
  }

  /**
   * Typed accessor for the Emitter instance.
   * @returns The Emitter instance used for telemetry emission.
   */
  getEmitter(): Emitter {
    return this._emitter;
  }

  // ── Adapter registry ────────────────────────────────────────────────────

  /**
   * Register and install an adapter into the core.
   * Validates that the adapter satisfies the SyrinSDKAdapter interface.
   * Idempotent — re-registering the same adapter name replaces the old one.
   *
   * @param adapter - Object implementing SyrinSDKAdapter (must have install, uninstall, isInstalled, name, configSchema).
   * @throws Error if the passed object does not implement SyrinSDKAdapter.
   *
   * @example
   * await core.registerAdapter(new OpenAIAdapter());
   */
  async registerAdapter(adapter: SyrinSDKAdapter): Promise<void> {
    // Task 8: validate that the object actually implements SyrinSDKAdapter
    if (
      !adapter ||
      typeof adapter !== 'object' ||
      typeof (adapter as SyrinSDKAdapter).install !== 'function' ||
      typeof (adapter as SyrinSDKAdapter).uninstall !== 'function' ||
      typeof (adapter as SyrinSDKAdapter).isInstalled !== 'function' ||
      typeof (adapter as SyrinSDKAdapter).name !== 'string' ||
      typeof (adapter as SyrinSDKAdapter).configSchema !== 'function'
    ) {
      throw new Error(
        `[Syrin] registerAdapter() requires an object implementing SyrinSDKAdapter (with install, uninstall, isInstalled, name, configSchema). Got: ${typeof adapter}`
      );
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
    const sections: Record<string, Record<string, SchemaField>> = {};

    // 1. Merge adapter schemas (first-writer wins per field)
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

    // 2. Merge auto-detected sections from first LLM call (e.g. tools section)
    for (const [sectionName, fields] of Object.entries(this._autoDetectedSections)) {
      if (!sections[sectionName]) sections[sectionName] = {};
      for (const field of fields) {
        if (!sections[sectionName][field.name]) {
          sections[sectionName][field.name] = field;
        }
      }
    }

    // 3. Merge TunableRegistry sections (registered via tune()) — converts FieldSchema → SchemaField
    const tunableSchemas = this._tunableRegistry?.exportSchemas() ?? {};
    const tunableTypeMap: Record<string, SchemaField['type']> = {
      boolean: 'bool', number: 'float', string: 'str', array: 'str', object: 'str',
    };
    for (const [ns, fieldMap] of Object.entries(tunableSchemas)) {
      if (!sections[ns]) sections[ns] = {};
      for (const [fieldName, fs] of Object.entries(fieldMap)) {
        if (!sections[ns][fieldName]) {
          const constraints: NonNullable<SchemaField['constraints']> = {};
          if (fs.ge !== undefined) constraints.ge = fs.ge;
          if (fs.le !== undefined) constraints.le = fs.le;
          if (fs.enum !== undefined) constraints.enum = fs.enum;
          sections[ns][fieldName] = {
            name: fieldName,
            type: tunableTypeMap[fs.type] ?? 'str',
            default: fs.default ?? null,
            ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
          };
        }
      }
    }

    // 4. Apply code-scanned defaults (from static analysis of user source at init() time).
    //    Creates new sections/fields when the key is not in any adapter schema.
    //    Lower priority: user's schemaDefaults override these.
    const userDefaults = this.config.schemaDefaults ?? {};
    for (const { path: fieldPath, default: defaultVal } of this._codeScannedDefaults) {
      if (fieldPath in userDefaults) continue; // explicit user wins
      const dot = fieldPath.indexOf('.');
      if (dot === -1) continue;
      const sec = fieldPath.slice(0, dot);
      const fieldName = fieldPath.slice(dot + 1);

      // Create section if missing (e.g. 'agent', 'tools' not in any adapter schema)
      if (!sections[sec]) sections[sec] = {};

      // Create field if missing — infer type from the default value
      if (!sections[sec][fieldName]) {
        sections[sec][fieldName] = {
          name: fieldName,
          type: inferFieldType(defaultVal),
          default: null,
        };
      }

      sections[sec][fieldName] = { ...sections[sec][fieldName], default: defaultVal };
    }

    // 5. Apply first-call auto-detected LLM defaults (lowest auto-priority)
    //    Skipped when code-scan already set a value for the same key.
    const codeScannedPaths = new Set(this._codeScannedDefaults.map(d => d.path));
    for (const [path, value] of Object.entries(this._autoDetectedDefaults)) {
      if (path in userDefaults) continue; // explicit user wins
      if (codeScannedPaths.has(path)) continue; // code-scan wins
      const dot = path.indexOf('.');
      if (dot === -1) continue;
      const sec = path.slice(0, dot);
      const fieldName = path.slice(dot + 1);
      if (sections[sec]?.[fieldName]) {
        sections[sec][fieldName] = { ...sections[sec][fieldName], default: value };
      }
    }

    // 5. Apply explicit schemaDefaults (highest priority)
    for (const [path, value] of Object.entries(userDefaults)) {
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
        const configStore = this._configStore;
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
   * Auto-detect schema defaults from the first intercepted LLM call.
   * Extracts model, temperature, max_tokens, system_prompt, and tool names so
   * users don't need to declare them manually in schemaDefaults.
   * User-provided schemaDefaults always win over auto-detected values.
   */
  private _detectDefaultsFromCall(params: NormalizedCallParams): void {
    const userDefaults = this.config.schemaDefaults ?? {};
    const autoDefaults: Record<string, unknown> = {};
    const autoSections: Record<string, SchemaField[]> = {};
    const raw = params.raw;

    // LLM parameter fields
    const llmMappings: Array<[string, string]> = [
      ['model',             'llm.model'],
      ['temperature',       'llm.temperature'],
      ['max_tokens',        'llm.max_tokens'],
      ['top_p',            'llm.top_p'],
      ['frequency_penalty','llm.frequency_penalty'],
      ['presence_penalty', 'llm.presence_penalty'],
      ['seed',             'llm.seed'],
    ];
    for (const [rawKey, schemaPath] of llmMappings) {
      if (!(schemaPath in userDefaults) && raw[rawKey] != null) {
        autoDefaults[schemaPath] = raw[rawKey];
      }
    }

    // System prompt — first system message (OpenAI) or top-level system field (Anthropic)
    if (!('prompt.system_prompt' in userDefaults)) {
      const msgs = Array.isArray(raw['messages']) ? raw['messages'] as Record<string, unknown>[] : [];
      const sysMsg = msgs.find((m) => m?.['role'] === 'system');
      if (sysMsg && typeof sysMsg['content'] === 'string' && sysMsg['content'].trim()) {
        autoDefaults['prompt.system_prompt'] = sysMsg['content'];
      } else if (typeof raw['system'] === 'string' && (raw['system'] as string).trim()) {
        autoDefaults['prompt.system_prompt'] = raw['system'];
      }
    }

    // Tools → register a 'tools' section with boolean toggles (enabled/disabled per tool)
    const rawTools = raw['tools'] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(rawTools) && rawTools.length > 0) {
      const toolFields: SchemaField[] = [];
      for (const tool of rawTools) {
        const fn = tool?.['function'] as { name?: string } | undefined;
        const toolName = fn?.name ?? (tool?.['name'] as string | undefined);
        if (toolName) {
          toolFields.push({ name: toolName, type: 'bool', default: true });
        }
      }
      if (toolFields.length > 0) {
        autoSections['tools'] = toolFields;
      }
    }

    this._autoDetectedDefaults = autoDefaults;
    this._autoDetectedSections = autoSections;

    if (this.config.debug) {
      const keys = [...Object.keys(autoDefaults), ...Object.values(autoSections).flat().map((f) => `tools.${f.name}`)];
      if (keys.length > 0) {
        console.log(`[Syrin] Auto-detected schema defaults: ${keys.join(', ')}`);
      }
    }
  }

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
    // Auto-detect schema defaults from the first LLM call — fires register() in background
    // so the dashboard shows real defaults without requiring schemaDefaults in init().
    if (!this._autoDetectDone) {
      this._autoDetectDone = true;
      this._detectDefaultsFromCall(params);
      this.register().catch(() => { /* non-fatal */ });
    }

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

    try {
      this._emitter.emit(errorEvent, sessionId);
    } catch (emitErr) {
      if (this.config.debug) console.warn('[Syrin] Error event emit failed (non-fatal):', emitErr);
    }
    try {
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
    } catch (otelErr) {
      if (this.config.debug) console.warn('[Syrin] OTel error span failed (non-fatal):', otelErr);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _recordAndEmit(ctx: BeforeCallResult, result: NormalizedCallResult): void {
    try {
      this._doRecordAndEmit(ctx, result);
    } catch (err) {
      if (this.config.debug) {
        console.warn('[Syrin] Telemetry error (non-fatal — user call succeeded):', err);
      }
    }
  }

  private _doRecordAndEmit(ctx: BeforeCallResult, result: NormalizedCallResult): void {
    const {
      sessionId, agentId, configApplied, governanceApplied,
      modifiedMessages, modifiedRaw, tempUnsupported,
    } = ctx;
    const {
      model, inputTokens, outputTokens, finishReason, durationMs,
      toolCalls, toolDefinitions, responseText, stream, ttftMs,
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

    // Compute mutationHash — tracks how the conversation input changed between calls
    const session2 = this.sessionStore.getSession(sessionId);
    const prevConvHash = session2?.lastConversationHash ?? null;
    const mutationHash = _hashMutation(prevConvHash, conversationHash);
    // Update session's lastConversationHash for the next call
    if (session2) {
      session2.lastConversationHash = conversationHash;
    }

    // Compute toolCallHash — hash of tool calls returned in the response
    const toolCallHash = _hashToolCalls(toolCalls);

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
      ...(ttftMs != null ? { ttft_ms: ttftMs } : {}),
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

    // Emit TOOL_RESULT for each role='tool' message BEFORE the LLM_CALL event.
    // These represent tool outputs that were submitted as part of this request,
    // meaning they happened chronologically before the LLM produced its response.
    for (const msg of ctx.modifiedMessages ?? []) {
      if ((msg as unknown as Record<string, unknown>)['role'] === 'tool') {
        const m = msg as unknown as Record<string, unknown>;
        const toolResultEvent: SyrinEvent = {
          event_id: generateId('evt_'),
          event_type: 'TOOL_RESULT',
          timestamp: nowIso(),
          session_id: sessionId,
          agent_id: agentId ?? undefined,
          run_id: agentStorage.getStore()?.runId,
          trace_id: agentStorage.getStore()?.traceId,
          tool_call_id: (m['tool_call_id'] as string | undefined) ?? '',
          tool_name:    (m['name']         as string | undefined) ?? '',
          tool_result:  String(m['content'] ?? ''),
          model,
          provider,
          duration_ms: 0,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          stream: false,
          config_applied: false,
        };
        try { this._emitter.emit(toolResultEvent, sessionId); } catch { /* fail-open */ }
      }
    }

    this._emitter.emit(event, sessionId);

    // Emit TOOL_CALL for each tool call in the LLM response AFTER the LLM_CALL event.
    // These represent function calls the model decided to make.
    for (const tc of toolCalls ?? []) {
      const toolCallEvent: SyrinEvent = {
        event_id: generateId('evt_'),
        event_type: 'TOOL_CALL',
        timestamp: nowIso(),
        session_id: sessionId,
        agent_id: agentId ?? undefined,
        run_id: agentStorage.getStore()?.runId,
        trace_id: agentStorage.getStore()?.traceId,
        tool_name:      tc.name      ?? '',
        tool_call_id:   tc.id        ?? '',
        tool_arguments: tc.arguments ?? '',
        model,
        provider,
        duration_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        stream: false,
        config_applied: false,
      };
      try { this._emitter.emit(toolCallEvent, sessionId); } catch { /* fail-open */ }
    }

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

/**
 * Compute mutationHash — hash of (prevConversationHash + currentConversationHash).
 * Tracks how the conversation input changed between calls.
 */
function _hashMutation(prevHash: string | null | undefined, currentHash: string): string {
  return stableHash(`${prevHash ?? ''}|${currentHash}`).slice(0, 16);
}

/**
 * Compute toolCallHash — order-independent hash of tool calls returned in a response.
 * Returns null when there are no tool calls.
 */
function _hashToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined
): string | null {
  if (!toolCalls?.length) return null;
  const entries = toolCalls
    .map((tc) => ({ name: tc.name ?? '', args: tc.arguments ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return stableHash(JSON.stringify(entries)).slice(0, 16);
}

/** Read current run context fields — safe to call anywhere. */
function _runCtxFields(): Pick<SyrinEvent, 'run_id' | 'workflow_id' | 'swarm_id' | 'parent_run_id' | 'trace_id' | 'call_depth'> {
  const ctx = agentStorage.getStore();
  if (!ctx) return {};
  return {
    run_id: ctx.runId,
    workflow_id: ctx.workflowId,
    swarm_id: ctx.swarmId,
    parent_run_id: ctx.parentRunId,
    trace_id: ctx.traceId,
    call_depth: ctx.callDepth,
  };
}
