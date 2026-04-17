/**
 * Syrin SDK — Core TypeScript types
 */

export interface SyrinSDKConfig {
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
  /** Timeout (ms) for /ingest and /health HTTP requests. */
  httpTimeoutMs?: number;
  /** Timeout (ms) for heartbeat POST requests. */
  heartbeatTimeoutMs?: number;
  /** Timeout (ms) for config-polling GET requests. */
  pollTimeoutMs?: number;
  /** Interval (ms) between heartbeat POSTs. */
  heartbeatIntervalMs?: number;
  /** Max in-memory events before oldest are dropped. */
  maxQueueSize?: number;
  /** Max config versions retained in history ring buffer. */
  configHistoryMaxlen?: number;
  /** Max audit log entries retained in ring buffer. */
  configAuditMaxlen?: number;
  /** When true, include tool call args + schemas in events and validate against backend. */
  toolValidation: boolean;
  /** Auto-delete sessions older than this many ms (undefined = disabled). */
  sessionTtlMs?: number;
  /** Public URL of this agent server — stored by dashboard to enable the "Run" button. */
  serverUrl?: string;
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
  /** Governance opt-in policy. Defaults: allowStop=false, allowInjectMessage=false. */
  governance?: import('./core/governance.js').GovernancePolicy;
  /** When true, all backend config_updates are ignored. Default: false. */
  disableRemoteConfig?: boolean;
  /** When set, only these config keys may be updated remotely. Example: ['llm.temperature']. */
  configUpdateAllowlist?: string[];
  /**
   * Directory containing the `.syrin/syrin.config.json` file for persisted config.
   * Defaults to process.cwd(). Set per-process for isolated config directories.
   */
  configDir?: string;
}

// ---------------------------------------------------------------------------
// Discriminated union for SyrinEvent
// ---------------------------------------------------------------------------

/**
 * Common fields shared by all event types.
 */
export interface SyrinEventBase {
  /** Unique event identifier with 'evt_' prefix. */
  event_id: string;
  /** ISO 8601 timestamp of when the event was created. */
  timestamp: string;
  /** Duration of the operation in milliseconds. */
  duration_ms: number;
  /** LLM model name (e.g. 'gpt-4o', 'claude-3-5-sonnet'). Empty string for non-LLM events. */
  model: string;
  /** LLM provider name (e.g. 'openai', 'anthropic'). Empty string for non-LLM events. */
  provider: string;
  /** Input token count. 0 for non-LLM events. */
  input_tokens: number;
  /** Output token count. 0 for non-LLM events. */
  output_tokens: number;
  /** Estimated cost in USD. 0 for non-LLM events. */
  cost_usd: number;
  /** Whether the response was streamed. */
  stream: boolean;
  /** Error message if the call failed. */
  error?: string;
  /** Whether a config override was applied to this call. */
  config_applied: boolean;
  /** Session identifier — set by SESSION_STARTED / SESSION_ENDED events. */
  session_id?: string;
  /** Agent identifier. */
  agent_id?: string;
  /** Run identifier for multi-agent context. */
  run_id?: string;
  /** Workflow identifier for multi-agent context. */
  workflow_id?: string;
  /** Swarm identifier for multi-agent context. */
  swarm_id?: string;
  /** Parent run identifier for nested agent calls. */
  parent_run_id?: string;
  /** Trace identifier that spans the entire multi-agent call tree. */
  trace_id?: string;
  /** Nesting depth of this call. 0 = outermost. */
  call_depth?: number;
  /** Framework context — set when a Tier 2 adapter is active. */
  framework?: string;
  /** LangGraph graph identifier. */
  graph_id?: string;
  /** LangGraph node name. */
  node_name?: string;
}

/**
 * Emitted for every completed LLM API call.
 * Carries rich telemetry including cost, token counts, hashes, and loop-detection signals.
 */
