/**
 * Syrin SDK — Public API
 *
 * Usage:
 *   import { init } from "@syrin/sdk";
 *   const sdk = await init({ apiKey: "syrin_..." });
 *   // All existing openai calls are now instrumented
 */

import { createConfig } from '@/config/config.js';
import { SessionStore, sessionStorage, resolveSessionId } from '@/core/session.js';
import { Emitter } from '@/observability/emitter.js';
import { OTelBridge } from '@/observability/otel.js';
import { CheckpointClient } from '@/core/checkpoint.js';
import { SyrinSDKCore } from '@/core/engine.js';
import { Heartbeat } from '@/core/heartbeat.js';
import { ConfigSync } from '@/core/config-sync.js';
import { load as loadPersistedConfig, save as savePersistedConfig } from '@/config/persist.js';
import { OpenAIAdapter } from '@/adapters/openai/index.js';
import { clearHooks } from '@/observability/hooks.js';
import { installForActiveLibraries, installModuleHook, uninstallModuleHook } from '@/utils/auto-detect.js';
import { generateId, nowIso } from '@/utils/helpers.js';
import type { SyrinSDKConfig, SyrinSDK, SyrinEvent, ConfigUpdate, MessageParam } from '@/types.js';
import type { SyrinSDKAdapter } from '@/adapters/types.js';
import { _setAutoRefreshCallback, clearAutoRefreshTimer } from '@/tunable/tunable.js';
import { _setLifecycleEmitter, agentStorage } from '@/agent/context.js';
import { getCallInterceptor } from '@/control/call-interceptor.js';
import type { CompleteControlConfig } from '@/control/complete-control-schema.js';


export type { SyrinSDKConfig, SyrinEvent, CustomLogEvent, IngestPayload, IngestResponse, SessionState, SyrinSDK, CallInfo, RunContext, GovernanceAction, GovernanceData, ConfigUpdate, MessageParam, AgentConfig, AgentFieldDef } from '@/types.js';
export { withAgent, withWorkflow, withSwarm, getRunContext } from '@/agent/context.js';
export { TraceSpan } from '@/agent/trace-span.js';
export type { TraceType } from '@/agent/trace-span.js';
export { withTool, ToolSpan, withMemory, MemorySpan } from '@/agent/tool-context.js';
export { GovernanceStopError } from '@/core/governance.js';
export type { GovernancePolicy } from '@/core/governance.js';
export type { Checkpoint } from '@/core/checkpoint.js';
export { ConfigSync } from '@/core/config-sync.js';
export type { ConfigSyncOptions } from '@/core/config-sync.js';
export { onConfigChange, onAlert } from '@/observability/hooks.js';
export { SyrinSDKCore } from '@/core/engine.js';
export { SyrinLogger, getLogger, setLogger } from '@/observability/logger.js';
export type { LogLevel, LogContext, LogEntry } from '@/observability/logger.js';
export { IdentityManager, getIdentityManager, setIdentityManager } from '@/core/identity.js';
export type { IdentityContext, CallContext } from '@/core/identity.js';
export { CallInterceptor, getCallInterceptor, setCallInterceptor } from '@/control/call-interceptor.js';
export type { InterceptedCall, GovernanceViolation } from '@/control/call-interceptor.js';
export { ToolGovernance, getToolGovernance, setToolGovernance } from '@/control/tool-governance.js';
export type { ToolCall, ApprovalRequest } from '@/control/tool-governance.js';
export type { CompleteControlConfig, ToolConfig, ParameterMatrix } from '@/control/complete-control-schema.js';
export { validateConfigValue, getConfigType, PARAMETER_CONSTRAINTS } from '@/control/complete-control-schema.js';
export type { SyrinSDKAdapter, NormalizedCallParams, NormalizedCallResult, BeforeCallResult, ISyrinCore, SchemaField as AdapterSchemaField } from '@/adapters/types.js';
export { OpenAIAdapter } from '@/adapters/openai/index.js';
export { ConfigStore } from '@/config/store.js';
export type { FieldSchema, ConfigVersion, AuditEntry } from '@/config/store.js';
export { tunable, TunableField, tune, getTune, globalRegistry, TunableRegistry, clearAutoRefreshTimer } from '@/tunable/tunable.js';
export type { TuneOptions, TuneFieldDef } from '@/tunable/tunable.js';
export { AnthropicAdapter } from '@/adapters/anthropic/index.js';
export { LangChainAdapter } from '@/adapters/langchain/index.js';
export { LangGraphAdapter } from '@/adapters/langgraph/index.js';
export { MastraAdapter } from '@/adapters/mastra/index.js';
export { VercelAIAdapter } from '@/adapters/vercel-ai/index.js';
export { SyrinSDKBaseFrameworkAdapter } from '@/adapters/types.js';
export type { SyrinSDKFrameworkAdapter } from '@/adapters/types.js';

/**
 * Options for `cfg()` / `sdk.cfg()` — metadata about the remotely-configurable field.
 */
export interface CfgOptions {
  label?: string;
  description?: string;
  ge?: number;
  le?: number;
  enum?: unknown[];
  multiline?: boolean;
}

/**
 * Time window controlling how sessions are grouped.
 *
 * | Window     | Session expires / resets |
 * |------------|--------------------------|
 * | `"hour"`   | Every hour               |
 * | `"day"`    | Every calendar day       |
 * | `"week"`   | Every ISO week (Mon–Sun) |
 * | `"month"`  | Every calendar month     |
 * | `"forever"`| Never — persistent       |
 */
export type SessionWindow = 'hour' | 'day' | 'week' | 'month' | 'forever';

/**
 * Options for creating a grouped / user session via {@link withSession} or
 * {@link makeSessionId}.
 */
export interface SessionOptions {
  /**
   * Stable end-user identifier (e.g. database ID, email).
   * Groups all requests from this user within the given {@link window}.
   */
  userId?: string;
  /**
   * Custom group key — flow name, tenant ID, batch job name, etc.
   * Can be combined with {@link userId}.
   */
  key?: string;
  /**
   * Time window that controls session grouping and expiry.
   * Defaults to `"day"`.
   */
  window?: SessionWindow;
  /**
   * Extra key-value pairs attached to the `SESSION_STARTED` event payload
   * (e.g. `{ plan: "pro", region: "us-east" }`).
   */
  metadata?: Record<string, unknown>;
}

/**
 * A registered agent handle returned by {@link SyrinSDKInstance.agent}.
 *
 * Combines registration and session management: call `.run(fn)` to enter the
 * agent context and run `fn` inside it — no separate `withAgent()` import needed.
 */
export class AgentHandle {
  constructor(private readonly _agentId: string) {}

  /**
   * Enter the agent context and run `fn` inside it.
   *
   * Equivalent to `withAgent(agentId, fn)` but scoped to this specific agent
   * without needing to import `withAgent` separately.
   *
   * @example
   * ```ts
   * await researcher.run(async () => {
   *   const temp = sdk.cfg("llm.temperature", 0.3) as number;
   *   const reply = await callLLM(messages, temp);
   * });
   * ```
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const { withAgent } = await import('./agent/context.js');
    return withAgent(this._agentId, fn);
  }
}

export class SyrinSDKInstance implements SyrinSDK {
  private _sessionId: string;
  private _config: SyrinSDKConfig;
  private _sessionStore: SessionStore;
  private _emitter: Emitter;
  private _otelBridge: OTelBridge;
  private _core: SyrinSDKCore;
  private _heartbeat: Heartbeat;
  private _configDir: string | undefined;
  /** Config poll timer — set by init() when configPollIntervalMs > 0. */
  _pollTimer: ReturnType<typeof setInterval> | undefined = undefined;
  /** Config sync manager — handles fetching and applying remote config via CallInterceptor. */
  _configSync: ConfigSync | undefined = undefined;
  /** Defaults detected by the code scanner at init(). Set by init() after construction. */
  _scanReport: import('./utils/code-scanner.js').ScannedDefault[] = [];

