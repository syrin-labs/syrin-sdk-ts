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
import { patchAnthropic, unpatch as unpatchAnthropic } from '@/interceptors/anthropic.js';
import { patchGemini, unpatch as unpatchGemini } from '@/interceptors/gemini.js';
import { clearHooks } from '@/observability/hooks.js';
import { generateId, nowIso } from '@/utils/helpers.js';
import type { SyrinConfig, SyrinEvent, ContextInjection, AgentTopology } from '@/types.js';
import type { BillingInfo } from '@/billing.js';
import { AgentServer } from '@/agent/server.js';
import type { AgentServerOptions } from '@/agent/server.js';
import { MultiAgentRouter } from '@/agent/router.js';
import type { AgentRunFn } from '@/agent/router.js';
import { _setAutoRefreshCallback } from '@/tunable/tunable.js';
import { agentStorage } from '@/agent/context.js';
import { SessionFeedback, sendFeedback } from '@/feedback.js';
import type { FeedbackRating, FeedbackOptions } from '@/feedback.js';
import type { Checkpoint } from '@/core/checkpoint.js';
import type { SyrinDiagnostics } from '@/types.js';
import { SSEClient } from '@/observability/sse-client.js';
import { setRegisteredEmitter, clearRegisteredEmitter } from '@/agent/emitter-registry.js';
import { WorkflowClient } from '@/core/workflow-client.js';
import type { RegisterWorkflowOptions, HandoffResult, RecoveryAction } from '@/core/workflow-client.js';


export type { SyrinConfig, SyrinEvent, IngestPayload, IngestResponse, SessionState, SyrinDiagnostics, CallInfo, RunContext, GovernanceAction, GovernanceData, ContextInjection, SessionType } from '@/types.js';
export { WorkflowClient } from '@/core/workflow-client.js';
export type { RegisterWorkflowOptions, HandoffResult, RecoveryAction } from '@/core/workflow-client.js';
export type { BillingInfo, UsageSummary } from '@/billing.js';
export { AgentServer } from '@/agent/server.js';
export type { AgentHandler, AgentServerOptions } from '@/agent/server.js';
export { MultiAgentRouter } from '@/agent/router.js';
export type { AgentRunFn } from '@/agent/router.js';
export { AgentHandle } from '@/agent/handle.js';
import { AgentHandle } from '@/agent/handle.js';
export { SessionFeedback } from '@/feedback.js';
export type { FeedbackRating, FeedbackOptions } from '@/feedback.js';
export {
  AlreadyRatedError,
  SessionNotFoundError,
  ValidationError,
  SyrinError,
  SetupError,
  GovernanceApprovalRequiredError,
  GovernanceCheckpointRestoredError,
} from '@/errors.js';
export { getRunContext } from '@/agent/context.js';
export { tool, memory, toolSpan, instrumentTool, ToolSpan, MemorySpan } from '@/agent/tool-context.js';
import { tool as _tool, memory as _memory } from '@/agent/tool-context.js';
export { TraceSpan } from '@/observability/trace-span.js';
export { GovernanceStopError } from '@/core/governance.js';
export type { Checkpoint } from '@/core/checkpoint.js';
export { onConfigChange, onAlert } from '@/observability/hooks.js';
export { tunable, TunableField, tune, getTune, globalRegistry, TunableRegistry } from '@/tunable/tunable.js';
export type { TuneOptions, TuneFieldDef } from '@/tunable/tunable.js';

// ---------------------------------------------------------------------------
// SyrinSDK — the public interface returned by init() and getInstance().
// Users interact only with this type; internal implementation is hidden.
// ---------------------------------------------------------------------------

/**
 * The Syrin SDK instance. All methods returned by {@link init} are defined here.
 *
 * @remarks
 * This is the complete public API surface. No internal fields or implementation
 * details are exposed.
 */
export interface SyrinSDK {
  /** The active session ID for this instance. */
  readonly sessionId: string;
  /** Resolved SDK configuration (API key is masked in {@link configSnapshot}). */
  readonly config: SyrinConfig;

