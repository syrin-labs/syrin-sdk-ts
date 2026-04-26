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
import { SyrinCore } from '@/core/engine.js';
import { Heartbeat } from '@/core/heartbeat.js';
import { load as loadPersistedConfig, save as savePersistedConfig } from '@/config/persist.js';
import { patchOpenAI, unpatch, isPatched } from '@/interceptors/openai.js';
import { clearHooks } from '@/observability/hooks.js';
import { generateId, nowIso } from '@/utils/helpers.js';
import type { SyrinConfig, SyrinSDK, SyrinEvent, ContextInjection, AgentTopology } from '@/types.js';
import { AgentServer } from '@/agent/server.js';
import type { AgentServerOptions } from '@/agent/server.js';
import { MultiAgentRouter } from '@/agent/router.js';
import type { AgentRunFn } from '@/agent/router.js';
import { _setAutoRefreshCallback } from '@/tunable/tunable.js';
import { agentStorage } from '@/agent/context.js';
import { SessionFeedback, sendFeedback } from '@/feedback.js';
import { AlreadyRatedError, SessionNotFoundError, ValidationError } from '@/errors.js';
import type { FeedbackRating, FeedbackOptions } from '@/feedback.js';


export type { SyrinConfig, SyrinEvent, IngestPayload, IngestResponse, SessionState, SyrinSDK, CallInfo, RunContext, GovernanceAction, GovernanceData, ContextInjection, SessionType } from '@/types.js';
export { AgentServer } from '@/agent/server.js';
export type { AgentHandler, AgentServerOptions } from '@/agent/server.js';
export { MultiAgentRouter } from '@/agent/router.js';
export type { AgentRunFn } from '@/agent/router.js';
export { AgentHandle } from '@/agent/handle.js';
import { AgentHandle } from '@/agent/handle.js';
export { SessionFeedback } from '@/feedback.js';
export type { FeedbackRating, FeedbackOptions } from '@/feedback.js';
export { AlreadyRatedError, SessionNotFoundError, ValidationError, SyrinError } from '@/errors.js';
export { getRunContext } from '@/agent/context.js';
export { GovernanceStopError } from '@/core/governance.js';
export type { Checkpoint } from '@/core/checkpoint.js';
export { onConfigChange, onAlert } from '@/observability/hooks.js';
export { SyrinCore } from '@/core/engine.js';
export type { NormalizedCallParams, NormalizedCallResult, BeforeCallResult, SchemaField } from '@/core/call-types.js';
export { ConfigStore } from '@/config/store.js';
export type { FieldSchema } from '@/config/store.js';
export { tunable, TunableField, tune, getTune, globalRegistry, TunableRegistry } from '@/tunable/tunable.js';
export type { TuneOptions, TuneFieldDef } from '@/tunable/tunable.js';

export class SyrinSDKInstance implements SyrinSDK {
  private _sessionId: string;
  private _config: SyrinConfig;
  private _sessionStore: SessionStore;
  private _emitter: Emitter;
  private _otelBridge: OTelBridge;
  private _core: SyrinCore;
  private _heartbeat: Heartbeat;

