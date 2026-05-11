/** Backend URLs, API paths, and URL builder helpers. */

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

export const WORKFLOWS_PATH = `${API_PREFIX}/workflows`;
export const HANDOFFS_PATH = `${API_PREFIX}/handoffs`;
export const HANDOFF_RESULT_PATH = `${API_PREFIX}/handoffs/{handoffId}/result`;

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

/** Build absolute workflows URL. */
export function workflowsUrl(base: string): string {
  return `${base}${WORKFLOWS_PATH}`;
}

/** Build absolute handoffs URL. */
export function handoffsUrl(base: string): string {
  return `${base}${HANDOFFS_PATH}`;
}

/** Build absolute handoff result URL. */
export function handoffResultUrl(base: string, handoffId: string): string {
  return `${base}${API_PREFIX}/handoffs/${handoffId}/result`;
}