  // ── Config ────────────────────────────────────────────────────────────────
  /** Apply local config overrides for a session (takes priority over remote config). */
  configure(overrides: Record<string, unknown>, sessionId?: string): void;
  /** Return the full effective config for a session (remote + local merged). */
  activeConfig(sessionId?: string): Record<string, unknown>;
  /** Return a sanitized config snapshot with the API key masked — safe to log. */
  configSnapshot(): Record<string, unknown>;
  /** Return the last tool validation result for a given tool call ID. */
  getToolValidation(toolCallId: string, sessionId?: string): { valid: boolean; error?: string } | undefined;

  // ── Checkpoints ───────────────────────────────────────────────────────────
  /** Save a checkpoint of the current conversation state. */
  createCheckpoint(
    messages: Array<Record<string, unknown>>,
    options?: { sessionId?: string; label?: string; metadata?: Record<string, unknown> }
  ): Promise<Checkpoint>;
  /** Restore messages from a saved checkpoint. */
  restoreCheckpoint(checkpointId: string): Promise<Array<Record<string, unknown>> | undefined>;
  /** List all checkpoints for a session (from local cache). */
  listCheckpoints(sessionId?: string): Checkpoint[];

  // ── Session management ────────────────────────────────────────────────────
  /** Delete a session from the local store. */
  deleteSession(sessionId: string): void;
  /** Delete all sessions older than `olderThanMs` ms. Returns the count removed. */
  clearStaleSessions(olderThanMs?: number): number;

  // ── Session feedback ──────────────────────────────────────────────────────
  /** Session feedback helpers: rate, rateBatch, withId, start. */
  readonly sessions: {
    rate(sessionId: string, rating: FeedbackRating, options?: FeedbackOptions): Promise<void>;
    rateBatch(items: Array<{ sessionId: string; rating: FeedbackRating } & FeedbackOptions>): Promise<void>;
    withId(sessionId: string): { rate(rating: FeedbackRating, options?: FeedbackOptions): Promise<void> };
    start(options: { sessionId: string; agentId?: string; successCriteria?: string[] }): Promise<{ sessionId: string; feedback: import('@/feedback.js').SessionFeedback }>;
  };

  // ── Context injections ────────────────────────────────────────────────────
  /** Register a callback that fires when the backend pushes context injections. */
  onContextInjection(callback: (injection: ContextInjection) => void): () => void;
  /** Return and clear all pending context injections for a session. */
  getPendingInjections(sessionId?: string): ContextInjection[];

  // ── Multi-agent ───────────────────────────────────────────────────────────
  /** Create an AgentHandle scoped to a given agent ID. */
  agent(agentId: string): AgentHandle;
  /** Define or update the multi-agent topology after init(). */
  defineTopology(topology: AgentTopology): void;

  // ── Tool and memory observability ─────────────────────────────────────────
  /**
   * Track a tool call with name, args, result, and latency.
   * Emits TOOL_CALL + TOOL_RESULT events automatically.
   *
   * @example
   * const result = await sdk.tool("web_search", { query: "..." }, async (span) => {
   *   const data = await search(...);
   *   span.record(data);
   *   return data;
   * });
   */
  tool<T>(
    name: string,
    args: Record<string, unknown> | null | undefined,
    fn: (span: import('@/agent/tool-context.js').ToolSpan) => Promise<T>
  ): Promise<T>;
  tool<T>(
    name: string,
    fn: (span: import('@/agent/tool-context.js').ToolSpan) => Promise<T>
  ): Promise<T>;

  /**
   * Track a memory retrieval with store, query, result count, and latency.
   * Emits a MEMORY_RETRIEVAL event automatically.
   *
   * @example
   * const docs = await sdk.memory("pinecone", "user prefs", async (span) => {
   *   const results = await vectorDb.query("user prefs", { topK: 5 });
   *   span.record(results.length, true);
   *   return results;
   * });
   */
  memory<T>(
    storeName: string,
    query: string,
    fn: (span: import('@/agent/tool-context.js').MemorySpan) => Promise<T>
  ): Promise<T>;
  memory<T>(
    storeName: string,
    fn: (span: import('@/agent/tool-context.js').MemorySpan) => Promise<T>
  ): Promise<T>;