  constructor(
    config: SyrinConfig,
    sessionStore: SessionStore,
    emitter: Emitter,
    otelBridge: OTelBridge,
    core: SyrinCore,
    heartbeat: Heartbeat,
  ) {
    this._config = config;
    this._sessionStore = sessionStore;
    this._emitter = emitter;
    this._otelBridge = otelBridge;
    this._core = core;
    this._heartbeat = heartbeat;
    this._sessionId = resolveSessionId(config.sessionId);
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get config(): SyrinConfig {
    return this._config;
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
   */
  configure(overrides: Record<string, unknown>, sessionId?: string): void {
    const sid = sessionId ?? this._sessionId;
    this._sessionStore.setLocalConfig(sid, overrides);
  }

  /**
   * Return the currently active remote config for a session.
   */
  activeConfig(sessionId?: string): Record<string, unknown> {
    const sid = sessionId ?? this._sessionId;
    return this._sessionStore.getEffectiveConfig(sid);
  }

  /**
   * Create a checkpoint of the current conversation state.
   * Persisted to the Syrin backend; falls back to local cache if offline.
   */
  async createCheckpoint(
    messages: Array<Record<string, unknown>>,
    options: { sessionId?: string; label?: string; metadata?: Record<string, unknown> } = {}
  ): Promise<import('./core/checkpoint.js').Checkpoint> {
    const sid = options.sessionId ?? this._sessionId;
    const session = this._sessionStore.getSession(sid);
    const cp = await this._core.checkpointClient.save(sid, messages, {
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
   * Emit a named lifecycle event to the Syrin dashboard.
   *
   * Use this to surface production-grade lifecycle events such as guardrail
   * checks, circuit breakers, agent handoffs, budget estimations, and more.
   * Active context fields (agentId, runId, workflowId, etc.) are automatically
   * resolved from AsyncLocalStorage.
   *
   * @param eventType - Event type string. Built-in dashboard values:
   *   `GUARDRAIL_INPUT`, `GUARDRAIL_OUTPUT`, `CIRCUIT_BREAKER_OPEN`,
   *   `CIRCUIT_BREAKER_CLOSE`, `HANDOFF`, `AGENT_FORK`, `AGENT_JOIN`,
   *   `WORKER_SPAWNED`, `BUDGET_ESTIMATION`, `TOOL_SELECTED`, `CHECKPOINT`.
   * @param payload - Optional additional fields merged into the event.
   * @param sessionId - Target session (defaults to current active session).
   *
   * @example
   * sdk.emit('GUARDRAIL_INPUT', { name: 'pii_filter', passed: true });
   * sdk.emit('HANDOFF', { from_agent: 'orchestrator', to_agent: 'researcher' });
   * sdk.emit('BUDGET_ESTIMATION', { estimated_cost_usd: 0.12, budget_usd: 1.0 });
   */
  emit(
    eventType: string,
    payload?: Record<string, unknown>,
    sessionId?: string,
  ): void {
    const ctx = agentStorage.getStore();
    const sid = sessionId ?? sessionStorage.getStore() ?? this._sessionId;

    const event: Record<string, unknown> = {
      event_id: generateId('evt_'),
      event_type: eventType,
      timestamp: nowIso(),
      session_id: sid,
      agent_id: ctx?.agentId ?? this._config.agentId ?? '',
      run_id: ctx?.runId ?? null,
      workflow_id: ctx?.workflowId ?? null,
      swarm_id: ctx?.swarmId ?? null,
      parent_run_id: ctx?.parentRunId ?? null,
      duration_ms: 0,
      model: '',
      provider: '',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      stream: false,
      config_applied: false,
      ...payload,
    };

    try {
      this._emitter.emit(event as unknown as SyrinEvent, sid);
    } catch {
      // fail-open: never throw from emit
    }
  }

  // ---------------------------------------------------------------------------
  // Structured logging
  // ---------------------------------------------------------------------------

  /**
   * Emit a custom log entry that appears on the Syrin dashboard timeline.
   *
   * Use this to surface application-level events alongside LLM calls —
   * retrieval steps, business logic decisions, cost warnings, or debug
   * checkpoints — giving a complete picture of what the agent was doing
   * between LLM calls.
   *
   * @param message - The log message to display on the dashboard.
   * @param level - Severity: `"debug"`, `"info"` (default), `"warning"`, or `"error"`.
   * @param metadata - Optional key/value pairs for additional context.
   * @param sessionId - Target session (defaults to current active session).
   *
   * @example
   * sdk.log("Retrieved 42 documents from vector store",
   *         "info", { collection: "kb", query: q });
   * sdk.log("Cost budget at 80%", "warning",
   *         { spent_usd: 0.80, budget_usd: 1.00 });
   */
  log(
    message: string,
    level: 'debug' | 'info' | 'warning' | 'error' = 'info',
    metadata?: Record<string, unknown>,
    sessionId?: string,
  ): void {
    this.emit(
      'CUSTOM_LOG',
      { message, level, metadata: metadata ?? {} },
      sessionId,
    );
  }

  // ---------------------------------------------------------------------------
  // Session feedback namespace
  // ---------------------------------------------------------------------------

  /**
   * Namespace for session feedback and rating operations.
   *
   * @example
   * await sdk.sessions.rate('sess_001', 'positive');
   * await sdk.sessions.withId('sess_001').rate('negative', { reason: 'Wrong output' });
   */
  readonly sessions = {
    /**
     * Send a feedback rating for a specific session.
     * 409 → AlreadyRatedError, 404 → SessionNotFoundError, 422 → ValidationError
     */
    rate: async (sessionId: string, rating: FeedbackRating, options?: FeedbackOptions): Promise<void> => {
      await sendFeedback(this._config, sessionId, rating, options);
    },

    /**
     * Send feedback ratings for multiple sessions.
     * All requests are sent concurrently. Any errors are collected and rethrown
     * as an AggregateError.
     */
    rateBatch: async (
      items: Array<{ sessionId: string; rating: FeedbackRating } & FeedbackOptions>,
    ): Promise<void> => {
      if (items.length === 0) return;
      const errors: unknown[] = [];
      await Promise.all(
        items.map((item) =>
          sendFeedback(this._config, item.sessionId, item.rating, {
            reason: item.reason,
            voterId: item.voterId,
          }).catch((err) => { errors.push(err); }),
        ),
      );
      if (errors.length > 0) {
        const aggMsg = errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
        throw new Error(`[Syrin] rateBatch encountered errors: ${aggMsg}`);
      }
    },

    /**
     * Returns a builder scoped to `sessionId` for fluent rating.
     *
     * @example
     * await sdk.sessions.withId('sess_001').rate('positive');
     */
    withId: (sessionId: string) => ({
      rate: async (rating: FeedbackRating, options?: FeedbackOptions): Promise<void> => {
        await sendFeedback(this._config, sessionId, rating, options);
      },
    }),

    /**
     * Start a session and return a handle with a `feedback` object attached.
     *
     * When `successCriteria` is provided, a `SESSION_CRITERIA` event is emitted
     * and the criteria are stored on the session state.
     */
    start: async (options: {
      sessionId: string;
      agentId?: string;
      successCriteria?: string[];
    }): Promise<{ sessionId: string; feedback: SessionFeedback }> => {
      const { sessionId, agentId, successCriteria } = options;

      // Ensure session state exists
      const session = await this._sessionStore.getOrCreate(sessionId, agentId);

      if (successCriteria && successCriteria.length > 0) {
        session.successCriteria = successCriteria;
        // Emit SESSION_CRITERIA event
        this.emit(
          'SESSION_CRITERIA',
          { criteria: successCriteria },
          sessionId,
        );
      }

      return {
        sessionId,
        feedback: new SessionFeedback(sessionId, this._config),
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Context injection helpers
  // ---------------------------------------------------------------------------

  /**
   * Register a callback that fires whenever the Syrin backend pushes context
   * injections in an ingest response.
   *
   * Returns an unsubscribe function.
   *
   * @example
   * const unsub = sdk.onContextInjection((inj) => console.log(inj.content));
   * // later:
   * unsub();
   */
  onContextInjection(callback: (injection: ContextInjection) => void): () => void {
    return this._emitter.onContextInjection(callback);
  }

  /**
   * Return and clear all pending context injections for a session.
   * Returns an empty array when no injections are pending.
   */
  getPendingInjections(sessionId?: string): ContextInjection[] {
    const sid = sessionId ?? this._sessionId;
    return this._sessionStore.popInjections(sid);
  }

  /**
   * Create an AgentHandle — scoped agent API with cfg, field, run, chat.
   */
  agent(agentId: string): AgentHandle {
    return new AgentHandle(agentId, this);
  }

  /**
   * Define or update the multi-agent topology after init().
   *
   * @param topology - Dict with keys: type, nodes, edges, entryPoint, terminalNodes
   *
   * @example
   * ```ts
   * sdk.defineTopology({
   *   type: 'orchestrator',
   *   nodes: {
   *     root: { role: 'orchestrator' },
   *     'worker-1': { role: 'worker', execMode: 'parallel' },
   *     'worker-2': { role: 'worker', execMode: 'parallel' },
   *   },
   *   edges: [
   *     { from: 'root', to: 'worker-1' },
   *     { from: 'root', to: 'worker-2' },
   *   ],
   *   entryPoint: 'root',
   *   terminalNodes: ['worker-1', 'worker-2'],
   * });
   * ```
   */
  defineTopology(topology: AgentTopology): void {
    (this._core as unknown as { _explicitTopology: AgentTopology })._explicitTopology = topology;
  }

  /**
   * Emit a CHECKPOINT event to mark milestones in agents.
   */
  checkpoint(label: string, metadata?: Record<string, unknown>, sessionId?: string): void {
    this.emit('CHECKPOINT', { name: label, label, metadata: metadata || {} }, sessionId);
  }

  /**
   * Create an AgentServer wired to this SDK instance's session store.
   * Mount its routes on your framework of choice:
   *   server.mountExpress(app)   // Express
   *   server.mountHono(app)      // Hono
   *   fastify.register(server.fastifyPlugin())  // Fastify
   */
  createServer(options: AgentServerOptions): AgentServer {
    return new AgentServer(this._sessionStore, options);
  }

  /**
   * Create a MultiAgentRouter — routes POST /agent/:agentId/run|chat to the correct handler.
   *
   * @param agentFunctions - Map of agentId → async run function
   *
   * @example
   * const router = sdk.createAgentRouter({
   *   'researcher-agent': async (task) => { ... return result; },
   *   'writer-agent':     async (task) => { ... return result; },
   * });
   * app.use(router.express());           // Express
   * fastify.register(router.fastify());  // Fastify
   */
  createAgentRouter(agentFunctions: Record<string, AgentRunFn>): MultiAgentRouter {
    return new MultiAgentRouter({ agentFunctions, sessionStore: this._sessionStore });
  }

  async flush(): Promise<void> {
    await this._emitter.flush();
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


export interface SyrinInitOptions {
  apiKey?: string;
  agentId?: string;
  sessionId?: string;
  backendUrl?: string;
  otelExporter?: 'none' | 'console' | 'otlp';
  otelEndpoint?: string;
  debug?: boolean;
  captureContent?: boolean;
  offline?: boolean;
  /** Flush the event queue after this many ms of inactivity (default: 10 000). */
  idleFlushMs?: number;
  batchSize?: number;
  toolValidation?: boolean;
  sessionTtlMs?: number;
  /** Public URL of this agent server — stored by dashboard to enable the "Run" button. */
  agentUrl?: string;
  /**
   * Name for this SDK instance in the registry.
   * Defaults to 'default'. Multiple named instances can coexist.
   */
  instanceName?: string;
  /**
   * How often (in ms) to poll the backend for config overrides.
   * 0 (default) disables polling.
   */
  configPollIntervalMs?: number;
  /**
   * Default values for schema fields shown in the dashboard.
   * Keys use dot-notation: { 'llm.model': 'gpt-4o-mini', 'llm.temperature': 0.7 }.
   * Parity with Python SDK's schema_defaults option.
   */
  schemaDefaults?: Record<string, unknown>;
  /**
   * List of sub-agent IDs (strings) or dict mapping agent_id → config.
   * When provided as a list, the SDK auto-generates minimal agent schemas.
   * When provided as a dict, each value is a config object with optional
   * `description` and `sections` keys. Used for multi-agent systems.
   */
  agents?: string[] | Record<string, { description?: string; sections?: Record<string, unknown> }>;
  /**
   * Explicit topology definition for multi-agent systems.
   * A dict with keys: type, nodes, edges, entryPoint, terminalNodes.
   * When not provided, the SDK auto-infers orchestrator topology from agents list.
   */
  topology?: AgentTopology;
}

/**
 * Initialize the Syrin SDK.
 * Patches the OpenAI SDK and starts the event emitter.
 *
 * @remarks
 * ⚠️ You MUST await init(). If you skip await, the OpenAI SDK may not be
 * patched before your first API call and telemetry will be silently missed.
 *
 * Pass `instanceName` to support multiple named SDK instances.
 * Without `instanceName` (or `instanceName: 'default'`), behaves exactly as before.
 */
export async function init(options: SyrinInitOptions = {}): Promise<SyrinSDKInstance> {
  const name = options.instanceName ?? 'default';

  const existing = _instances.get(name);
  if (existing) {
    console.warn(
      `[Syrin] Instance "${name}" already initialized. Call shutdown("${name}") first to reinitialize.`
    );
    // Tear down existing instance and reinitialize
    try { await existing.shutdown(); } catch { /* non-fatal */ }
    _instances.delete(name);
  }

  // For 'default' instance, warn and tear down legacy singleton if present (backward compat)
  if (name === 'default' && _primaryInstance !== null) {
    console.warn(
      '[Syrin] init() called more than once for the default instance. Reinitializing. Call shutdown() first to avoid this warning.'
    );
    _teardown();
  }

  clearHooks();

  const config = createConfig(options as Partial<SyrinConfig> & { apiKey?: string });

  const sessionId = resolveSessionId(config.sessionId);
  config.sessionId = sessionId;

  const sessionStore = new SessionStore();
  const emitter = new Emitter(config, sessionStore);
  const otelBridge = new OTelBridge(config);
  const checkpointClient = new CheckpointClient(config);

  otelBridge.setup();
  emitter.start();

  // Build SyrinCore — the provider-agnostic instrumentation engine
  const core = new SyrinCore(config, sessionStore, emitter, otelBridge, checkpointClient);

  // Multi-agent schema definitions — agents= can be:
  // 1. A list of agent IDs (strings) — SDK auto-generates minimal schemas
  // 2. A dict mapping agent_id → {description, sections} — full agent definitions
  if (options.agents) {
    const agentsDict: Record<string, { description?: string; sections?: Record<string, unknown> }> = {};
    if (Array.isArray(options.agents)) {
      // Simple list of agent IDs — auto-generate minimal configs
      for (const agentId of options.agents) {
        agentsDict[agentId] = {};
      }
    } else {
      // Already a dict — use as-is
      Object.assign(agentsDict, options.agents);
    }
    (core as unknown as { _multiAgentDefs: Record<string, unknown> })._multiAgentDefs = agentsDict;
  }

  // Explicit topology definition for multi-agent systems
  if (options.topology) {
    (core as unknown as { _explicitTopology: AgentTopology })._explicitTopology = options.topology;
  }

  // Patch OpenAI directly (lazily imports openai; no-op if not installed)
  await patchOpenAI(core);

  // Wire ConfigStore into core so config reads work
  const { ConfigStore } = await import('./config/store.js');
  const configStore = new ConfigStore();
  (core as unknown as Record<string, unknown>)['_configStore'] = configStore;

  // Wire global TunableRegistry into core
  const { globalRegistry } = await import('./tunable/tunable.js');
  (core as unknown as Record<string, unknown>)['_tunableRegistry'] = globalRegistry;

  // Load persisted config from previous run (.syrin/syrin.config.json).
  // Parity with Python SDK — overrides survive restarts without waiting for polling.
  try {
    const persisted = loadPersistedConfig();
    if (Object.keys(persisted).length > 0) {
      sessionStore.setGlobalConfig(persisted);
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

  const instance = new SyrinSDKInstance(config, sessionStore, emitter, otelBridge, core, heartbeat);

  // Start config polling if requested (check both options and resolved config)
  const pollIntervalMs = options.configPollIntervalMs ?? config.configPollIntervalMs ?? 0;
  if (pollIntervalMs > 0) {
    const pollTimer = setInterval(async () => {
      try {
        const resp = await fetch(
          `${config.backendUrl}/api/v1/agents/${config.agentId}/overrides`,
          { headers: { Authorization: `Bearer ${config.apiKey}` } }
        );
        if (resp.ok) {
          const data = await resp.json() as { ok: boolean; overrides: Array<{path: string; value: unknown}> | Record<string, unknown> };
          if (data.ok && data.overrides) {
            // Handle list format [{path, value}] (Python-compatible) and legacy flat map
            const overridesMap: Record<string, unknown> = Array.isArray(data.overrides)
              ? Object.fromEntries((data.overrides as Array<{path: string; value: unknown}>).map(o => [o.path, o.value]))
              : data.overrides;
            // Persist as global template (new sessions inherit this) and apply to active sessions
            sessionStore.setGlobalConfig(overridesMap);
            for (const sid of sessionStore.getSessionIds()) {
              sessionStore.applyConfigUpdate(sid, overridesMap);
            }
          }
        }
      } catch {
        // Non-fatal — polling is best-effort
      }
    }, pollIntervalMs);

    (instance as unknown as { _pollTimer: ReturnType<typeof setInterval> })._pollTimer = pollTimer;
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

  await sessionStore.getOrCreate(sessionId, config.agentId).catch(() => { /* ignore */ });

  return instance;
}

function _teardown(): void {
  _setAutoRefreshCallback(null); // Stop auto-refresh on shutdown
  if (_primaryInstance) {
    const inst = _primaryInstance as unknown as { _pollTimer?: ReturnType<typeof setInterval> };
    if (inst._pollTimer) {
      clearInterval(inst._pollTimer);
      inst._pollTimer = undefined;
    }
    _primaryInstance.shutdown().catch(() => { /* ignore */ });
    _primaryInstance = null;
  }
  _instances.delete('default');
  if (isPatched()) {
    unpatch();
  }
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

    // Apply to global template (new sessions inherit) and all active sessions
    const store = (inst as unknown as { _sessionStore: SessionStore })._sessionStore;
    store.setGlobalConfig(overrides);
    for (const sid of store.getSessionIds()) {
      store.applyConfigUpdate(sid, overrides);
    }

    // Also apply to the primary session config
    inst.configure(overrides);

    // Persist to disk
    savePersistedConfig(overrides);

    res.json({ ok: true, applied: Object.keys(overrides).length });
  };
}

// ── Lifecycle-emitting context wrappers ───────────────────────────────────────
// These wrap the bare AsyncLocalStorage helpers from agent/context.ts and add
// AGENT_RUN_STARTED/ENDED, WORKFLOW_STARTED/ENDED, SWARM_STARTED/ENDED events
// so the dashboard timeline has proper hierarchy blocks.

import {
  withAgent as _withAgent,
  withWorkflow as _withWorkflow,
  withSwarm as _withSwarm,
} from '@/agent/context.js';
import type { RunContext } from '@/types.js';

function _emitLifecycle(eventType: string, extra: Record<string, unknown> = {}): void {
  const inst = _primaryInstance;
  if (!inst) return;
  const emitter = (inst as unknown as { _emitter: Emitter })._emitter;
  const sid = sessionStorage.getStore() ?? inst.sessionId;
  emitter.emit({
    event_id: generateId('evt_'),
    event_type: eventType,
    timestamp: nowIso(),
    session_id: sid,
    agent_id: inst.config.agentId,
    duration_ms: 0,
    model: '', provider: '',
    input_tokens: 0, output_tokens: 0, cost_usd: 0,
    stream: false,
    ...extra,
  } as SyrinEvent, sid);
}

export async function withAgent<T>(
  agentId: string,
  fn: (ctx: RunContext) => Promise<T>,
  options?: { runId?: string; workflowId?: string; swarmId?: string },
): Promise<T> {
  const start = Date.now();
  _emitLifecycle('AGENT_RUN_STARTED', { agent_id: agentId });
  try {
    return await _withAgent(agentId, fn, options);
  } finally {
    _emitLifecycle('AGENT_RUN_ENDED', { agent_id: agentId, duration_ms: Date.now() - start });
  }
}

export async function withWorkflow<T>(
  workflowId: string | undefined,
  fn: (ctx: RunContext) => Promise<T>,
  options?: { runId?: string },
): Promise<T> {
  const start = Date.now();
  const wid = workflowId ?? generateId('wf_');
  _emitLifecycle('WORKFLOW_STARTED', { workflow_id: wid });
  try {
    return await _withWorkflow(wid, fn, options);
  } finally {
    _emitLifecycle('WORKFLOW_ENDED', { workflow_id: wid, duration_ms: Date.now() - start });
  }
}

export async function withSwarm<T>(
  swarmId: string | undefined,
  fn: (ctx: RunContext) => Promise<T>,
  options?: { runId?: string },
): Promise<T> {
  const start = Date.now();
  const sid2 = swarmId ?? generateId('swarm_');
  _emitLifecycle('SWARM_STARTED', { swarm_id: sid2 });
  try {
    return await _withSwarm(sid2, fn, options);
  } finally {
    _emitLifecycle('SWARM_ENDED', { swarm_id: sid2, duration_ms: Date.now() - start });
  }
}

/**
 * Shutdown a named SDK instance (default: 'default').
 * Backward-compatible: `shutdown()` with no args shuts down the default instance.
 */
export async function shutdown(name = 'default'): Promise<void> {
  const inst = _instances.get(name);
  if (!inst) return;

  const instWithTimer = inst as unknown as { _pollTimer?: ReturnType<typeof setInterval> };
  if (instWithTimer._pollTimer) {
    clearInterval(instWithTimer._pollTimer);
    instWithTimer._pollTimer = undefined;
  }

  await inst.shutdown();
  _instances.delete(name);

  if (name === 'default') {
    _primaryInstance = null;
  }
}

export function getSessionId(): string {
  if (_primaryInstance) {
    return sessionStorage.getStore() ?? _primaryInstance.sessionId;
  }
  return sessionStorage.getStore() ?? generateId('ses_');
}

export async function withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const inst = _primaryInstance;
  const agentId = inst?.config.agentId;
  const startTime = Date.now();
  const emitter = inst ? (inst as unknown as { _emitter: Emitter })._emitter : null;

  if (emitter) {
    const startedEvent: SyrinEvent = {
      event_id: generateId('evt_'),
      event_type: 'SESSION_STARTED',
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
    };
    emitter.emit(startedEvent, sessionId);
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

export function getToolValidation(
  toolCallId: string,
  sessionId?: string
): { valid: boolean; error?: string } | undefined {
  return _primaryInstance?.getToolValidation(toolCallId, sessionId);
}

export function configure(overrides: Record<string, unknown>, sessionId?: string): void {
  _primaryInstance?.configure(overrides, sessionId);
}

export async function createCheckpoint(
  messages: Array<Record<string, unknown>>,
  options: { sessionId?: string; label?: string; metadata?: Record<string, unknown> } = {}
): Promise<import('./core/checkpoint.js').Checkpoint | undefined> {
  return _primaryInstance?.createCheckpoint(messages, options);
}

export async function restoreCheckpoint(checkpointId: string): Promise<Array<Record<string, unknown>> | undefined> {
  return _primaryInstance?.restoreCheckpoint(checkpointId);
}

export function deleteSession(sessionId: string): void {
  _primaryInstance?.deleteSession(sessionId);
}

export function clearStaleSessions(olderThanMs = 3_600_000): number {
  return _primaryInstance?.clearStaleSessions(olderThanMs) ?? 0;
}

export function configSnapshot(): Record<string, unknown> | null {
  return _primaryInstance?.configSnapshot() ?? null;
}

/**
 * Emit a custom event on the current (or specified) session.
 * Delegates to the default SDK instance.
 */
export function emit(
  eventType: string,
  payload?: Record<string, unknown>,
  sessionId?: string,
): void {
  _primaryInstance?.emit(eventType, payload, sessionId);
}

/**
 * Emit a CUSTOM_LOG event that appears on the Syrin dashboard timeline.
 * Delegates to the default SDK instance.
 *
 * @example
 * import { log } from '@syrin/sdk';
 * log("Fetched 42 documents", "info", { collection: "kb" });
 */
export function log(
  message: string,
  level: 'debug' | 'info' | 'warning' | 'error' = 'info',
  metadata?: Record<string, unknown>,
  sessionId?: string,
): void {
  _primaryInstance?.log(message, level, metadata, sessionId);
}
