/**
 * Syrin SDK — single source of truth for all constants.
 *
 * All hardcoded values (URLs, paths, limits, event-type strings, governance
 * action-type strings) live here. Import from this module; never repeat the
 * strings inline elsewhere in the SDK.
 */

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/** Default Syrin backend base URL. Override via SYRIN_BACKEND_URL or backendUrl in init(). */
export const DEFAULT_BACKEND_URL = 'https://app.syrin.ai';

/** API version prefix used for every endpoint path. */
export const API_PREFIX = '/api/v1';

// ---------------------------------------------------------------------------
// Endpoint paths (all relative to the backend base URL)
// ---------------------------------------------------------------------------

export const HEALTH_PATH = `${API_PREFIX}/health`;
export const INGEST_PATH = `${API_PREFIX}/ingest`;

export const AGENT_REGISTER_PATH = `${API_PREFIX}/agents/{agentId}/register`;
export const AGENT_HEARTBEAT_PATH = `${API_PREFIX}/agents/{agentId}/heartbeat`;
export const AGENT_OVERRIDES_PATH = `${API_PREFIX}/agents/{agentId}/overrides`;
export const AGENT_STREAM_PATH = `${API_PREFIX}/agents/{agentId}/stream`;
export const APPROVALS_PATH = `${API_PREFIX}/approvals/{approvalId}`;

/** Build absolute agent registration URL. */
export function agentRegisterUrl(base: string, agentId: string): string {
  return `${base}${API_PREFIX}/agents/${agentId}/register`;
}

/** Build absolute agent heartbeat URL. */
export function agentHeartbeatUrl(base: string, agentId: string): string {
  return `${base}${API_PREFIX}/agents/${agentId}/heartbeat`;
}

/** Build absolute config-overrides polling URL. */
export function agentOverridesUrl(base: string, agentId: string): string {
  return `${base}${API_PREFIX}/agents/${agentId}/overrides`;
}

/** Build absolute SSE stream URL. */
export function agentStreamUrl(base: string, agentId: string): string {
  return `${base}${API_PREFIX}/agents/${agentId}/stream`;
}

/** Build absolute approval status URL. */
export function approvalsUrl(base: string, approvalId: string): string {
  return `${base}${API_PREFIX}/approvals/${approvalId}`;
}

/** Build absolute ingest URL. */
export function ingestUrl(base: string): string {
  return `${base}${INGEST_PATH}`;
}

/** Build absolute health URL. */
export function healthUrl(base: string): string {
  return `${base}${HEALTH_PATH}`;
}

// ---------------------------------------------------------------------------
// SDK defaults
// ---------------------------------------------------------------------------

/** Flush the queue immediately when this many events are queued. */
export const DEFAULT_BATCH_SIZE = 100;

/** Flush if the queue is non-empty and no new events have arrived for this long (ms). */
export const DEFAULT_IDLE_FLUSH_MS = 10_000;

/** Timeout for /ingest and /health HTTP calls (ms). */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/** Timeout for heartbeat HTTP calls (ms). */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;

/** Timeout for config-override polling GET calls (ms). */
export const DEFAULT_POLL_TIMEOUT_MS = 10_000;

/** Interval between heartbeat POSTs (ms). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Maximum number of events queued before the oldest are dropped. */
export const DEFAULT_MAX_QUEUE_SIZE = 1000;

/** Maximum characters in a governance inject_message payload. */
export const MAX_INJECT_CONTENT_LEN = 10_000;

/** Maximum characters in a checkpoint label. */
export const MAX_CHECKPOINT_LABEL_LEN = 255;

/** Maximum events per ingest batch (backend hard limit is 500; SDK caps lower). */
export const MAX_INGEST_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// SSE client
// ---------------------------------------------------------------------------

/** Backend sends an SSE heartbeat comment every 25 seconds. */
export const SSE_SERVER_HEARTBEAT_MS = 25_000;

/** Number of times the SSE client reconnects before falling back to polling. */
export const SSE_MAX_RECONNECT_ATTEMPTS = 5;

/** Initial back-off before the first reconnect attempt (ms). */
export const SSE_RECONNECT_BACKOFF_BASE_MS = 1_000;

/** Maximum back-off between reconnect attempts (ms). */
export const SSE_RECONNECT_BACKOFF_MAX_MS = 60_000;

/** Timeout for SSE connection read (ms); should exceed server heartbeat. */
export const SSE_READ_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * String constants for Syrin telemetry event types.
 *
 * Use these instead of bare strings so that any future renames are a
 * one-line change in this file.
 *
 * @example
 * ```ts
 * import { EventType } from '@syrin/sdk/constants';
 * const event = { event_type: EventType.LLM_CALL, ... };
 * ```
 */