export interface LLMCallEvent extends SyrinEventBase {
  event_type: 'LLM_CALL';
  /** LLM temperature used for this call. Undefined for models that ignore temperature. */
  temperature?: number;
  /** Max output tokens requested. */
  max_tokens?: number;
  /** Reason the model stopped generating (e.g. 'stop', 'length', 'tool_calls'). */
  finish_reason?: string;
  /** Whether governance actions were applied. */
  governance_applied?: boolean;
  /** Tool calls returned in the LLM response. */
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  /** Tool definitions passed in the request. */
  tool_definitions?: Array<{ name: string | undefined; parameters: unknown }>;
  // ── Rich telemetry ─────────────────────────────────────────────────────
  /** Sequential call index within the session. */
  call_index?: number;
  /** Total number of messages in the conversation. */
  message_count?: number;
  /** Message counts broken down by role. */
  message_counts?: Record<string, number>;
  /** SHA-256[:16] hash of the system prompt. */
  system_prompt_hash?: string;
  /** SHA-256[:16] hash of the tool set definitions. */
  tool_set_hash?: string;
  /** SHA-256[:16] hash of the model config (model + temperature + max_tokens). */
  model_config_hash?: string;
  /** Total tokens used in context. */
  context_tokens_used?: number;
  /** Fraction of context window used (0.0–1.0). */
  context_utilization?: number;
  /** SHA-256[:16] hash of the full conversation for loop detection. */
  conversation_hash?: string;
  /** Number of consecutive repeated tool calls. */
  consecutive_tool_repeats?: number;
  /** Number of times this conversation hash has been seen. */
  conversation_repeat_count?: number;
  /** Character count of the model's response text. */
  response_char_count?: number;
  /** Whether the response text looks like a refusal. */
  has_refusal?: boolean;
  /** ID of the last checkpoint saved in this session. */
  last_checkpoint_id?: string;
  /** SHA-256[:16] hash tracking how the conversation changed between calls. */
  mutation_hash?: string;
  /** SHA-256[:16] hash of the tool calls returned in this response. */
  tool_call_hash?: string | null;
  /** Full conversation messages — only when captureContent is true. */
  prompt_messages?: Array<{ role: string; content: unknown }>;
  /** Model completion text — only when captureContent is true. */
  completion_text?: string;
}

/**
 * Emitted when an LLM API call throws an error.
 */
export interface LLMErrorEvent extends SyrinEventBase {
  event_type: 'LLM_ERROR';
  /** The error message from the thrown exception. */
  error: string;
  /** LLM temperature at the time of the error. */
  temperature?: number;
  /** Max tokens at the time of the error. */
  max_tokens?: number;
}

/**
 * Emitted when a new session is created via withSession().
 */
export interface SessionStartedEvent extends SyrinEventBase {
  event_type: 'SESSION_STARTED';
  session_id: string;
}

/**
 * Emitted when a session created via withSession() ends.
 */
export interface SessionEndedEvent extends SyrinEventBase {
  event_type: 'SESSION_ENDED';
  session_id: string;
}

/**
 * Emitted when an agent run starts via withAgent().
 */
export interface AgentRunStartedEvent extends SyrinEventBase {
  event_type: 'AGENT_RUN_STARTED';
}

/**
 * Emitted when an agent run ends via withAgent().
 */
export interface AgentRunEndedEvent extends SyrinEventBase {
  event_type: 'AGENT_RUN_ENDED';
}

/**
 * Emitted when a workflow starts via withWorkflow().
 */
export interface WorkflowStartedEvent extends SyrinEventBase {
  event_type: 'WORKFLOW_STARTED';
}

/**
 * Emitted when a workflow ends via withWorkflow().
 */
export interface WorkflowEndedEvent extends SyrinEventBase {
  event_type: 'WORKFLOW_ENDED';
}

/**
 * Emitted when a swarm starts via withSwarm().
 */
export interface SwarmStartedEvent extends SyrinEventBase {
  event_type: 'SWARM_STARTED';
}

/**
 * Emitted when a swarm ends via withSwarm().
 */
export interface SwarmEndedEvent extends SyrinEventBase {
  event_type: 'SWARM_ENDED';
}

/**
 * Emitted when the backend sends a governance action (stop, inject_message, alert, etc.).
 */
export interface GovernanceTriggerEvent extends SyrinEventBase {
  event_type: 'GOVERNANCE_TRIGGERED';
  /** The type of governance action (e.g. 'stop', 'alert', 'inject_message'). */
  action_type?: string;
  /** Backend incident identifier. */
  incident_id?: string | null;
  /** Human-readable reason for the action. */
  reason?: string | null;
}

/**
 * Emitted after remote config updates are applied to a session.
 */
export interface ConfigAppliedEvent extends SyrinEventBase {
  event_type: 'CONFIG_APPLIED';
  /** The config keys that were updated. */
  config_keys?: string[];
}

/**
 * Emitted when the LLM requests a tool call.
 */
export interface ToolCallEvent extends SyrinEventBase {
  event_type: 'TOOL_CALL';
  /** Name of the tool being called. */
  tool_name?: string;
  /** Unique identifier for this tool call, used to correlate with TOOL_RESULT. */
  tool_call_id?: string;
  /** Raw JSON string of arguments passed to the tool. */
  tool_arguments?: string;
}

/**
 * Emitted when a tool returns a result back to the LLM.
 */
export interface ToolResultEvent extends SyrinEventBase {
  event_type: 'TOOL_RESULT';
  /** Name of the tool that produced this result. */
  tool_name?: string;
  /** Identifier matching the original TOOL_CALL event. */
  tool_call_id?: string;
  /** The tool's return value as a string. */
  tool_result?: string;
}

