/**
 * Syrin SDK — single source of truth for all constants.
 *
 * All hardcoded values (URLs, paths, limits, event-type strings, governance
 * action-type strings) live here. Import from this module; never repeat the
 * strings inline elsewhere in the SDK.
 *
 * Sub-modules
 * -----------
 * backend     Backend URLs, API paths, and URL builder helpers
 * defaults    Numeric defaults, hard limits, and SSE client timing
 * events      EventType — telemetry event type strings
 * governance  GovernanceActionType — backend governance action strings
 * http        HTTP header names, content-type values, and SDK version
 * providers   Provider — LLM provider name strings
 * session     SessionTypeValue — session type strings
 * sse         SSEEventName — server-sent event names
 */

export * from './backend.js';
export * from './defaults.js';
export * from './events.js';
export * from './governance.js';
export * from './http.js';
export * from './providers.js';
export * from './sage.js';
export * from './session.js';
export * from './sse.js';