export const EventType = {
  // LLM calls
  LLM_CALL: 'LLM_CALL',
  LLM_ERROR: 'LLM_ERROR',

  // Session lifecycle
  SESSION_STARTED: 'SESSION_STARTED',
  SESSION_ENDED: 'SESSION_ENDED',
  SESSION_SUMMARY: 'SESSION_SUMMARY',

  // Agent lifecycle
  AGENT_RUN_STARTED: 'AGENT_RUN_STARTED',
  AGENT_RUN_ENDED: 'AGENT_RUN_ENDED',

  // Workflow / swarm lifecycle
  WORKFLOW_STARTED: 'WORKFLOW_STARTED',
  WORKFLOW_ENDED: 'WORKFLOW_ENDED',
  SWARM_STARTED: 'SWARM_STARTED',
  SWARM_ENDED: 'SWARM_ENDED',

  // Config
  CONFIG_APPLIED: 'CONFIG_APPLIED',

  // Tools
  TOOL_CALL: 'TOOL_CALL',
  TOOL_RESULT: 'TOOL_RESULT',
  TOOL_SELECTED: 'TOOL_SELECTED',

  // Approvals (HITL)
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  APPROVAL_GRANTED: 'APPROVAL_GRANTED',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',

  // Governance
  GOVERNANCE_TRIGGERED: 'GOVERNANCE_TRIGGERED',

  // Observability
  CONTEXT_INJECTION: 'CONTEXT_INJECTION',
  EXPERIMENT_ASSIGNED: 'EXPERIMENT_ASSIGNED',
  MEMORY_RETRIEVAL: 'MEMORY_RETRIEVAL',
  CUSTOM_LOG: 'CUSTOM_LOG',
  CUSTOM: 'CUSTOM',

  // Multi-agent routing
  HANDOFF: 'HANDOFF',
  AGENT_FORK: 'AGENT_FORK',
  AGENT_JOIN: 'AGENT_JOIN',
  WORKER_SPAWNED: 'WORKER_SPAWNED',

  // Guardrails / circuit breakers
  GUARDRAIL_INPUT: 'GUARDRAIL_INPUT',
  GUARDRAIL_OUTPUT: 'GUARDRAIL_OUTPUT',
  CIRCUIT_BREAKER_OPEN: 'CIRCUIT_BREAKER_OPEN',
  CIRCUIT_BREAKER_CLOSE: 'CIRCUIT_BREAKER_CLOSE',

  // Budget
  BUDGET_ESTIMATION: 'BUDGET_ESTIMATION',

  // Framework adapters
  CHAIN_EXECUTION: 'CHAIN_EXECUTION',

  // Internal
  QUEUE_OVERFLOW: 'QUEUE_OVERFLOW',
} as const;

export type EventTypeName = typeof EventType[keyof typeof EventType];

// ---------------------------------------------------------------------------
// Governance action types
// ---------------------------------------------------------------------------

/**
 * String constants for governance action type values.
 * Backend sends these in `governance.actions[].type`.
 */
export const GovernanceActionType = {
  STOP: 'stop',
  INJECT_MESSAGE: 'inject_message',
  ALERT: 'alert',
  CHECKPOINT: 'checkpoint',
  RESTORE: 'restore',
  CONFIG_OVERRIDE: 'config_override',
  REQUIRE_APPROVAL: 'require_approval',
} as const;

export type GovernanceActionTypeName = typeof GovernanceActionType[keyof typeof GovernanceActionType];

// ---------------------------------------------------------------------------
// SSE event names (server-sent by the backend stream)
// ---------------------------------------------------------------------------

/** Names of SSE events emitted by `GET /agents/{id}/stream`. */
export const SSEEventName = {
  CONFIG_UPDATE: 'config_update',
  AGENT_STATUS: 'agent_status',
  EVENTS_INGESTED: 'events_ingested',
} as const;

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/** Valid values for the `session_type` field in ingest payloads. */
export const SessionTypeValue = {
  PRODUCTION: 'production',
  CHAT_TEST: 'chat_test',
  WORKFLOW_TEST: 'workflow_test',
  SIMULATION: 'simulation',
} as const;

// ---------------------------------------------------------------------------
// HTTP headers
// ---------------------------------------------------------------------------

export const HEADER_CONTENT_TYPE = 'Content-Type';
export const HEADER_AUTHORIZATION = 'Authorization';
export const HEADER_SDK_VERSION = 'X-Syrin-SDK';
export const CONTENT_TYPE_JSON = 'application/json';

// Re-export SDK version from one place
export const SDK_VERSION = '1.1.0';