/**
 * Emitted when an agent retrieves data from a memory store.
 */
export interface MemoryRetrievalEvent extends SyrinEventBase {
  event_type: 'MEMORY_RETRIEVAL';
  /** Name of the memory store queried. */
  store_name: string;
  /** Query string or cache key used for retrieval. */
  query: string;
  /** Number of results returned. */
  result_count: number;
  /** Whether the retrieval was a cache/exact hit. */
  hit?: boolean;
}

/**
 * Emitted when the backend requests human approval for a tool call.
 */
export interface ApprovalRequestedEvent extends SyrinEventBase {
  event_type: 'APPROVAL_REQUESTED';
  /** Backend-assigned approval identifier. */
  approval_id?: string;
  /** Name of the tool awaiting approval. */
  tool_name?: string;
  /** Optional human-readable reason for the approval request. */
  reason?: string | null;
}

/**
 * Emitted when a human approves a pending tool call.
 */
export interface ApprovalGrantedEvent extends SyrinEventBase {
  event_type: 'APPROVAL_GRANTED';
  /** Backend-assigned approval identifier. */
  approval_id?: string;
  /** Name of the approved tool. */
  tool_name?: string;
}

/**
 * Emitted when a human rejects (or the approval expires for) a pending tool call.
 */
export interface ApprovalRejectedEvent extends SyrinEventBase {
  event_type: 'APPROVAL_REJECTED';
  /** Backend-assigned approval identifier. */
  approval_id?: string;
  /** Name of the rejected tool. */
  tool_name?: string;
  /** Reason for rejection ('rejected' or 'expired'). */
  reason?: string | null;
}

/**
 * Emitted by LangChain and LangGraph adapters when a chain/graph invocation completes.
 * Carries the chain name, run ID, duration, and any error that occurred.
 */
export interface ChainExecutionEvent extends SyrinEventBase {
  event_type: 'CHAIN_EXECUTION';
  /** Human-readable name of the chain or graph being executed. */
  chain_name?: string;
  /** LangChain run identifier for correlating with LLM_CALL events. */
  chain_run_id?: string | null;
  /** LangGraph graph identifier. */
  graph_id?: string;
}

/**
 * Emitted when the user calls `sdk.log()` or the module-level `log()`.
 * Appears on the dashboard timeline alongside LLM calls and tool calls.
 */
export interface CustomLogEvent extends SyrinEventBase {
  event_type: 'CUSTOM_LOG';
  /** The log message to display on the dashboard. */
  message: string;
  /** Severity level: 'debug' | 'info' | 'warning' | 'error' */
  level: string;
  /** Optional free-form key/value pairs for additional context. */
  metadata?: Record<string, unknown>;
}

/**
 * Discriminated union of all Syrin event types.
 * Use the `event_type` field to narrow to a specific event shape.
 *
 * @example
 * function handle(event: SyrinEvent) {
 *   if (event.event_type === 'LLM_CALL') {
 *     console.log(event.cost_usd); // typed as number
 *   }
 * }
 */
export type SyrinEvent =
  | LLMCallEvent
  | LLMErrorEvent
  | MemoryRetrievalEvent
  | SessionStartedEvent
  | SessionEndedEvent
  | AgentRunStartedEvent
  | AgentRunEndedEvent
  | WorkflowStartedEvent
  | WorkflowEndedEvent
  | SwarmStartedEvent
  | SwarmEndedEvent
  | GovernanceTriggerEvent
  | ConfigAppliedEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRequestedEvent
  | ApprovalGrantedEvent
  | ApprovalRejectedEvent
  | ChainExecutionEvent
  | CustomLogEvent;

// ---------------------------------------------------------------------------
// Config update types (Task 3)
// ---------------------------------------------------------------------------

/**
 * Config values that can be updated at runtime via configure() or remote config_updates.
 * All fields are optional — only provided fields are changed.
 * Null explicitly clears a field back to the library default.
 */
export interface ConfigUpdate {
  /**
   * LLM temperature (0.0–2.0). Clamped per-provider at call time.
   * Anthropic: hard-capped at 1.0. o1/o3 models: ignored.
   */
  temperature?: number | null;
  /** Max output tokens. */
  max_tokens?: number | null;
  /** Model to use (e.g. 'gpt-4o', 'claude-3-5-sonnet'). */
  model?: string | null;
  /** System prompt override. Null removes the system prompt. */
  system_prompt?: string | null;
  /** Top-p nucleus sampling parameter (0.0–1.0). */
  top_p?: number | null;
  /** Frequency penalty (-2.0–2.0). OpenAI only. */
  frequency_penalty?: number | null;
  /** Presence penalty (-2.0–2.0). OpenAI only. */
  presence_penalty?: number | null;
}