  // ── Telemetry ─────────────────────────────────────────────────────────────
  /**
   * Emit a named lifecycle event to the Syrin dashboard.
   * @param eventType - Built-ins: `GUARDRAIL_INPUT`, `GUARDRAIL_OUTPUT`, `HANDOFF`,
   *   `CIRCUIT_BREAKER_OPEN`, `CIRCUIT_BREAKER_CLOSE`, `CHECKPOINT`, etc.
   */
  emit(eventType: string, payload?: Record<string, unknown>, sessionId?: string): void;
  /** Emit a `CUSTOM_LOG` event that appears on the dashboard timeline. */
  log(message: string, level?: 'debug' | 'info' | 'warning' | 'error', metadata?: Record<string, unknown>, sessionId?: string): void;
  /** Emit a `CHECKPOINT` milestone event. */
  checkpoint(label: string, metadata?: Record<string, unknown>, sessionId?: string): void;

  // ── Diagnostics ───────────────────────────────────────────────────────────
  /** Return a live diagnostic snapshot (no network calls). */
  diagnose(): SyrinDiagnostics;
  /** Return `true` if the Syrin backend is reachable. Never throws. */
  healthCheck(): Promise<boolean>;
  /** Return the last billing info received from the backend, or `null`. */
  getBillingStatus(): BillingInfo | null;

  // ── Server helpers ────────────────────────────────────────────────────────
  /** Create an AgentServer for HTTP route mounting. */
  createServer(options: AgentServerOptions): AgentServer;
  /** Create a MultiAgentRouter for POST /agent/:agentId/run|chat routing. */
  createAgentRouter(agentFunctions: Record<string, AgentRunFn>): MultiAgentRouter;

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  /** Flush all queued events to the backend immediately. */
  flush(): Promise<void>;
  /** Re-push the agent schema to the backend (call after tune()). */
  refreshSchema(): Promise<void>;
  /** Flush events, stop heartbeat, uninstall patches, and release all resources. */
  shutdown(): Promise<void>;
}

