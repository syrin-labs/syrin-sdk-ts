/** SSE event name constants (server-sent by the backend stream). */

/** Names of SSE events emitted by `GET /agents/{id}/stream`. */
export const SSEEventName = {
  CONFIG_UPDATE: 'config_update',
  AGENT_STATUS: 'agent_status',
  EVENTS_INGESTED: 'events_ingested',
} as const;
