/**
 * Syrin SDK — Core TypeScript types
 */

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
}

export interface SyrinEvent {
  event_id: string;
  event_type: 'LLM_CALL' | 'LLM_ERROR' | 'SESSION_STARTED' | 'SESSION_ENDED';
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
  // Framework context — set when a Tier 2 adapter (LangGraph, LangChain, etc.) is active
  framework?: string;
  graph_id?: string;
  node_name?: string;
}

/** Snapshot of the active execution context (multi-agent). */
export interface RunContext {
  agentId?: string;
  runId: string;
  workflowId?: string;
  swarmId?: string;
  parentRunId?: string;
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
}

export interface SyrinSDK {
  readonly sessionId: string;
  readonly config: SyrinConfig;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
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