  constructor(
    config: SyrinSDKConfig,
    sessionStore: SessionStore,
    emitter: Emitter,
    otelBridge: OTelBridge,
    core: SyrinSDKCore,
    heartbeat: Heartbeat,
    configDir?: string,
  ) {
    this._config = config;
    this._sessionStore = sessionStore;
    this._emitter = emitter;
    this._otelBridge = otelBridge;
    this._core = core;
    this._heartbeat = heartbeat;
    this._configDir = configDir;
    this._sessionId = resolveSessionId(config.sessionId);
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get config(): SyrinSDKConfig {
    return this._config;
  }

  /**
   * Register a custom adapter (e.g. LangChain, Anthropic) after init().
   * Returns `this` so calls can be chained (after awaiting).
   *
   * @example
   * import { MyCustomAdapter } from './my-adapter';
   * await sdk.registerAdapter(new MyCustomAdapter());
   * // or chained:
   * await (await sdk.registerAdapter(adapterA)).registerAdapter(adapterB);
   */
  async registerAdapter(adapter: SyrinSDKAdapter): Promise<this> {
    await this._core.registerAdapter(adapter);
    return this;
  }

  /**
   * Register an agent with per-agent observability settings.
   *
   * Can be called at any point after `init()` — before or after the agent runs.
   * Per-agent settings take priority over the SDK-level defaults for that agent only.
   * Returns `this` so calls can be chained.
   *
   * @param config - AgentConfig with `agentId` and optional overrides.
   *
   * @example
   * ```ts
   * const sdk = await init({ apiKey: "syrin_..." });
   *
   * // Research agent — capture full prompts, all tool events
   * sdk.registerAgent({ agentId: "researcher", captureContent: true });
   *
   * // Classifier — no PII, suppress tool noise
   * sdk.registerAgent({ agentId: "classifier", captureContent: false, captureToolCalls: false });
   *
   * // Chaining
   * sdk.registerAgent({ agentId: "writer" }).registerAgent({ agentId: "reviewer" });
   * ```
   */
  registerAgent(config: import('./types.js').AgentConfig): this {
    this._core.registerAgent(config);
    return this;
  }

  /**
   * Register an agent and return an {@link AgentHandle} for session management.
   *
   * Combines `registerAgent()` and `withAgent()` in one step. The returned handle's
   * `.run(fn)` method enters the agent scope and runs your async function inside it —
   * no separate registration call or `withAgent()` import needed.
   *
   * @param agentId - Unique agent identifier.
   * @param options - Optional observability overrides and field declarations.
   * @returns An {@link AgentHandle} with a `.run(fn)` method.
   *
   * @example
   * ```ts
   * const researcher = sdk.agent("researcher", {
   *   description: "Gathers information",
   *   captureContent: true,
   *   captureToolCalls: true,
   *   fields: {
   *     "llm.temperature":      { default: 0.3, ge: 0, le: 2, label: "Temperature" },
   *     "prompt.system_prompt": { default: "Research the topic.", multiline: true },
   *   },
   * });
   *
   * // Use it as a session handle anywhere:
   * await researcher.run(async () => {
   *   const temp = sdk.cfg("llm.temperature", 0.3) as number;
   *   const reply = await callLLM(messages, temp);
   * });
   * ```
   */
  agent(
    agentId: string,
    options?: Omit<import('./types.js').AgentConfig, 'agentId'>
  ): AgentHandle {
    this._core.registerAgent({ agentId, ...options });
    return new AgentHandle(agentId);
  }

  /**
   * Apply a remote config override map pushed from the Syrin backend or dashboard.
   *
   * Updates all active sessions and the agent-level ConfigStore, then persists
   * changes to disk so they survive restarts.
   *
   * @param overrides - Flat `{ key: value }` object, e.g.
   *   `{ "llm.temperature": 0.2, "prompt.systemPrompt": "..." }`.
   * @returns `{ applied: string[], rejected: string[] }` key lists.
   *
   * @example
   * ```ts
   * app.post('/syrin/config', async (req, res) => {
   *   const { applied, rejected } = await sdk.applyRemoteConfig(req.body);
   *   res.json({ ok: true, applied, rejected });
   * });
   * ```
   */
  async applyRemoteConfig(
    overrides: Record<string, unknown>
  ): Promise<{ applied: string[]; rejected: string[] }> {
    const { save: saveConfig } = await import('./config/persist.js');
    const rejected: string[] = [];

    // Update all active sessions
    const ids = typeof (this._sessionStore as SessionStore & { getSessionIds?(): string[] }).getSessionIds === 'function'
      ? (this._sessionStore as SessionStore & { getSessionIds(): string[] }).getSessionIds()
      : [];
    for (const sid of ids) {
      try { this._sessionStore.applyConfigUpdate(sid, overrides); } catch { /* ignore */ }
    }
    try { this._sessionStore.applyConfigUpdate(this._sessionId, overrides); } catch { /* ignore */ }

    // Update agent-level ConfigStore
    try {
      const configStore = (this._core as Record<string, unknown>)['_configStore'] as
        | { applyUpdates?: (o: Record<string, unknown>, source?: string) => void }
        | undefined;
      if (configStore?.applyUpdates) {
        configStore.applyUpdates(overrides, 'remote');
      }
    } catch { /* ignore */ }

    // Persist to disk
    try { await saveConfig(overrides, this._configDir); } catch { /* ignore */ }

    const applied = Object.keys(overrides).filter(k => !rejected.includes(k));
    return { applied, rejected };
  }

  /**
   * Return the tool validation result for a tool call ID.
   * Requires toolValidation: true in init() options.
   */
  getToolValidation(
    toolCallId: string,
    sessionId?: string
  ): { valid: boolean; error?: string } | undefined {
    const sid = sessionId ?? this._sessionId;
    return this._sessionStore.getToolValidation(sid, toolCallId);
  }

  /**
   * Set local config overrides — takes priority over remote config.
   * Returns `this` so calls can be chained.
   *
   * @param overrides - Config fields to override. Only provided keys are changed.
   * @param sessionId - Target session. Defaults to the instance's default session.
   *
   * @example
   * sdk.configure({ temperature: 0.3 }).configure({ model: 'gpt-4o-mini' });
   */
  configure(overrides: ConfigUpdate, sessionId?: string): this {
    const sid = sessionId ?? this._sessionId;
    this._sessionStore.setLocalConfig(sid, overrides as Record<string, unknown>);
    return this;
  }

  /**
   * Declare a remotely configurable value and return its current value.
   *
   * @param key - Dot-notation key: "section.field" (e.g. "llm.temperature")
   * @param defaultValue - Default value (used to infer type)
   * @param options - Optional metadata: label, description, ge, le, enum, multiline
   * @returns The current value: governance override > user configure() > remote > default
   *
   * @example
   * const model = sdk.cfg('llm.model', 'gpt-4o', { label: 'LLM Model' });
   * const temp  = sdk.cfg('llm.temperature', 0.7, { ge: 0.0, le: 2.0 });
   */
  cfg(key: string, defaultValue: string, options?: CfgOptions): string;
  cfg(key: string, defaultValue: number, options?: CfgOptions): number;
  cfg(key: string, defaultValue: boolean, options?: CfgOptions): boolean;
  cfg(key: string, defaultValue?: unknown, options?: CfgOptions): unknown;
  cfg(
    key: string,
    defaultValue: unknown = null,
    options: CfgOptions = {},
  ): unknown {
    const parts = key.split('.');
    if (parts.length < 2) return defaultValue;

    const [section, ...rest] = parts;
    const fieldName = rest.join('.');

    // Determine namespace — check agent context (withAgent scope)
    let namespace = `global.${section}`;
    try {
      const ctx = agentStorage.getStore();
      if (ctx?.agentId) {
        namespace = `agents.${ctx.agentId}.${section}`;
      }
    } catch { /* no agent context — use global */ }

    // Access ConfigStore via core
    const configStore = (this._core as unknown as Record<string, unknown>)['_configStore'] as import('./config/store.js').ConfigStore | undefined;
    if (configStore) {
      const sectionsRef = (configStore as unknown as { _sections: Record<string, Record<string, import('./config/store.js').FieldSchema>>; _values: Record<string, Record<string, unknown>> });
      if (!sectionsRef._sections[namespace]) {
        sectionsRef._sections[namespace] = {};
        sectionsRef._values[namespace] = {};
      }
      if (!sectionsRef._sections[namespace][fieldName]) {
        // Infer type from default value
        const inferredType: import('./config/store.js').FieldSchema['type'] =
          typeof defaultValue === 'number' ? 'number'
          : typeof defaultValue === 'boolean' ? 'boolean'
          : Array.isArray(defaultValue) ? 'array'
          : typeof defaultValue === 'object' && defaultValue !== null ? 'object'
          : 'string';

        const fieldSchema: import('./config/store.js').FieldSchema = {
          name: fieldName,
          type: inferredType,
          default: defaultValue,
          ...(options.description ? { description: options.description } : {}),
          ...(options.ge !== undefined ? { ge: options.ge } : {}),
          ...(options.le !== undefined ? { le: options.le } : {}),
          ...(options.enum !== undefined ? { enum: options.enum } : {}),
          ...(options.label ? { label: options.label } : {}),
          ...(options.multiline ? { multiline: options.multiline } : {}),
        };

        sectionsRef._sections[namespace][fieldName] = fieldSchema;
        sectionsRef._values[namespace][fieldName] = defaultValue;
      } else {
        // Field already registered (e.g. by built-in fields or earlier cfg() call).
        // Update the default so the user's value is reflected in the dashboard,
        // and apply any explicitly provided schema options (label, constraints…).
        const fs = sectionsRef._sections[namespace][fieldName];
        fs.default = defaultValue;
        if (sectionsRef._values[namespace][fieldName] == null) {
          sectionsRef._values[namespace][fieldName] = defaultValue;
        }
        if (options.label) fs.label = options.label;
        if (options.description) fs.description = options.description;
        if (options.ge !== undefined) fs.ge = options.ge;
        if (options.le !== undefined) fs.le = options.le;
        if (options.enum !== undefined) fs.enum = options.enum;
        if (options.multiline) fs.multiline = options.multiline;
      }

      // Priority resolution: governance/anchor > user configure() > remote (activeConfig) > default
      const storeSource = configStore.getSource?.(namespace, fieldName) ?? 'default';
      if (storeSource === 'governance' || storeSource === 'anchor') {
        const val = sectionsRef._values?.[namespace]?.[fieldName];
        if (val != null) return val;
      }
    }

    // User configure() → session localConfig
    const session = this._sessionStore.getSession(this._sessionId);
    if (session?.localConfig) {
      const local = session.localConfig;
      if (fieldName in local && local[fieldName] != null) return local[fieldName];
    }

    // Remote activeConfig
    if (session?.activeConfig) {
      const active = session.activeConfig;
      if (fieldName in active && active[fieldName] != null) return active[fieldName];
    }

    // ConfigStore remote value
    if (configStore) {
      const storeVal = (configStore as unknown as { _values: Record<string, Record<string, unknown>> })._values?.[namespace]?.[fieldName];
      if (storeVal != null) return storeVal;
    }

    return defaultValue;
  }

  /**
   * Return the currently active config for a session (remote overrides + local overrides merged).
   *
   * Keys use `"namespace.field"` notation (e.g. `"llm.temperature"`, `"llm.model"`).
   * Only fields with non-null values are included — missing keys mean "use the library default".
   *
   * @example
   * const temp = sdk.activeConfig()['llm.temperature'] as number | undefined ?? 0.7;
   */
  activeConfig(sessionId?: string): Record<string, unknown> {
    const sid = sessionId ?? this._sessionId;
    return this._sessionStore.getEffectiveConfig(sid);
  }

  /**
   * Create a checkpoint of the current conversation state.
   * Persisted to the Syrin backend; falls back to local cache if offline.
   *
   * @param messages - Conversation messages to snapshot.
   * @param options - Optional session ID, label, and metadata.
   * @returns The created Checkpoint record.
   *
   * @example
   * const cp = await sdk.createCheckpoint(messages, { label: 'before-tool-call' });
   */
  async createCheckpoint(
    messages: MessageParam[] | Array<Record<string, unknown>>,
    options: { sessionId?: string; label?: string; metadata?: Record<string, unknown> } = {}
  ): Promise<import('./core/checkpoint.js').Checkpoint> {
    const sid = options.sessionId ?? this._sessionId;
    const session = this._sessionStore.getSession(sid);
    const cp = await this._core.checkpointClient.save(sid, messages as Array<Record<string, unknown>>, {
      label: options.label,
      metadata: options.metadata,
      activeConfig: session?.activeConfig ?? {},
      callCount: session?.callCount ?? 0,
      cumulativeCostUsd: session?.cumulativeCostUsd ?? 0,
    });
    if (session) {
      session.lastCheckpointId = cp.checkpointId;
    }
    return cp;
  }

  /**
   * Restore messages from a saved checkpoint.
   * Fetches from backend if not in local cache.
   *
   * @returns The saved message array, or `undefined` if the checkpoint ID is not found.
   *          Always check for `undefined` before using the result.
   *
   * @example
   * const messages = await sdk.restoreCheckpoint(cp.checkpointId);
   * if (!messages) throw new Error(`Checkpoint ${cp.checkpointId} not found`);
   */
  async restoreCheckpoint(checkpointId: string): Promise<Array<Record<string, unknown>> | undefined> {
    const cp = await this._core.checkpointClient.getById(checkpointId);
    if (!cp) return undefined;
    return [...cp.messages];
  }

  /**
   * List all checkpoints for a session (from local cache).
   */
  listCheckpoints(sessionId?: string): import('./core/checkpoint.js').Checkpoint[] {
    return this._core.checkpointClient.listForSession(sessionId ?? this._sessionId);
  }

  deleteSession(sessionId: string): void {
    this._sessionStore.deleteSession(sessionId);
  }

  clearStaleSessions(olderThanMs = 3_600_000): number {
    return this._sessionStore.clearStaleSessions(olderThanMs);
  }

  /**
   * Return a sanitized config snapshot with the API key masked.
   */
  configSnapshot(): Record<string, unknown> {
    const { apiKey: _masked, ...rest } = this._config;
    return { ...rest, apiKey: '****' };
  }

  /**
   * Return a structured reference of all remotely-configurable fields.
   *
   * For each field: current value, default, source (who set it), type, constraints.
   *
   * Sources: `'default'` | `'remote'` | `'user'` | `'governance'` | `'anchor'`
   */
  configReference(): Record<string, Record<string, {
    current: unknown;
    default: unknown;
    source: string;
    type: string;
    constraints?: Record<string, unknown>;
  }>> {
    const session = this._sessionStore.getSession(this._sessionId);
    const schemaRaw = this._core.buildSchema();
    const sections = (schemaRaw as { global?: Record<string, { fields: Array<Record<string, unknown>> }> }).global;
    const result: Record<string, Record<string, {
      current: unknown;
      default: unknown;
      source: string;
      type: string;
      constraints?: Record<string, unknown>;
    }>> = {};

    const configStore = (this._core as unknown as Record<string, unknown>)['_configStore'] as import('./config/store.js').ConfigStore | undefined;

    for (const [sectionName, sectionData] of Object.entries(sections ?? {})) {
      const fieldsOut: Record<string, { current: unknown; default: unknown; source: string; type: string; constraints?: Record<string, unknown> }> = {};
      for (const fieldDef of sectionData.fields ?? []) {
        const fieldName = fieldDef.name as string;
        let current: unknown = null;
        let source = 'default';

        // Check ConfigStore for governance/anchor — highest priority
        // In v2 format, ConfigStore namespace is "global.<sectionName>"
        const storeSource = configStore?.getSource(`global.${sectionName}`, fieldName) ?? 'default';

        if (storeSource === 'governance' || storeSource === 'anchor') {
          const storeVal = (configStore as unknown as { _values?: Record<string, Record<string, unknown>> })?._values?.[`global.${sectionName}`]?.[fieldName];
          if (storeVal != null) { current = storeVal; source = storeSource; }
        } else {
          // User configure() → session localConfig wins over remote
          if (session && session.localConfig != null) {
            const local = session.localConfig;
            if (fieldName in local && local[fieldName] != null) {
              current = local[fieldName]; source = 'user';
            }
          }
          // Remote backend update → session activeConfig
          if (source === 'default' && session) {
            const active = session.activeConfig as Record<string, unknown> | undefined;
            if (active && fieldName in active && active[fieldName] != null) {
              current = active[fieldName]; source = 'remote';
            }
          }
          // ConfigStore remote value for framework-level fields (e.g. langgraph)
          if (source === 'default' && storeSource === 'remote') {
            const storeVal = (configStore as unknown as { _values?: Record<string, Record<string, unknown>> })?._values?.[`global.${sectionName}`]?.[fieldName];
            if (storeVal != null) { current = storeVal; source = 'remote'; }
          }
        }

        const entry: { current: unknown; default: unknown; source: string; type: string; constraints?: Record<string, unknown> } = {
          current,
          default: (fieldDef.default ?? null) as unknown,
          source,
          type: (fieldDef.type ?? 'str') as string,
        };
        if (fieldDef.constraints) entry.constraints = fieldDef.constraints as Record<string, unknown>;
        fieldsOut[fieldName] = entry;
      }
      result[sectionName] = fieldsOut;
    }
    return result;
  }

  /**
   * Print a human-readable table of all remotely-configurable fields.
   * Shows current value, default, source badge, type, and constraints.
   */
  printConfigReference(): void {
    const SOURCE_BADGE: Record<string, string> = {
      default:    'default',
      remote:     'remote ',
      user:       'user   ',
      governance: 'govern.',
      anchor:     'anchor ',
    };
    const ref = this.configReference();
    console.log('Syrin Remote Config Reference');
    console.log('='.repeat(50));
    for (const [section, fields] of Object.entries(ref)) {
      console.log(`\n  ${section}`);
      console.log(`  ${'─'.repeat(Math.max(4, section.length))}`);
      for (const [fname, info] of Object.entries(fields)) {
        const badge    = SOURCE_BADGE[info.source] ?? info.source;
        const curStr   = info.current != null ? String(info.current) : '—';
        const defStr   = info.default != null ? String(info.default) : '—';
        const cInfo    = info.constraints;
        let   cStr     = '';
        if (cInfo) {
          if ('ge' in cInfo || 'le' in cInfo) cStr = `   range ${cInfo.ge ?? ''}–${cInfo.le ?? ''}`;
          else if ('enum' in cInfo) cStr = `   one of ${JSON.stringify(cInfo.enum)}`;
          else if ('ge' in cInfo) cStr = `   min ${cInfo.ge}`;
        }
        console.log(
          `    ${fname.padEnd(24)} ${String(info.type).padEnd(6)}  ` +
          `current=${curStr.padEnd(16)} default=${defStr.padEnd(16)} ` +
          `[${badge}]${cStr}`
        );
      }
    }
    console.log('');
  }

  /**
   * Return the config-key defaults detected by the code scanner at init().
   *
   * Each entry has a `path` (e.g. `'llm.model'`) and `default` value.
   * Returns an empty array when no patterns were detected.
   *
   * @example
   * const report = sdk.scanReport();
   * // [{ path: 'llm.model', default: 'gpt-4o-mini' }, ...]
   */
  scanReport(): import('./utils/code-scanner.js').ScannedDefault[] {
    return [...this._scanReport];
  }

  async flush(): Promise<void> {
    await this._emitter.flush();
  }

  /**
   * Emit a custom log entry that appears on the Syrin dashboard timeline.
   *
   * Use this to surface any application-level event alongside LLM calls —
   * e.g. retrieval steps, business logic decisions, cost warnings, or debug
   * checkpoints — giving you a complete picture of what the agent was doing.
   *
   * @param message - The log message to display on the dashboard.
   * @param options.level - Severity: `'debug'` | `'info'` (default) | `'warning'` | `'error'`
   * @param options.metadata - Optional key/value pairs for additional context.
   * @param options.sessionId - Target session. Defaults to the instance's session.
   *
   * @example
   * sdk.log('Retrieved 42 documents from vector store', {
   *   metadata: { collection: 'kb', query: q }
   * });
   * sdk.log('Cost budget at 80%', { level: 'warning', metadata: { spent: 0.80 } });
   */
  log(
    message: string,
    options: {
      level?: 'debug' | 'info' | 'warning' | 'error';
      metadata?: Record<string, unknown>;
      sessionId?: string;
    } = {},
  ): void {
    const { level = 'info', metadata = {}, sessionId } = options;
    const sid = sessionId ?? this._sessionId;
    const event = {
      event_id:     `evt_${Math.random().toString(36).slice(2)}`,
      event_type:   'CUSTOM_LOG' as const,
      timestamp:    new Date().toISOString(),
      session_id:   sid,
      agent_id:     this._config.agentId ?? '',
      message,
      level,
      metadata,
      // Required SyrinEventBase fields (not applicable for custom logs)
      duration_ms:    0,
      model:          '',
      provider:       '',
      input_tokens:   0,
      output_tokens:  0,
      cost_usd:       0,
      stream:         false,
      config_applied: false,
    };
    try {
      this._emitter.emit(event as import('./types.js').SyrinEvent, sid);
    } catch { /* non-fatal */ }
  }

  /**
   * Get the agent's configuration schema.
   * Returns what can be configured (sections and fields), suitable for dashboard display.
   * @returns The full schema with all sections and their fields.
   */
  getSchema(): Record<string, unknown> {
    return this._core.buildSchema();
  }

  /**
   * Re-send the agent schema to the backend.
   * Call after tune() to push custom sections to the dashboard.
   * Parity with Python SDK's sdk.refresh_schema().
   */
  async refreshSchema(): Promise<void> {
    await this._core.register();
  }

  async shutdown(): Promise<void> {
    _setLifecycleEmitter(null);
    clearAutoRefreshTimer();
    uninstallModuleHook();
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._configSync) this._configSync.stopPolling();
    await this._heartbeat.stop();
    await this._emitter.stop();
    this._core.uninstallAll();
    await this._otelBridge.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Named-instance registry
// ---------------------------------------------------------------------------

/** Internal registry of named instances */
const _instances = new Map<string, SyrinSDKInstance>();
/** Primary (default) instance — used by module-level helpers */
let _primaryInstance: SyrinSDKInstance | null = null;


/**
 * Options accepted by `init()`.
 * All fields are optional — the SDK reads defaults from environment variables.
 *
 * @example
 * const sdk = await init({
 *   apiKey: 'syrin_...',
 *   agentId: 'my-agent',
 *   debug: true,
 * });
 */
export interface SyrinInitOptions {
  // --- Core ---

  /**
   * Syrin API key. Falls back to the `SYRIN_API_KEY` environment variable.
   * Required — init() throws if neither is set.
   */
  apiKey?: string;
  /**
   * The name of your AI application or agent as it appears in the Syrin dashboard.
   * E.g. `'customer-support-bot'`, `'research-pipeline'`.
   *
   * For multi-agent apps this is the **service** name — individual agent runs are
   * scoped with `withAgent('researcher', ...)`. Max 128 chars. Alphanumeric + `-_.@:`.
   * Falls back to `SYRIN_AGENT_ID` env var.
   */
  agentId?: string;
  /** @deprecated Use `agentId` instead. */
  name?: string;
  /**
   * Syrin backend URL. Defaults to `https://api.syrin.ai`.
   * Must use HTTPS except for `http://localhost` and `http://127.0.0.1`.
   * Falls back to `SYRIN_URL` env var.
   */
  url?: string;

  // --- Observability ---

  /**
   * OTel span exporter. One of `'none'` (default), `'console'`, `'otlp'`.
   * Falls back to `SYRIN_OTEL_EXPORTER` env var.
   */
  otelExporter?: 'none' | 'console' | 'otlp';
  /**
   * OTLP endpoint URL (only used when otelExporter is `'otlp'`).
   * Defaults to `http://localhost:4318`. Falls back to `SYRIN_OTEL_ENDPOINT`.
   */
  otelEndpoint?: string;
  /**
   * Print all SDK activity to stderr. Useful during development.
   * Falls back to `SYRIN_DEBUG=true` env var. Default: `false`.
   */
  debug?: boolean;
  /**
   * Include prompt messages and completion text in telemetry events.
   * **Disabled by default (PII-safe).** Set to `true` to transmit prompts,
   * completions, and system messages to the Syrin backend.
   * Review your data-handling policy (GDPR, HIPAA, etc.) before enabling.
   * Falls back to `SYRIN_CAPTURE_CONTENT` env var.
   */
  captureContent?: boolean;

  // --- Performance ---

  /**
   * Run the SDK without sending any network requests.
   * Events are queued locally and discarded on shutdown. Default: `false`.
   */
  offline?: boolean;
  /**
   * Flush the event queue after this many ms of inactivity.
   * Default: 10 000 (10 seconds). Falls back to `SYRIN_IDLE_FLUSH_MS`.
   */
  idleFlushMs?: number;
  /**
   * Flush the event queue immediately when it reaches this size.
   * Default: 100. Falls back to `SYRIN_BATCH_SIZE`.
   */
  batchSize?: number;
  /**
   * Enable tool call validation. When true, tool call args and schemas are
   * sent to the backend for validation. Default: `false`.
   */
  toolValidation?: boolean;

  // --- Session ---

  /**
   * Override the session ID for this instance.
   * Max 128 chars. Alphanumeric, hyphens, underscores, dots, colons, @.
   * Auto-generated if not provided.
   */
  sessionId?: string;
  /**
   * Auto-delete sessions older than this many ms (undefined = disabled).
   */
  sessionTtlMs?: number;

  // --- Governance ---

  /**
   * Governance policy controlling which backend actions the SDK will execute.
   * Destructive actions (`stop`, `injectMessage`) default to disabled.
   *
   * @example
   * governance: { allowStop: true, allowInjectMessage: false }
   */
  governance?: import('./core/governance.js').GovernancePolicy;
  /**
   * When set, only config keys in this list may be updated by the backend.
   * All other `config_updates` keys are silently discarded.
   *
   * @example
   * configUpdateAllowlist: ['llm.temperature', 'llm.max_tokens']
   */
  configUpdateAllowlist?: string[];
  /**
   * When `true`, all `config_updates` received from the backend are silently ignored.
   * Default: `false`.
   */
  disableRemoteConfig?: boolean;

  // --- Advanced ---

  /**
   * Public URL of this agent server — stored by the dashboard to enable
   * the "Run" button for remote agent invocations.
   */
  serverUrl?: string;
  /**
   * Explicit framework/orchestration library name reported to the dashboard
   * (e.g. `'langchain'`, `'langgraph'`, `'mastra'`, `'vercel-ai'`, `'pydantic-ai'`).
   * When set, this takes priority over auto-detection. Useful when the SDK
   * cannot auto-detect the framework (e.g. pure-ESM imports with tsx).
   */
  agentFramework?: string;
  /**
   * Additional adapters to install after the built-in ones.
   * Each adapter is registered in order; explicit adapters take precedence
   * over auto-detected ones of the same name.
   *
   * @example
   * import { LangChainAdapter } from '@syrin/sdk';
   * await init({ adapters: [new LangChainAdapter()] });
   */
  adapters?: import('./adapters/types.js').SyrinSDKAdapter[];
  /**
   * Name for this SDK instance in the registry.
   * Defaults to `'default'`. Multiple named instances can coexist in one process.
   *
   * @example
   * const researcher = await init({ instanceName: 'researcher', apiKey: '...' });
   * const writer = await init({ instanceName: 'writer', apiKey: '...' });
   */
  instanceName?: string;
  /**
   * How often (in ms) to poll the backend for remote config overrides.
   * 0 or undefined (default) disables polling.
   * Falls back to `SYRIN_CONFIG_POLL_INTERVAL_MS` env var.
   */
  configPollIntervalMs?: number;
  /**
   * Default values for schema fields shown in the dashboard.
   * Keys use dot-notation (e.g. `'llm.model'`, `'llm.temperature'`).
   * Parity with Python SDK's `schema_defaults` option.
   *
   * @example
   * schemaDefaults: { 'llm.model': 'gpt-4o-mini', 'llm.temperature': 0.7 }
   */
  schemaDefaults?: Record<string, unknown>;
  /**
   * Directory containing the `.syrin/syrin.config.json` file for persisted config.
   * Defaults to `process.cwd()`. Set per-process for isolated config directories
   * (e.g., multi-agent deployments where each agent has its own config).
   *
   * @example
   * configDir: '/data/agents/customer-support'
   */
  configDir?: string;
  /**
   * File or directory paths to scan for `cfg()` / `config()` / `activeConfig()`
   * usage patterns. When provided, the SDK scans these paths (instead of only
   * the immediate caller file) to pre-populate the dashboard with real runtime
   * defaults. Directories are searched recursively for `.ts`/`.js` files.
   *
   * @example
   * scanPaths: ['./src', './agents']
   */
  scanPaths?: string[];
}

// ---------------------------------------------------------------------------
// Built-in global fields — pre-registered by init() so the dashboard is
// immediately useful without any cfg() calls from the user.
// ---------------------------------------------------------------------------

type _BuiltinField = {
  type: 'number' | 'string' | 'boolean';
  label: string;
  description: string;
  ge?: number;
  le?: number;
  multiline?: boolean;
};

const _BUILTIN_GLOBAL_FIELDS: Record<string, Record<string, _BuiltinField>> = {
  'global.llm': {
    model:             { type: 'string',  label: 'LLM Model',          description: 'Which model to use for LLM calls' },
    temperature:       { type: 'number',  label: 'Temperature',        description: 'Sampling randomness (0=deterministic, 2=wild)', ge: 0.0, le: 2.0 },
    max_tokens:        { type: 'number',  label: 'Max Tokens',         description: 'Maximum output tokens per call', ge: 1 },
    top_p:             { type: 'number',  label: 'Top P',              description: 'Nucleus sampling probability', ge: 0.0, le: 1.0 },
    frequency_penalty: { type: 'number',  label: 'Frequency Penalty',  description: 'Penalise repeated tokens', ge: -2.0, le: 2.0 },
    presence_penalty:  { type: 'number',  label: 'Presence Penalty',   description: 'Penalise tokens already seen', ge: -2.0, le: 2.0 },
    seed:              { type: 'number',  label: 'Seed',               description: 'Deterministic sampling seed' },
  },
  'global.prompt': {
    system_prompt:     { type: 'string',  label: 'System Prompt',      description: 'System message prepended to every LLM call', multiline: true },
  },
};

function _registerBuiltinFields(configStore: import('./config/store.js').ConfigStore): void {
  const sectionsRef = (configStore as unknown as { _sections: Record<string, Record<string, import('./config/store.js').FieldSchema>>; _values: Record<string, Record<string, unknown>> });
  for (const [namespace, fields] of Object.entries(_BUILTIN_GLOBAL_FIELDS)) {
    if (!sectionsRef._sections[namespace]) {
      sectionsRef._sections[namespace] = {};
      sectionsRef._values[namespace] = {};
    }
    for (const [fieldName, def] of Object.entries(fields)) {
      if (!sectionsRef._sections[namespace][fieldName]) {
        const schema: import('./config/store.js').FieldSchema = {
          name: fieldName,
          type: def.type,
          default: null,
          label: def.label,
          description: def.description,
          ...(def.ge !== undefined ? { ge: def.ge } : {}),
          ...(def.le !== undefined ? { le: def.le } : {}),
          ...(def.multiline ? { multiline: def.multiline } : {}),
        };
        sectionsRef._sections[namespace][fieldName] = schema;
        sectionsRef._values[namespace][fieldName] = null;
      }
    }
  }
}

/**
 * Initialize the Syrin SDK and return an instrumented instance.
 *
 * Automatically patches OpenAI (always), Anthropic, LangChain, LangGraph,
 * Mastra, and Vercel AI SDK providers when their libraries are installed.
 * Starts the event batcher, registers the agent schema with the backend,
 * and begins the heartbeat keep-alive.
 *
 * @param options - Init options. All fields optional; API key required either
 *   here or via `SYRIN_API_KEY` env var.
 * @returns A fully initialized `SyrinSDKInstance`.
 *
 * @remarks
 * You MUST `await init()`. If you skip `await`, provider patches may not be
 * applied before your first API call and telemetry will be silently missed.
 *
 * @example
 * import { init } from '@syrin/sdk';
 * const sdk = await init({ apiKey: 'syrin_...', name: 'my-agent' });
 * // All subsequent OpenAI / Anthropic calls are now instrumented automatically
 */
export async function init(options: SyrinInitOptions = {}): Promise<SyrinSDKInstance> {
  // Capture the call stack NOW (synchronously) before any await — this is the only
  // moment when the caller's file appears in the stack trace.
  const _initStack = new Error().stack ?? '';

  const name = options.instanceName ?? 'default';

  const existing = _instances.get(name);
  if (existing) {
    console.warn(
      `[Syrin] Instance "${name}" is already initialized. ` +
      `Call shutdown("${name}") first to reinitialize, ` +
      `or call getInstance("${name}") to reuse the existing instance.`
    );
    // Tear down existing instance and reinitialize
    try { await existing.shutdown(); } catch { /* non-fatal */ }
    _instances.delete(name);
  }

  clearHooks();

  // Map `name` → `agentId` and `url` → `backendUrl` (internal config field names).
  // Only set when provided so DEFAULTS in createConfig() still apply.
  const configInput: Partial<SyrinSDKConfig> & { apiKey?: string } = {
    ...(options as Partial<SyrinSDKConfig>),
  };
  if (options.agentId !== undefined) configInput.agentId = options.agentId;
  else if (options.name !== undefined) configInput.agentId = options.name;  // legacy
  if (options.url !== undefined) configInput.backendUrl = options.url;

  const config = createConfig(configInput);

  const sessionId = resolveSessionId(config.sessionId);
  config.sessionId = sessionId;

  const sessionStore = new SessionStore();
  const emitter = new Emitter(config, sessionStore);
  const otelBridge = new OTelBridge(config);
  const checkpointClient = new CheckpointClient(config);

  otelBridge.setup();
  emitter.start();

  // Wire lifecycle emitter for withAgent/withWorkflow/withSwarm events
  _setLifecycleEmitter(emitter);

  // Build SyrinSDKCore — the provider-agnostic instrumentation engine
  const core = new SyrinSDKCore(config, sessionStore, emitter, otelBridge, checkpointClient);

  // Register the built-in OpenAI adapter (loads openai module lazily)
  await core.registerAdapter(new OpenAIAdapter());

  // Wire ConfigStore into core so framework adapters can read config
  const { ConfigStore } = await import('./config/store.js');
  const configStore = new ConfigStore(config.configHistoryMaxlen ?? 50, config.configAuditMaxlen ?? 1000);
  core.setConfigStore(configStore);
  _registerBuiltinFields(configStore);

  // Wire ConfigStore into emitter so ingest config_updates propagate to framework adapters
  emitter.setConfigStore(configStore);

  // Wire global TunableRegistry into core
  const { globalRegistry } = await import('./tunable/tunable.js');
  core.setTunableRegistry(globalRegistry);

  // Scan the user's source file(s) for cfg()/activeConfig() patterns and pre-populate
  // schema defaults — so the dashboard shows real values before the first LLM call.
  // This is best-effort: failures are silently swallowed.
  let _scanReport: import('./utils/code-scanner.js').ScannedDefault[] = [];
  try {
    const { scanCallerDefaults, scanPaths: _scanPathsFn } = await import('./utils/code-scanner.js');
    const scanned = options.scanPaths && options.scanPaths.length > 0
      ? _scanPathsFn(options.scanPaths)
      : scanCallerDefaults(_initStack);
    if (scanned.length > 0) {
      core.setCodeScannedDefaults(scanned);
      _scanReport = scanned;
      if (config.debug) {
        console.log(`[Syrin] Code-scan detected ${scanned.length} config defaults:`, scanned.map(d => d.path).join(', '));
      }
    }
  } catch { /* non-fatal */ }

  // Wire explicit agentFramework override — takes priority over auto-detection in register()
  if (options.agentFramework) {
    core.setAgentFramework(options.agentFramework);

    // When the user explicitly declares their framework, install the corresponding
    // Tier-2 adapter immediately — even if the library was loaded via ESM (which
    // won't appear in require.cache or trigger Module._load hooks).
    const _frameworkAdapterMap: Record<string, { path: string; exportName: string }> = {
      'langchain':  { path: './adapters/langchain/index.js',  exportName: 'LangChainAdapter' },
      'langgraph':  { path: './adapters/langgraph/index.js',  exportName: 'LangGraphAdapter' },
      'mastra':     { path: './adapters/mastra/index.js',     exportName: 'MastraAdapter'    },
      'vercel-ai':  { path: './adapters/vercel-ai/index.js',  exportName: 'VercelAIAdapter'  },
      'pydantic_ai':{ path: '', exportName: '' }, // Python-only, skip in TS
    };
    const adapterEntry = _frameworkAdapterMap[options.agentFramework];
    if (adapterEntry?.exportName && !core.isAdapterInstalled(options.agentFramework)) {
      try {
        const adapterMod = await import(adapterEntry.path) as Record<string, new () => SyrinSDKAdapter>;
        const AdapterClass = adapterMod[adapterEntry.exportName];
        if (typeof AdapterClass === 'function') {
          await core.registerAdapter(new AdapterClass());
        }
      } catch { /* optional dep not installed — skip */ }
    }
  }

  // Register user-provided adapters first — they always take precedence over auto-detection
  if (options.adapters) {
    for (const adapter of options.adapters) {
      await core.registerAdapter(adapter);
    }
  }

  // Auto-detect framework libraries: inspect require.cache for libraries already loaded,
  // then hook Module._load to catch libraries loaded after init().
  // Only libraries actively used in this process are instrumented (not merely installed).
  await installForActiveLibraries(core, config);
  installModuleHook(core, config);

  // Load persisted config from previous run (.syrin/syrin.config.json).
  // Parity with Python SDK — overrides survive restarts without waiting for polling.
  try {
    const persisted = loadPersistedConfig(options.configDir);
    if (Object.keys(persisted).length > 0) {
      // Apply to CallInterceptor so LLM calls are intercepted with persisted overrides
      getCallInterceptor().setConfig(persisted as Partial<CompleteControlConfig>);

      // Also apply to sessionStore for backwards compatibility
      const store = sessionStore as unknown as { applyConfigUpdate(sid: string, overrides: Record<string, unknown>): void };
      const sid = resolveSessionId(config.sessionId);
      if (typeof store.applyConfigUpdate === 'function') {
        store.applyConfigUpdate(sid, persisted);
      }
    }
  } catch {
    // Non-fatal
  }

  // POST config schema to backend so the dashboard knows what's remotely configurable
  await core.register();

  // Wire auto-refresh: tune() calls after init() automatically push schema without needing refreshSchema()
  _setAutoRefreshCallback(() => core.register());

  // Start heartbeat — keeps agent lastSeen fresh every 30 s + signals graceful shutdown
  const heartbeat = new Heartbeat({
    agentId: config.agentId,
    backendUrl: config.backendUrl,
    apiKey: config.apiKey,
    offline: config.offline,
    intervalMs: 30_000,
  });
  heartbeat.start();

  const instance = new SyrinSDKInstance(config, sessionStore, emitter, otelBridge, core, heartbeat, options.configDir);
  instance._scanReport = _scanReport;

  // Create and initialize ConfigSync — fetches remote config and propagates to all three stores
  const configSync = new ConfigSync({
    agentId:      config.agentId,
    backendUrl:   config.backendUrl,
    apiKey:       config.apiKey,
    offline:      config.offline,
    configStore,
    sessionStore,
    sessionId,
  });

  // Fetch and apply config overrides on startup
  await configSync.initialize();

  // Start config polling if requested (check both options and resolved config)
  const pollIntervalMs = options.configPollIntervalMs ?? config.configPollIntervalMs ?? 30_000;
  if (pollIntervalMs > 0 && !config.offline && config.agentId) {
    configSync.startPolling(pollIntervalMs);
    instance._configSync = configSync;
  }

  // Register in named registry
  _instances.set(name, instance);
  if (name === 'default') {
    _primaryInstance = instance;
  }

  if (config.debug) {
    console.log(
      `[Syrin] Initialized instance="${name}". sessionId=${sessionId} agentId=${config.agentId ?? 'none'} backend=${config.backendUrl}`
    );
  }

  sessionStore.getOrCreate(sessionId, config.agentId).catch(() => { /* ignore */ });

  return instance;
}

// ---------------------------------------------------------------------------
// Module-level helpers — refreshSchema + mountConfigEndpoint
// ---------------------------------------------------------------------------

/**
 * Re-send the agent schema to the backend.
 * Call after tune() to push custom sections to the dashboard.
 * Parity with Python SDK's sdk.refresh_schema().
 */
export async function refreshSchema(name = 'default'): Promise<void> {
  const inst = _instances.get(name);
  if (!inst) return;
  await inst.refreshSchema();
}

/**
 * Compute a stable session ID from grouping parameters — without opening a
 * session scope.  Use this when you need the ID ahead of time (e.g. to pass
 * it to a job queue or log it before the session starts).
 *
 * For opening a session scope directly, prefer {@link withSession} with an
 * options object — it calls this internally.
 *
 * @example
 * ```ts
 * // User grouped by day (default window)
 * makeSessionId({ userId: "alice" });
 * // → "u:alice:2026-04-18"
 *
 * // User grouped by hour
 * makeSessionId({ userId: "alice", window: "hour" });
 * // → "u:alice:2026-04-18T14"
 *
 * // User + named flow + day
 * makeSessionId({ userId: "alice", key: "checkout" });
 * // → "u:alice:checkout:2026-04-18"
 *
 * // Non-user grouping
 * makeSessionId({ key: "nightly-etl", window: "day" });
 * // → "k:nightly-etl:2026-04-18"
 *
 * // Persistent user session
 * makeSessionId({ userId: "alice", window: "forever" });
 * // → "u:alice"
 * ```
 */
export function makeSessionId(options: SessionOptions): string {
  const { userId, key, window: win = 'day' } = options;

  if (!userId && !key) {
    // No grouping — callers who want auto-UUID should use withSession() directly
    return generateId('ses');
  }

  const now = new Date();
  let suffix = '';
  if (win !== 'forever') {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const y = now.getUTCFullYear();
    const m = pad2(now.getUTCMonth() + 1);
    const d = pad2(now.getUTCDate());
    const h = pad2(now.getUTCHours());

    if (win === 'hour') {
      suffix = `${y}-${m}-${d}T${h}`;
    } else if (win === 'day') {
      suffix = `${y}-${m}-${d}`;
    } else if (win === 'week') {
      // ISO week number
      const jan4 = new Date(Date.UTC(y, 0, 4));
      const dayOfYear = Math.floor((now.getTime() - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
      const weekNum = Math.ceil((dayOfYear + jan4.getUTCDay()) / 7);
      suffix = `${y}-W${pad2(weekNum)}`;
    } else if (win === 'month') {
      suffix = `${y}-${m}`;
    }
  }

  const parts: string[] = [];
  if (userId) {
    parts.push(`u:${userId}`);
    if (key) parts.push(key);
  } else {
    // key-only grouping: prefix with "k:" to distinguish from user sessions
    parts.push(`k:${key!}`);
  }
  if (suffix) parts.push(suffix);
  return parts.join(':');
}

/**
 * Wrap a function so every call emits `TOOL_CALL` + `TOOL_RESULT` events automatically.
 *
 * Captures: function name, arguments, return value, latency, and errors.
 * The wrapped function is otherwise identical to the original.
 *
 * Supports both sync and async functions.
 *
 * @example
 * ```ts
 * import { instrumentTool } from "@syrin/sdk";
 *
 * const webSearch = instrumentTool(async (query: string) => {
 *   return await search(query);
 * }, { name: "web_search" });
 *
 * // Or with a named function:
 * const fetchUrl = instrumentTool(async function fetchUrl(url: string) {
 *   return await fetch(url).then(r => r.text());
 * });
 * ```
 */
export function instrumentTool<Args extends unknown[], R>(
  fn: (...args: Args) => R | Promise<R>,
  options?: { name?: string }
): (...args: Args) => R | Promise<R> {
  const toolName = options?.name ?? fn.name ?? 'unknown_tool';

  return function (...args: Args): R | Promise<R> {
    // Lazy import to avoid circular deps at module load time
    const { ToolSpan, _emitToolEvents } = require('./agent/tool-context.js') as {
      ToolSpan: new (name: string, id: string) => {
        record(r: unknown): void;
        setError(e: string): void;
      };
      _emitToolEvents: (span: unknown, args: Record<string, unknown>, exc: unknown) => void;
    };
    const { generateId } = require('./utils/helpers.js') as { generateId: (prefix: string) => string };

    const span = new ToolSpan(toolName, generateId('tc_'));
    const argsRecord: Record<string, unknown> = {};
    args.forEach((a, i) => { argsRecord[`arg${i}`] = a; });

    let result: R | Promise<R>;
    try {
      result = fn(...args);
    } catch (exc) {
      _emitToolEvents(span, argsRecord, exc);
      throw exc;
    }

    if (result instanceof Promise) {
      return result.then(
        (r) => { span.record(r); _emitToolEvents(span, argsRecord, null); return r; },
        (e) => { _emitToolEvents(span, argsRecord, e); throw e; }
      ) as R;
    }

    span.record(result);
    _emitToolEvents(span, argsRecord, null);
    return result;
  };
}

/**
 * Register an agent with per-agent observability settings.
 *
 * Module-level shorthand for `sdk.registerAgent(config)`.
 * Can be called at any point after `init()` — before or after the agent runs.
 *
 * @param config - AgentConfig with `agentId` and optional overrides.
 * @param instanceName - Target a specific named SDK instance (default: `"default"`).
 *
 * @example
 * ```ts
 * await init({ apiKey: "syrin_..." });
 *
 * // Per-agent overrides — call any time after init()
 * registerAgent({ agentId: "researcher", captureContent: true, captureToolCalls: true });
 * registerAgent({ agentId: "classifier", captureContent: false, captureToolCalls: false });
 *
 * await withAgent("researcher", async () => {
 *   await openai.chat.completions.create(...);
 * });
 * ```
 */
export function registerAgent(
  config: import('./types.js').AgentConfig,
  instanceName = 'default',
): void {
  _instances.get(instanceName)?.registerAgent(config);
}

/**
 * Returns a framework-agnostic request handler that receives config pushes
 * from the Syrin backend and applies them in-memory + persists to disk.
 *
 * Works with any HTTP framework that provides req.body + res.status().json():
 *   Express: app.post('/syrin/config', mountConfigEndpoint())
 *   Fastify: app.post('/syrin/config', async (req, reply) => mountConfigEndpoint()(req, reply))
 *   Hono:    app.post('/syrin/config', (c) => mountConfigEndpoint()(c.req, c.res))
 *
 * Parity with Python SDK's syrin_sdk.mount_config_endpoint(app).
 */
export function mountConfigEndpoint(instanceName = 'default') {
  return async (req: { body?: unknown }, res: { status(c: number): { json(b: unknown): void }; json(b: unknown): void }): Promise<void> => {
    const inst = _instances.get(instanceName);
    if (!inst) {
      res.status(503).json({ ok: false, error: 'SDK not initialised' });
      return;
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ ok: false, error: 'Body must be a JSON object of config overrides' });
      return;
    }

    const overrides = body as Record<string, unknown>;

    // Apply to all active sessions — engine.beforeCall() reads effectiveConfig from here
    const store = inst['_sessionStore'];
    const ids = typeof (store as SessionStore & { getSessionIds?(): string[] }).getSessionIds === 'function'
      ? (store as SessionStore & { getSessionIds(): string[] }).getSessionIds()
      : [];
    for (const sid of ids) {
      store.applyConfigUpdate(sid, overrides);
    }

    // Also apply to the primary session config
    // Cast is safe: overrides came from trusted backend JSON
    inst.configure(overrides as ConfigUpdate);

    // Update ConfigStore — framework adapters (LangChain _buildConfig, etc.) read from here
    // Without this, LangChain wrap() would inject stale startup values into configurable
    const coreRef = inst['_core'];
    const configStore = coreRef.getConfigStore?.();
    if (configStore) {
      try {
        configStore.applyUpdates(overrides, 'remote');
      } catch { /* non-fatal */ }
    }

    // Persist to disk using the instance's configDir
    const configDir = (inst as unknown as { _configDir?: string })._configDir;
    savePersistedConfig(overrides, configDir);

    res.json({ ok: true, applied: Object.keys(overrides).length });
  };
}

/**
 * Shutdown a named SDK instance (default: 'default').
 * Backward-compatible: `shutdown()` with no args shuts down the default instance.
 */
export async function shutdown(name = 'default'): Promise<void> {
  const inst = _instances.get(name);
  if (!inst) return;

  if (inst._pollTimer) {
    clearInterval(inst._pollTimer);
    inst._pollTimer = undefined;
  }

  await inst.shutdown();
  _instances.delete(name);

  if (name === 'default') {
    _primaryInstance = null;
  }
}

/**
 * Return the active session ID for the current async context, or a fallback.
 * Useful for correlating LLM calls with your own logging or tracing.
 *
 * Prefers the session ID from AsyncLocalStorage (set by `withSession()`),
 * falls back to the default instance's session ID, or generates a new one.
 *
 * @returns The active session ID string.
 *
 * @example
 * const sessionId = getSessionId();
 * logger.info('LLM call started', { sessionId });
 */
export function getSessionId(): string {
  if (_primaryInstance) {
    return sessionStorage.getStore() ?? _primaryInstance.sessionId;
  }
  return sessionStorage.getStore() ?? generateId('ses_');
}

/**
 * Run an async function within a session scope.
 *
 * All LLM calls made inside `fn` are tagged with the session ID and appear
 * together in the Syrin dashboard as one logical session.
 *
 * Two calling modes:
 *
 * **Independent session** — auto-generated ID, one discrete agent run:
 * ```ts
 * await withSession(async () => {
 *   await openai.chat.completions.create({ ... });
 * });
 * ```
 *
 * **Grouped / user session** — stable ID from `userId` / `key` + `window`;
 * multiple requests from the same user share one dashboard session:
 * ```ts
 * // Group Alice's requests by day (default window)
 * await withSession({ userId: 'alice' }, async () => { ... });
 * // → session_id = "u:alice:2026-04-18"
 *
 * // Group by hour — useful for high-frequency agents
 * await withSession({ userId: 'alice', window: 'hour' }, async () => { ... });
 * // → session_id = "u:alice:2026-04-18T14"
 *
 * // ISO-week grouping
 * await withSession({ userId: 'alice', window: 'week' }, async () => { ... });
 * // → session_id = "u:alice:2026-W16"
 *
 * // Monthly grouping
 * await withSession({ userId: 'alice', window: 'month' }, async () => { ... });
 * // → session_id = "u:alice:2026-04"
 *
 * // Persistent user session (no time expiry)
 * await withSession({ userId: 'alice', window: 'forever' }, async () => { ... });
 * // → session_id = "u:alice"
 *
 * // Named flow — separate sessions for concurrent user flows
 * await withSession({ userId: 'alice', key: 'checkout' }, async () => { ... });
 * // → session_id = "u:alice:checkout:2026-04-18"
 *
 * // Non-user grouping — batch jobs, tenants, pipelines
 * await withSession({ key: 'nightly-etl', window: 'day' }, async () => { ... });
 * // → session_id = "k:nightly-etl:2026-04-18"
 * ```
 *
 * Dashboard metrics unlocked by grouped sessions:
 * - Sessions per user per day / week / month
 * - Currently active users (sessions without SESSION_ENDED)
 * - Power users (highest token / cost usage)
 * - Real-time agent session counts per window
 *
 * @param optionsOrFn - {@link SessionOptions} for grouped sessions, or the async
 *   function itself for an independent auto-UUID session.
 * @param fn - Async function to execute within the session scope (when
 *   `optionsOrFn` is a {@link SessionOptions} object).
 * @returns The return value of `fn`.
 */
export async function withSession<T>(fn: () => Promise<T>): Promise<T>;
export async function withSession<T>(options: SessionOptions, fn: () => Promise<T>): Promise<T>;
export async function withSession<T>(
  optionsOrFn: SessionOptions | (() => Promise<T>),
  fn?: () => Promise<T>,
): Promise<T> {
  // Mode 1: withSession(fn) — independent auto-UUID session
  if (typeof optionsOrFn === 'function') {
    const autoId = generateId('ses');
    return _runWithSession(autoId, {}, optionsOrFn as () => Promise<T>);
  }

  // Mode 2: withSession(options, fn) — grouped session
  const opts = optionsOrFn;
  let sessionId: string;
  let extraMeta: Record<string, unknown> = {};
  if (!opts.userId && !opts.key) {
    // Options provided but no grouping keys — still auto-UUID
    sessionId = generateId('ses');
  } else {
    sessionId = makeSessionId(opts);
    if (opts.userId) extraMeta.user_id = opts.userId;
    if (opts.key) extraMeta.group_key = opts.key;
    if (opts.window) extraMeta.window = opts.window ?? 'day';
    extraMeta.is_grouped = true;
  }
  if (opts.metadata) extraMeta = { ...extraMeta, ...opts.metadata };

  if (!fn) throw new Error('withSession: fn is required when passing options');
  return _runWithSession(sessionId, extraMeta, fn);
}

/**
 * Internal helper that opens a session scope and emits SESSION_STARTED /
 * SESSION_ENDED lifecycle events.  Not part of the public API.
 */
async function _runWithSession<T>(
  sessionId: string,
  extraMeta: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {

  const inst = _primaryInstance;
  const agentId = inst?.config.agentId;
  const startTime = Date.now();
  const emitter = inst ? inst['_emitter'] : null;

  if (emitter) {
    const startedEvent = {
      event_id: generateId('evt_'),
      event_type: 'SESSION_STARTED' as const,
      timestamp: nowIso(),
      session_id: sessionId,
      agent_id: agentId,
      duration_ms: 0,
      model: '',
      provider: '',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      stream: false,
      config_applied: false,
      ...extraMeta,
    };
    emitter.emit(startedEvent as SyrinEvent, sessionId);
  }

  try {
    return await sessionStorage.run(sessionId, fn);
  } finally {
    if (emitter) {
      const endedEvent: SyrinEvent = {
        event_id: generateId('evt_'),
        event_type: 'SESSION_ENDED',
        timestamp: nowIso(),
        session_id: sessionId,
        agent_id: agentId,
        duration_ms: Date.now() - startTime,
        model: '',
        provider: '',
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        stream: false,
        config_applied: false,
      };
      emitter.emit(endedEvent, sessionId);
    }
  }
}

/**
 * Get a named SDK instance.
 * Without arguments, returns the default (primary) instance or null.
 * Pass a name to get a specific named instance — throws if not found.
 */
export function getInstance(name?: string): SyrinSDKInstance | null {
  if (name === undefined || name === 'default') {
    return _primaryInstance;
  }
  const inst = _instances.get(name);
  if (!inst) {
    throw new Error(`[Syrin] No SDK instance named "${name}". Call init({ instanceName: "${name}" }) first.`);
  }
  return inst;
}

/**
 * Return the tool validation result for a given tool_call_id on the default instance.
 * Requires `toolValidation: true` in init() options.
 *
 * @param toolCallId - The tool call ID from the LLM response.
 * @param sessionId - Optional session to query. Defaults to the primary session.
 * @returns Validation result `{ valid, error? }` or undefined if not found.
 *
 * @example
 * const result = getToolValidation('call_abc123');
 * if (result && !result.valid) console.error(result.error);
 */
export function getToolValidation(
  toolCallId: string,
  sessionId?: string
): { valid: boolean; error?: string } | undefined {
  return _primaryInstance?.getToolValidation(toolCallId, sessionId);
}

/**
 * Set local config overrides on the default SDK instance.
 * Shorthand for `sdk.configure(overrides)`.
 *
 * @param overrides - Config fields to override.
 * @param sessionId - Optional session to target. Defaults to the primary session.
 *
 * @example
 * configure({ temperature: 0.3 });
 */
export function configure(overrides: ConfigUpdate, sessionId?: string): void {
  _primaryInstance?.configure(overrides, sessionId);
}

/**
 * Create a checkpoint of the current conversation state on the default SDK instance.
 *
 * @param messages - Conversation messages to snapshot.
 * @param options - Optional session ID, label, and metadata.
 * @returns The created Checkpoint, or undefined if no SDK instance is initialized.
 *
 * @example
 * const cp = await createCheckpoint(messages, { label: 'pre-tool' });
 */
export async function createCheckpoint(
  messages: MessageParam[] | Array<Record<string, unknown>>,
  options: { sessionId?: string; label?: string; metadata?: Record<string, unknown> } = {}
): Promise<import('./core/checkpoint.js').Checkpoint | undefined> {
  return _primaryInstance?.createCheckpoint(messages, options);
}

/**
 * Restore messages from a previously saved checkpoint on the default SDK instance.
 *
 * @param checkpointId - The checkpoint ID (from a Checkpoint object's `checkpointId` field).
 * @returns The stored messages array, or undefined if the checkpoint was not found.
 *
 * @example
 * const messages = await restoreCheckpoint('ckpt_abc123');
 * if (messages) { ... }
 */
export async function restoreCheckpoint(checkpointId: string): Promise<Array<Record<string, unknown>> | undefined> {
  return _primaryInstance?.restoreCheckpoint(checkpointId);
}

/**
 * Delete a session's data from memory on the default SDK instance.
 * Useful in long-running applications to prevent unbounded memory growth.
 *
 * @param sessionId - The session identifier to delete.
 */
export function deleteSession(sessionId: string): void {
  _primaryInstance?.deleteSession(sessionId);
}

/**
 * Delete all sessions older than `olderThanMs` milliseconds from the default instance.
 * Returns the number of sessions deleted.
 *
 * @param olderThanMs - Age threshold in ms. Default: 3 600 000 (1 hour).
 * @returns The number of sessions deleted.
 *
 * @example
 * const deleted = clearStaleSessions(7_200_000); // delete sessions older than 2h
 */
export function clearStaleSessions(olderThanMs = 3_600_000): number {
  return _primaryInstance?.clearStaleSessions(olderThanMs) ?? 0;
}

/**
 * Return a sanitized config snapshot for the default SDK instance.
 * The API key is replaced with `'****'` for safe logging.
 *
 * @returns The config object with the API key masked, or null if not initialized.
 *
 * @example
 * console.log(configSnapshot());
 * // { backendUrl: 'https://api.syrin.ai', apiKey: '****', ... }
 */
export function configSnapshot(): Record<string, unknown> | null {
  return _primaryInstance?.configSnapshot() ?? null;
}

/**
 * Return a structured reference of all remotely-configurable fields on the default SDK instance.
 *
 * For each field: current value, default, source (who set it), type, constraints.
 * Returns null if the SDK is not initialized.
 *
 * Sources: `'default'` | `'remote'` | `'user'` | `'governance'` | `'anchor'`
 */
export function configReference(): ReturnType<SyrinSDKInstance['configReference']> | null {
  return _primaryInstance?.configReference() ?? null;
}

/**
 * Declare a remotely configurable value at module level.
 * Uses the primary (default) SDK instance if initialized; returns defaultValue otherwise.
 *
 * @example
 * import { cfg } from '@syrin/sdk';
 * const model = cfg('llm.model', 'gpt-4o', { label: 'LLM Model' });
 * const temp  = cfg('llm.temperature', 0.7, { ge: 0.0, le: 2.0 });
 */
export function cfg(key: string, defaultValue: string, options?: CfgOptions): string;
export function cfg(key: string, defaultValue: number, options?: CfgOptions): number;
export function cfg(key: string, defaultValue: boolean, options?: CfgOptions): boolean;
export function cfg(key: string, defaultValue?: unknown, options?: CfgOptions): unknown;
export function cfg(
  key: string,
  defaultValue: unknown = null,
  options: CfgOptions = {},
): unknown {
  if (!_primaryInstance) return defaultValue;
  return _primaryInstance.cfg(key, defaultValue, options);
}

/**
 * Emit a custom log entry that appears on the Syrin dashboard timeline.
 * Targets the **default** SDK instance. For named instances call `sdk.log()` directly.
 *
 * @param message - The log message to display on the dashboard.
 * @param options.level - Severity: `'debug'` | `'info'` (default) | `'warning'` | `'error'`
 * @param options.metadata - Optional key/value pairs for additional context.
 *
 * @example
 * log('Retrieved 42 documents', { metadata: { collection: 'kb' } });
 * log('Cost budget at 80%', { level: 'warning' });
 */
export function log(
  message: string,
  options: {
    level?: 'debug' | 'info' | 'warning' | 'error';
    metadata?: Record<string, unknown>;
  } = {},
): void {
  _primaryInstance?.log(message, options);
}

/**
 * Print a human-readable table of all remotely-configurable fields on the default SDK instance.
 * Shows current value, default, source badge, type, and constraints.
 * Prints a warning if the SDK is not initialized.
 */
export function printConfigReference(): void {
  if (!_primaryInstance) {
    console.log('[Syrin] SDK not initialized. Call init() first.');
    return;
  }
  _primaryInstance.printConfigReference();
}

/**
 * Return the config-key defaults detected by the code scanner at init().
 *
 * Each entry has a `path` (e.g. `'llm.model'`) and `default` value.
 * Returns an empty array before `init()` is called or when no patterns were detected.
 *
 * @example
 * await init({ apiKey: '...', scanPaths: ['./src'] });
 * for (const item of scanReport()) {
 *   console.log(item.path, '→', item.default);
 * }
 */
export function scanReport(): import('./utils/code-scanner.js').ScannedDefault[] {
  return _primaryInstance?.scanReport() ?? [];
}