// ---------------------------------------------------------------------------
// Checkpoint message type (Task 3)
// ---------------------------------------------------------------------------

/**
 * A single message in a conversation, suitable for passing to createCheckpoint().
 */
export interface MessageParam {
  /** Role of the message author. */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Text content of the message. */
  content: string;
  /** Name of the tool that produced this message. Only for role='tool'. */
  name?: string;
  /** Tool call ID this message is responding to. Only for role='tool'. */
  tool_call_id?: string;
}

// ---------------------------------------------------------------------------
// Remaining shared types
// ---------------------------------------------------------------------------

/** Snapshot of the active execution context (multi-agent). */
export interface RunContext {
  /** Agent identifier for this run context. */
  agentId?: string;
  /** Unique run identifier generated at withAgent() entry. */
  runId: string;
  /** Workflow identifier, set by withWorkflow(). */
  workflowId?: string;
  /** Swarm identifier, set by withSwarm(). */
  swarmId?: string;
  /** Parent run identifier for nested calls. */
  parentRunId?: string;
  /**
   * Spans the entire multi-agent call tree — inherited by child agents.
   * Generated at the root withAgent() / withWorkflow() / withSwarm() call.
   */
  traceId: string;
  /** Nesting level: 0 = outermost call, 1 = first nested agent, etc. */
  callDepth: number;
}

export interface IngestPayload {
  session_id: string;
  agent_id?: string;
  sdk: { language: 'typescript'; version: string };
  events: SyrinEvent[];
}

export interface GovernanceAction {
  type: 'stop' | 'inject_message' | 'alert' | 'checkpoint' | 'restore' | string;
  [key: string]: unknown;
}

export interface GovernanceData {
  actions?: GovernanceAction[];
  loop_detected?: boolean;
  drift_score?: number | null;
  incident_id?: string | null;
}

export interface IngestResponse {
  ok: boolean;
  config_updates?: Record<string, unknown>;
  tool_validation_results?: Record<string, { valid: boolean; error?: string }>;
  governance?: GovernanceData;
}

/**
 * In-memory state for a single session.
 */
export interface SessionState {
  /** Session identifier. */
  sessionId: string;
  /** Associated agent identifier. */
  agentId?: string;
  /** Merged effective config (governance > anchors > local > remote > defaults). */
  activeConfig: Record<string, unknown>;
  /** User-set local config overrides. */
  localConfig: Record<string, unknown>;
  /** Cumulative cost across all LLM calls in this session. */
  cumulativeCostUsd: number;
  /** Total number of LLM calls completed in this session. */
  callCount: number;
  /** Monotonically-increasing call index (incremented after each call). */
  callIndex: number;
  /** ISO timestamp of when the session was created. */
  startedAt: string;
  /** Tool validation results keyed by tool_call_id. */
  toolValidationResults: Record<string, { valid: boolean; error?: string }>;
  /** Governance actions waiting to be executed on the next LLM call. */
  pendingGovernance: GovernanceAction[];
  /** Messages to be prepended to the next LLM call. */
  injectedMessages: Array<{ role: string; content: string }>;
  /** ID of the last checkpoint created in this session. */
  lastCheckpointId?: string;
  /** Conversation hash from the previous LLM call, used to compute mutation_hash. */
  lastConversationHash?: string;
}

export interface SyrinSDK {
  readonly sessionId: string;
  readonly config: SyrinSDKConfig;
  /** Set local config overrides — takes priority over remote config. Returns `this` for chaining. */
  configure(overrides: ConfigUpdate, sessionId?: string): this;
  /** Return the currently active config for a session (remote + local overrides merged). */
  activeConfig(sessionId?: string): Record<string, unknown>;
  /** Create a checkpoint of the current conversation state. */
  createCheckpoint(
    messages: MessageParam[] | Array<Record<string, unknown>>,
    options?: { sessionId?: string; label?: string; metadata?: Record<string, unknown> }
  ): Promise<{ checkpointId: string; label?: string; messages: Array<Record<string, unknown>> }>;
  /** Restore messages from a saved checkpoint. Returns `undefined` if not found. */
  restoreCheckpoint(checkpointId: string): Promise<Array<Record<string, unknown>> | undefined>;
  /** Register a custom adapter after init(). Returns `this` for chaining. */
  registerAdapter(adapter: import('./adapters/types.js').SyrinSDKAdapter): Promise<this>;
  /** Flush all pending events immediately. */
  flush(): Promise<void>;
  /** Flush, stop heartbeat, and clean up. */
  shutdown(): Promise<void>;
}

/**
 * Full call info passed to OTel span builder.
 */
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
  // Framework context
  framework?: string;
  langgraphGraphId?: string;
  langgraphNodeName?: string;
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
