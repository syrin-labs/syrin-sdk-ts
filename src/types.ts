/**
 * Syrin SDK — Core TypeScript types
 */

export type TopologyType = 'single' | 'orchestrator' | 'pipeline' | 'parallel' | 'graph' | 'conditional_graph' | 'hybrid';

export type ExecutionMode = 'sequential' | 'parallel' | 'conditional';

export interface TopologyNode {
  role?: string;
  execMode?: ExecutionMode;
  group?: string;
  [key: string]: unknown;
}

export interface TopologyEdge {
  from: string;
  to: string;
  condition?: string;
  group?: string;
  label?: string;
  [key: string]: unknown;
}

export interface AgentTopology {
  type: TopologyType;
  nodes: Record<string, TopologyNode>;
  edges: TopologyEdge[];
  entryPoint?: string;
  terminalNodes?: string[];
  [key: string]: unknown;
}

export interface SyrinConfig {
  apiKey: string;
  agentId?: string;
  sessionId?: string;
  backendUrl: string;
  otelExporter: 'none' | 'console' | 'otlp';
  otelEndpoint: string;
  debug: boolean;
  captureContent: boolean;
  offline: boolean;
  /** Flush immediately when this many events are queued. */
  batchSize: number;
  /** Flush the queue if non-empty and this many ms have elapsed since last flush. */
  idleFlushMs: number;
  /** When true, include tool call args + schemas in events and validate against backend. */
  toolValidation: boolean;
  /** Auto-delete sessions older than this many ms (undefined = disabled). */
  sessionTtlMs?: number;
  /** Public URL of this agent server — stored by dashboard to enable the "Run" button. */
  agentUrl?: string;
  /**
   * How often (in ms) to poll the backend for agent config overrides.
   * 0 or undefined = disabled (default).
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

export interface SyrinEvent {
  event_id: string;
  // eslint-disable-next-line @typescript-eslint/ban-types
  event_type: 'LLM_CALL' | 'LLM_ERROR' | 'SESSION_STARTED' | 'SESSION_ENDED' | 'SESSION_CRASHED' | (string & {});
  timestamp: string;
  duration_ms: number;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  temperature?: number;
  max_tokens?: number;
  finish_reason?: string;
  stream: boolean;
  error?: string;
  config_applied: boolean;
  // Session lifecycle — set by SESSION_STARTED / SESSION_ENDED events
  session_id?: string;
  agent_id?: string;
  // Multi-agent context
  run_id?: string;
  workflow_id?: string;
  swarm_id?: string;
  parent_run_id?: string;
  // Tool contract validation
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  tool_definitions?: Array<{ name: string | undefined; parameters: unknown }>;
  // ── Rich telemetry ─────────────────────────────────────────────────────
  // Execution context
  call_index?: number;
  // Conversation structure
  message_count?: number;
  message_counts?: Record<string, number>;
  // Mutation detection — SHA-256[:16] hashes
  system_prompt_hash?: string;
  tool_set_hash?: string;
  model_config_hash?: string;
  // Context utilization
  context_tokens_used?: number;
  context_utilization?: number;
  // Loop detection signals (raw — backend decides)
  conversation_hash?: string;
  consecutive_tool_repeats?: number;
  conversation_repeat_count?: number;
  // Response quality
  response_char_count?: number;
  has_refusal?: boolean;
  // Recovery tracking
  last_checkpoint_id?: string;
  governance_applied?: boolean;
}

/** Snapshot of the active execution context (multi-agent). */
export interface RunContext {
  agentId?: string;
  runId: string;
  workflowId?: string;
  swarmId?: string;
  parentRunId?: string;
}

export type SessionType = 'production' | 'chat_test' | 'workflow_test' | 'simulation';

/** Session end status for SESSION_SUMMARY events. */
export type SessionEndStatus = 'completed' | 'stopped' | 'crashed' | 'timed_out';

export interface IngestPayload {
  session_id: string;
  agent_id?: string;
  sdk: { language: 'typescript'; version: string };
  events: SyrinEvent[];
  session_type?: SessionType;
}

export interface GovernanceAction {
  // eslint-disable-next-line @typescript-eslint/ban-types
  type: 'stop' | 'inject_message' | 'alert' | 'checkpoint' | 'restore' | (string & {});
  [key: string]: unknown;
}

export interface GovernanceData {
  actions?: GovernanceAction[];
  loop_detected?: boolean;
  drift_score?: number | null;
  incident_id?: string | null;
}

export interface ExperimentAssignment {
  experimentId: string;
  variantId: string;
  variantName: string;
  overrides: Record<string, unknown>;
}

export interface ContextInjection {
  id: string;
  injection_type: 'governance_correction' | 'manual' | 'world_state' | 'constraint' | 'fact' | 'custom';
  content: string;
}

export interface IngestResponse {
  ok: boolean;
  config_updates?: Record<string, unknown>;
  tool_validation_results?: Record<string, { valid: boolean; error?: string }>;
  governance?: GovernanceData;
  experiments?: ExperimentAssignment[];
  pendingInjections?: ContextInjection[];
}

export interface SessionState {
  sessionId: string;
  agentId?: string;
  activeConfig: Record<string, unknown>;
  localConfig: Record<string, unknown>;
  cumulativeCostUsd: number;
  callCount: number;
  callIndex: number;
  startedAt: string;
  toolValidationResults: Record<string, { valid: boolean; error?: string }>;
  pendingGovernance: GovernanceAction[];
  injectedMessages: Array<{ role: string; content: string }>;
  lastCheckpointId?: string;
  /** Criteria for evaluating session success — stored for dashboard display. */
  successCriteria?: string[];
  /** Context injections received from ingest responses. */
  pendingInjections: ContextInjection[];
  /** Session type tag set by AgentServer — forwarded to ingest payload. */
  sessionType?: SessionType;
  /** Governance signals — populated from ingest response governance block. */
  lastLoopDetected?: boolean;
  lastDriftScore?: number;
  lastIncidentId?: string;
  /** Cumulative token counts for SESSION_SUMMARY emission. */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Per-agent tool on/off states: {agentId: {toolName: boolean}} */
  agentToolStates?: Record<string, Record<string, boolean>>;
}

/** SESSION_SUMMARY event — emitted at session close as a behavioural fingerprint. */
export interface SessionSummaryEvent {
  event_id: string;
  event_type: 'SESSION_SUMMARY';
  timestamp: string;
  session_id: string;
  agent_id?: string;
  total_llm_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  tool_calls_count: number;
  max_call_depth: number;
  retry_count: number;
  session_type?: SessionType;
  end_status?: SessionEndStatus;
  success_criteria_met?: string[];
  success_criteria_failed?: string[];
  duration_ms: number;
}

/** CONTEXT_INJECTION event — emitted when SDK injects context into the next LLM call. */
export interface ContextInjectionEvent {
  event_id: string;
  event_type: 'CONTEXT_INJECTION';
  timestamp: string;
  session_id: string;
  agent_id?: string;
  /** Where the injection came from: 'config' | 'governance' | 'operator' | 'experiment'. */
  injection_source: 'config' | 'governance' | 'operator' | 'experiment';
  /** What was injected: 'system_prompt' | 'message' | 'context'. */
  injection_type: 'system_prompt' | 'message' | 'context';
  /** SHA-256[:16] fingerprint of the injected content. */
  content_hash: string;
  /** Full content (only set when captureContent=true). */
  content?: string;
}

/** EXPERIMENT_ASSIGNED event — emitted when MAB variant is applied. */
export interface ExperimentAssignedEvent {
  event_id: string;
  event_type: 'EXPERIMENT_ASSIGNED';
  timestamp: string;
  session_id: string;
  agent_id?: string;
  experiment_id: string;
  variant_id: string;
  variant_name: string;
  overrides: Record<string, unknown>;
}

/** CUSTOM event — for sdk.emit(eventName, payload). */
export interface CustomTelemetryEvent {
  event_id: string;
  event_type: 'CUSTOM';
  timestamp: string;
  session_id: string;
  agent_id?: string;
  /** The name the caller passed to sdk.emit(). */
  custom_event_name: string;
  /** Free-form key/value metadata. */
  payload: Record<string, unknown>;
}

/** Diagnostic snapshot returned by sdk.diagnose(). */
export interface SyrinDiagnostics {
  connected: boolean;
  agentRegistered: boolean;
  eventsQueued: number;
  configSource: 'remote' | 'local' | 'default';
  lastConfigUpdate: string | undefined;
  activeExperiments: string[];
  governanceActive: boolean;
  sseConnected: boolean;
  /** Most recent backend drift score, if any. */
  lastDriftScore?: number;
  /** Backend incident ID of the last governance action, if any. */
  lastIncidentId?: string;
}

export interface CallInfo {
  model: string;
  provider: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string | string[];
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  durationMs: number;
  costUsd: number;
  cumulativeCostUsd: number;
  agentId?: string;
  sessionId: string;
  configApplied: boolean;
  error?: Error;
  messages?: unknown[];
  responseText?: string;
  // Telemetry signal attributes
  callIndex?: number;
  contextUtilization?: number;
  conversationHash?: string;
  systemPromptHash?: string;
  toolSetHash?: string;
  modelConfigHash?: string;
  messageCount?: number;
  repeatedToolCalls?: number;
}