/** @internal — Use the {@link SyrinSDK} interface for all type annotations. */
export class SyrinSDKInstance implements SyrinSDK {
  private _sessionId: string;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error — assigned non-enumerably via Object.defineProperty in constructor
  private _config: SyrinConfig;
  private _sessionStore: SessionStore;
  private _emitter: Emitter;
  private _otelBridge: OTelBridge;
  private _core: SyrinCore;
  private _heartbeat: Heartbeat;
  /** SSE client for real-time config delivery. Null when offline or no agentId. */
  private _sseClient: SSEClient | null = null;
  /** Polling timer started as SSE fallback or explicit configPollIntervalMs. */
  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: SyrinConfig,
    sessionStore: SessionStore,
    emitter: Emitter,
    otelBridge: OTelBridge,
    core: SyrinCore,
    heartbeat: Heartbeat,
  ) {
    // Store _config as a non-enumerable property so it is invisible to
    // JSON.stringify(sdk), Object.keys(sdk), and spread {...sdk}.
    // The getter below still exposes it for internal SDK use.
    Object.defineProperty(this, '_config', {
      value: config,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    // Override toJSON on the config object so JSON.stringify(sdk.config)
    // also masks the apiKey — protects against accidental direct logging.
    Object.defineProperty(config, 'toJSON', {
      value: () => ({ ...config, apiKey: '****' }),
      enumerable: false,
      writable: true,
      configurable: true,
    });
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
  ): Promise<Checkpoint> {
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
  listCheckpoints(sessionId?: string): Checkpoint[] {
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
    const snap = { ...this._config } as Record<string, unknown>;
    snap['apiKey'] = '****';
    return snap;
  }

  /**
   * Return a diagnostic snapshot of the current SDK state.
   *
   * Useful for health checks, debugging dashboards, and CI assertions.
   * Does not make any network calls (except the health check).
   *
   * @example
   * ```ts
   * const diag = sdk.diagnose();
   * if (!diag.connected) logger.warn('Syrin backend unreachable');
   * ```
   */
  diagnose(): SyrinDiagnostics {
    const eventsQueued = this._emitter.queueSize();
    const sseConnected = this._sseClient?.isConnected ?? false;
    const agentRegistered = this._core._registered;

    let lastLoopDetected = false;
    let lastDriftScore: number | undefined;
    let lastIncidentId: string | undefined;
    for (const sid of this._sessionStore.getSessionIds()) {
      const s = this._sessionStore.getSession(sid);
      if (s?.lastLoopDetected) lastLoopDetected = true;
      if (s?.lastDriftScore != null) lastDriftScore = s.lastDriftScore;
      if (s?.lastIncidentId != null) lastIncidentId = s.lastIncidentId;
    }

    return {
      connected: !this._config.offline,
      agentRegistered,
      eventsQueued,
      configSource: 'default',
      lastConfigUpdate: undefined,
      activeExperiments: [],
      governanceActive: lastLoopDetected,
      sseConnected,
      lastDriftScore,
      lastIncidentId,
    };
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
        throw new Error(`[Syrin SDK] rateBatch encountered errors: ${aggMsg}`);
      }
    },

    /**
     * Returns a builder scoped to `sessionId` for fluent rating.
     *
     * @example
     * await sdk.sessions.withId('sess_001').rate('positive');
     */
    withId: (sessionId: string): { rate: (rating: FeedbackRating, options?: FeedbackOptions) => Promise<void> } => ({
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
   * Track a tool call with name, args, result, and latency.
   * Delegates to the module-level tool() function.
   */
  tool<T>(
    name: string,
    argsOrFn: Record<string, unknown> | null | undefined | ((span: import('@/agent/tool-context.js').ToolSpan) => Promise<T>),
    fn?: (span: import('@/agent/tool-context.js').ToolSpan) => Promise<T>,
  ): Promise<T> {
    if (typeof argsOrFn === 'function') {
      return _tool(name, argsOrFn as (span: import('@/agent/tool-context.js').ToolSpan) => Promise<T>);
    }
    return _tool(name, argsOrFn, fn!);
  }

  /**
   * Track a memory retrieval with store, query, result count, and latency.
   * Delegates to the module-level memory() function.
   */
  memory<T>(
    storeName: string,
    queryOrFn: string | ((span: import('@/agent/tool-context.js').MemorySpan) => Promise<T>),
    fn?: (span: import('@/agent/tool-context.js').MemorySpan) => Promise<T>,
  ): Promise<T> {
    if (typeof queryOrFn === 'function') {
      return _memory(storeName, queryOrFn as (span: import('@/agent/tool-context.js').MemorySpan) => Promise<T>);
    }
    return _memory(storeName, queryOrFn, fn!);
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
    this._core._explicitTopology = topology;
  }

  /**
   * Emit a CHECKPOINT event to mark milestones in agent execution.
   *
   * @param label    Human-readable name for this checkpoint.
   * @param metadata Optional key/value context.
   * @param sessionId Target session (defaults to current active session).
   *
   * @example
   * sdk.checkpoint('research_complete', { sources: 5 });
   */
  checkpoint(label: string, metadata?: Record<string, unknown>, sessionId?: string): void {
    this.emit('CHECKPOINT', { name: label, label, metadata: metadata || {} }, sessionId);
  }

  /**
   * Check whether the Syrin backend is reachable.
   *
   * Makes a GET request to `{backendUrl}/api/v1/health` and returns `true`
   * on a 2xx response. Returns `false` on any network or HTTP error.
   *
   * Does not throw — always returns a boolean.
   *
   * @example
   * if (!await sdk.healthCheck()) {
   *   logger.warn('Syrin backend unreachable — telemetry will be queued');
   * }
   */
  async healthCheck(): Promise<boolean> {
    if (this._config.offline) return false;
    try {
      const resp = await fetch(`${this._config.backendUrl}/api/v1/health`, {
        headers: { Authorization: `Bearer ${this._config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Return the last billing info received from the backend during registration.
   * Returns null if no registration response has been received yet,
   * or if the backend does not return billing data.
   *
   * @example
   * const billing = sdk.getBillingStatus();
   * if (billing?.exceeded.length) {
   *   console.error('Usage limits exceeded — upgrade at https://app.syrin.ai/billing');
   * }
   */
  getBillingStatus(): BillingInfo | null {
    return this._core._lastBilling ?? null;
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
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._sseClient?.stop();
    this._sseClient = null;
    this._sessionStore.destroy();
    await this._heartbeat.stop();
    await this._emitter.stop();
    this._core.uninstallAll();
    await this._otelBridge.shutdown();
  }

  // ── Internal accessors (module-level helpers only — not part of SyrinSDK interface) ──

  /** @internal */ getEmitter(): Emitter { return this._emitter; }
  /** @internal */ getSessionStore(): SessionStore { return this._sessionStore; }
  /** @internal */ get _primarySessionId(): string { return this._sessionId; }
  /** @internal */ setSseClient(client: SSEClient | null): void { this._sseClient = client; }
  /** @internal */ setPollTimer(timer: ReturnType<typeof setInterval> | null): void { this._pollTimer = timer; }
  /** @internal */ clearPollTimer(): ReturnType<typeof setInterval> | null {
    const t = this._pollTimer;
    if (t !== null) { clearInterval(t); this._pollTimer = null; }
    return t;
  }
}

// ---------------------------------------------------------------------------
// Named-instance registry
// ---------------------------------------------------------------------------

/** Internal registry of named instances */
const _instances = new Map<string, SyrinSDKInstance>();
/** Primary (default) instance — used by module-level helpers */
let _primaryInstance: SyrinSDKInstance | null = null;

/** @internal — used by tool-context.ts / trace-span.ts to access emitter without circular import */
export function _getPrimaryInstance(): SyrinSDKInstance | null {
  return _primaryInstance;
}


/**
 * Options for {@link init}.
 *
 * Only `apiKey` is required in most cases (can also be set via the
 * `SYRIN_API_KEY` environment variable). All other options are optional.
 *
 * @example
 * ```ts
 * const sdk = await init({ apiKey: 'syrin_...', agentId: 'my-agent' });
 * ```
 */
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
export async function init(options: SyrinInitOptions = {}): Promise<SyrinSDK> {
  const name = options.instanceName ?? 'default';

  const existing = _instances.get(name);
  if (existing) {
    console.warn(
      `[Syrin SDK] Instance "${name}" already initialized. Call shutdown("${name}") first to reinitialize.`
    );
    // Tear down existing instance and reinitialize
    try { await existing.shutdown(); } catch { /* non-fatal */ }
    _instances.delete(name);
  }

  // For 'default' instance, warn and tear down legacy singleton if present (backward compat)
  if (name === 'default' && _primaryInstance !== null) {
    console.warn(
      '[Syrin SDK] init() called more than once for the default instance. Reinitializing. Call shutdown() first to avoid this warning.'
    );
    _teardown();
  }

  // Deprecation warnings for options that should not be user-visible
  if ('configPollIntervalMs' in options && options.configPollIntervalMs) {
    console.warn('[Syrin SDK] init() option "configPollIntervalMs" is deprecated — the SDK uses SSE for real-time config delivery and falls back to polling automatically. This option will be removed in a future release.');
  }
  if ('schemaDefaults' in options && options.schemaDefaults) {
    console.warn('[Syrin SDK] init() option "schemaDefaults" is deprecated — use agent.field() to declare fields with defaults. This option will be removed in a future release.');
  }
  if ('agentUrl' in options && options.agentUrl) {
    console.warn('[Syrin SDK] init() option "agentUrl" is deprecated — the SDK registers its own endpoint automatically. This option will be removed in a future release.');
  }
  if ('toolValidation' in options && options.toolValidation !== undefined) {
    console.warn('[Syrin SDK] init() option "toolValidation" is deprecated — tool validation is always active when the backend supports it. This option will be removed in a future release.');
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
  // Mark as NOT ready until all async setup completes (lazy-init queue).
  // Any LLM calls made between here and markReady() will be queued and replayed.
  core.isReady = false;

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
    core._multiAgentDefs = agentsDict;
  }

  // Explicit topology definition for multi-agent systems
  if (options.topology) {
    core._explicitTopology = options.topology;
  }

  // Warn if OpenAI was imported before init() was called.
  // Any completions.create() calls made before this point were not instrumented.
  // Fix: move `await init(...)` to before you construct your OpenAI client.
  try {
    const mod = require.cache[require.resolve('openai')] as unknown;
    if (mod && !isPatched()) {
      console.warn(
        '[Syrin SDK] ⚠ openai was imported before init() — LLM calls made before this point were NOT instrumented. ' +
        'Move `await init(...)` to before you construct your OpenAI client to capture all telemetry.',
      );
    }
  } catch { /* openai not installed — fine */ }

  // Patch OpenAI directly (lazily imports openai; no-op if not installed)
  await patchOpenAI(core);

  // Patch Anthropic if available (lazily imports @anthropic-ai/sdk; no-op if not installed)
  await patchAnthropic(core);

  // Patch Gemini if available (lazily imports @google/generative-ai and @google/genai; no-op if not installed)
  await patchGemini(core);

  // Wire ConfigStore into core so config reads work
  const { ConfigStore } = await import('./config/store.js');
  const configStore = new ConfigStore();
  core._configStore = configStore;

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

  // Wire tool-context and trace-span emitter registry so they can emit events
  // without a circular import back to index.ts.
  setRegisteredEmitter({ emit: emitter.emit.bind(emitter), sessionId, agentId: config.agentId });

  // Start SSE client — real-time config delivery via GET /agents/{id}/stream.
  // Falls back to polling automatically after SSE_MAX_RECONNECT_ATTEMPTS failures.
  // No-op when offline=true or agentId is not set.
  if (!config.offline && config.agentId) {
    const sseClient = new SSEClient(config, sessionStore, {
      onConfigUpdate: undefined,
      onFallbackToPolling: (): void => {
        // Guard: if a poll timer already exists (e.g. from a previous fallback
        // call or from configPollIntervalMs), do not create a second one.
        // onFallbackToPolling can be called multiple times by the SSE reconnect
        // loop before it fully exhausts its retries, so this guard is critical
        // to prevent multiple concurrent polling intervals (memory leak + redundant
        // API calls).
        if (instance['_pollTimer'] !== null) return;
        const pollIntervalMs = options.configPollIntervalMs ?? config.configPollIntervalMs ?? 0;
        if (pollIntervalMs <= 0) {
          // SSE failed and polling wasn't configured — start with a sensible default
          const fallbackInterval = 30_000;
          const pollTimer = setInterval(() => { void (async (): Promise<void> => {
            try {
              const resp = await fetch(
                `${config.backendUrl}/api/v1/agents/${config.agentId}/overrides`,
                { headers: { Authorization: `Bearer ${config.apiKey}` } }
              );
              if (resp.ok) {
                const data = await resp.json() as { ok: boolean; overrides: Record<string, unknown> };
                if (data.ok && data.overrides) {
                  sessionStore.setGlobalConfig(data.overrides);
                  for (const sid of sessionStore.getSessionIds()) {
                    sessionStore.applyConfigUpdate(sid, data.overrides);
                  }
                }
              }
            } catch { /* best-effort */ }
          })(); }, fallbackInterval);
          instance.setPollTimer(pollTimer);
        }
      },
    });
    sseClient.start();
    instance.setSseClient(sseClient);
  }

  // Start config polling if requested (check both options and resolved config)
  const pollIntervalMs = options.configPollIntervalMs ?? config.configPollIntervalMs ?? 0;
  if (pollIntervalMs > 0) {
    const pollTimer = setInterval(() => { void (async (): Promise<void> => {
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
    })(); }, pollIntervalMs);

    instance.setPollTimer(pollTimer);
  }

  // Register in named registry
  _instances.set(name, instance);
  if (name === 'default') {
    _primaryInstance = instance;
  }

  if (config.debug) {
    console.log(
      `[Syrin SDK] Initialized instance="${name}". sessionId=${sessionId} agentId=${config.agentId ?? 'none'} backend=${config.backendUrl}`
    );
  }

  await sessionStore.getOrCreate(sessionId, config.agentId).catch(() => { /* ignore */ });

  // Mark core as ready — replays any LLM events captured before init() resolved
  core.markReady(emitter);

  return instance;
}

function _teardown(): void {
  _setAutoRefreshCallback(null); // Stop auto-refresh on shutdown
  clearRegisteredEmitter();
  if (_primaryInstance) {
    _primaryInstance.shutdown().catch(() => { /* ignore */ });
    _primaryInstance = null;
  }
  _instances.delete('default');
  if (isPatched()) {
    unpatch();
  }
  unpatchAnthropic();
  unpatchGemini();
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
  return (req: { body?: unknown }, res: { status(c: number): { json(b: unknown): void }; json(b: unknown): void }): void => {
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
    const store = inst.getSessionStore();
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
  const emitter = inst.getEmitter();
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

  inst.clearPollTimer();
  await inst.shutdown();
  _instances.delete(name);

  if (name === 'default') {
    _primaryInstance = null;
    clearRegisteredEmitter();
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
  const emitter = inst ? inst.getEmitter() : null;

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

  let crashed = false;
  try {
    return await sessionStorage.run(sessionId, fn);
  } catch (err) {
    crashed = true;
    throw err;
  } finally {
    if (emitter) {
      const durationMs = Date.now() - startTime;
      const store = inst ? inst.getSessionStore() : null;
      const session = store?.getSession(sessionId);

      const endedEvent: SyrinEvent = {
        event_id: generateId('evt_'),
        event_type: crashed ? 'SESSION_CRASHED' : 'SESSION_ENDED',
        timestamp: nowIso(),
        session_id: sessionId,
        agent_id: agentId,
        duration_ms: durationMs,
        model: '',
        provider: '',
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        stream: false,
        config_applied: false,
      };
      emitter.emit(endedEvent, sessionId);

      // SESSION_SUMMARY — behavioural fingerprint for drift detection
      const summaryEvent = {
        event_id: generateId('evt_'),
        event_type: 'SESSION_SUMMARY',
        timestamp: nowIso(),
        session_id: sessionId,
        agent_id: agentId,
        duration_ms: durationMs,
        model: '',
        provider: '',
        stream: false,
        config_applied: false,
        total_llm_calls: session?.callCount ?? 0,
        total_input_tokens: session?.totalInputTokens ?? 0,
        total_output_tokens: session?.totalOutputTokens ?? 0,
        total_cost_usd: session?.cumulativeCostUsd ?? 0,
        input_tokens: session?.totalInputTokens ?? 0,
        output_tokens: session?.totalOutputTokens ?? 0,
        cost_usd: session?.cumulativeCostUsd ?? 0,
        session_type: session?.sessionType ?? 'production',
        end_status: crashed ? 'crashed' : 'completed',
      };
      emitter.emit(summaryEvent as unknown as SyrinEvent, sessionId);
    }
  }
}

/**
 * Get a named SDK instance.
 * Without arguments, returns the default (primary) instance or null.
 * Pass a name to get a specific named instance — throws if not found.
 */
export function getInstance(name?: string): SyrinSDK | null {
  if (name === undefined || name === 'default') {
    return _primaryInstance;
  }
  const inst = _instances.get(name);
  if (!inst) {
    throw new Error(`[Syrin SDK] No SDK instance named "${name}". Call init({ instanceName: "${name}" }) first.`);
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
): Promise<Checkpoint | undefined> {
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

/**
 * Return a diagnostic snapshot of the default SDK instance.
 * Returns null if the SDK has not been initialized.
 *
 * @example
 * import { diagnose } from '@syrin/sdk';
 * const d = diagnose();
 * if (!d?.connected) console.warn('Syrin backend unreachable');
 */
export function diagnose(): SyrinDiagnostics | null {
  return _primaryInstance?.diagnose() ?? null;
}

/**
 * Check whether the Syrin backend is reachable.
 * Returns false if the SDK has not been initialized.
 *
 * @example
 * import { healthCheck } from '@syrin/sdk';
 * if (!await healthCheck()) logger.warn('Syrin unreachable');
 */
export async function healthCheck(): Promise<boolean> {
  return _primaryInstance?.healthCheck() ?? false;
}

/**
 * Emit a CHECKPOINT event on the current (or specified) session.
 * Delegates to the default SDK instance.
 *
 * @example
 * import { checkpoint } from '@syrin/sdk';
 * checkpoint('research_complete', { sources: 5 });
 */
export function checkpoint(
  label: string,
  metadata?: Record<string, unknown>,
  sessionId?: string,
): void {
  _primaryInstance?.checkpoint(label, metadata, sessionId);
}

// ── Workflow Recovery Pipeline ─────────────────────────────────────────────

/** Lazily-created WorkflowClient singleton for the default SDK instance. */
let _workflowClient: WorkflowClient | null = null;

function _getWorkflowClient(): WorkflowClient | null {
  if (!_primaryInstance) return null;
  if (!_workflowClient) {
    _workflowClient = new WorkflowClient(_primaryInstance.config);
  }
  return _workflowClient;
}

/**
 * Register a multi-agent workflow with the SAGE recovery backend.
 *
 * Call once before any agents start executing. Idempotent — safe to call
 * on each workflow run (backend upserts on conflict).
 *
 * @example
 * await registerWorkflow({
 *   workflowId: 'research-pipeline',
 *   name: 'Research Pipeline',
 *   goal: 'Produce a comprehensive research report',
 *   agents: [
 *     { agentId: 'researcher', role: 'Research Agent', goal: 'Gather info', stageIndex: 0 },
 *     { agentId: 'analyst', role: 'Analysis Agent', goal: 'Analyze', stageIndex: 1 },
 *     { agentId: 'writer', role: 'Writing Agent', goal: 'Write report', stageIndex: 2 },
 *   ],
 *   sageMode: 'between-all',
 * });
 */
export async function registerWorkflow(options: RegisterWorkflowOptions): Promise<void> {
  const client = _getWorkflowClient();
  if (!client) {
    console.warn('[Syrin SDK] registerWorkflow() called before init() — skipping');
    return;
  }
  await client.registerWorkflow(options);
}

/**
 * Notify SAGE of an agent handoff. SAGE detects drift asynchronously.
 *
 * Returns a HandoffResult immediately. Recovery injection (if needed) is
 * stored and available via getPendingRecovery() before the next agent starts.
 *
 * @example
 * const result = await handoff({
 *   sessionId: 'ses_abc',
 *   workflowId: 'research-pipeline',
 *   fromAgentId: 'researcher',
 *   toAgentId: 'analyst',
 *   stageOutput: researcherOutput,
 *   fromStage: 0,
 *   toStage: 1,
 * });
 *
 * // Before running the analyst:
 * const injection = getRecoveryInjection('ses_abc', 'analyst');
 * if (injection) systemPrompt = injection + '\n\n' + systemPrompt;
 */
export async function handoff(opts: {
  sessionId: string;
  workflowId: string;
  fromAgentId: string;
  toAgentId: string;
  stageOutput: string;
  fromStage: number;
  toStage: number;
}): Promise<HandoffResult> {
  const client = _getWorkflowClient();
  if (!client) {
    return { handoffId: null, sageStatus: 'skipped', driftDetected: null, recoveryAction: null };
  }
  return client.handoff(
    opts.sessionId,
    opts.workflowId,
    opts.fromAgentId,
    opts.toAgentId,
    opts.stageOutput,
    opts.fromStage,
    opts.toStage,
  );
}

/**
 * Get any pending recovery injection for an agent before it executes.
 * Returns the injection text to prepend to the agent's system prompt, or null.
 * Consumes the injection (returns null on subsequent calls for same agent).
 *
 * @example
 * const injection = getRecoveryInjection(sessionId, 'analyst');
 * if (injection) {
 *   systemPrompt = injection + '\n\n' + originalSystemPrompt;
 * }
 */
export function getRecoveryInjection(sessionId: string, agentId: string): string | null {
  return _getWorkflowClient()?.buildInjectionPrompt(sessionId, agentId) ?? null;
}

/**
 * Clear session state after workflow completes.
 */
export function clearWorkflowSession(sessionId: string): void {
  _getWorkflowClient()?.clearSession(sessionId);
  _workflowClient = null; // Reset so next init() gets fresh client
}
