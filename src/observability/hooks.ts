/**
 * Syrin SDK — Hook registry.
 *
 * Register callbacks to react to SDK events without polling.
 *
 *   onConfigChange((sessionId, updates) => {
 *     console.log(`Config changed for ${sessionId}:`, updates);
 *   });
 *
 *   onAlert((action) => {
 *     if (action.level === 'critical') pagerDuty.trigger(action.message);
 *   });
 */

import type { SyrinEvent } from '@/types.js';

type ConfigChangeHook = (sessionId: string, updates: Record<string, unknown>) => void;
type AlertHook = (action: Record<string, unknown>) => void;
export type EventListener = (event: SyrinEvent) => void;

const _configChangeHooks: ConfigChangeHook[] = [];
const _alertHooks: AlertHook[] = [];

/** Map from event_type (or null for catch-all) to listeners. */
const _eventListeners: Map<string | null, EventListener[]> = new Map();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register a hook called when the backend returns config_updates. */
export function onConfigChange(fn: ConfigChangeHook): void {
  _configChangeHooks.push(fn);
}

/** Register a hook called when the backend sends an alert governance action. */
export function onAlert(fn: AlertHook): void {
  _alertHooks.push(fn);
}

// ---------------------------------------------------------------------------
// Fire (called by emitter)
// ---------------------------------------------------------------------------

export function fireConfigChange(sessionId: string, updates: Record<string, unknown>): void {
  for (const hook of _configChangeHooks) {
    try {
      hook(sessionId, updates);
    } catch {
      // swallow — hooks must not crash the SDK
    }
  }
}

export function fireAlert(action: Record<string, unknown>): void {
  for (const hook of _alertHooks) {
    try {
      hook(action);
    } catch {
      // swallow
    }
  }
}

// ---------------------------------------------------------------------------
// Event listener registry (sdk.on())
// ---------------------------------------------------------------------------

/**
 * Register a listener for a specific event type (or all events when `eventType` is null).
 * Returns an unsubscribe function that removes the listener when called.
 */
export function registerEventListener(
  eventType: string | null,
  fn: EventListener,
): () => void {
  const list = _eventListeners.get(eventType) ?? [];
  list.push(fn);
  _eventListeners.set(eventType, list);
  return () => {
    const updated = (_eventListeners.get(eventType) ?? []).filter(f => f !== fn);
    _eventListeners.set(eventType, updated);
  };
}

/**
 * Dispatch a SyrinEvent to all registered listeners.
 * Called by the Emitter whenever an event is queued.
 */
export function dispatchEvent(event: SyrinEvent): void {
  // Type-specific listeners
  const typed = _eventListeners.get(event.event_type) ?? [];
  for (const fn of typed) {
    try { fn(event); } catch { /* swallow — listeners must not crash the SDK */ }
  }
  // Catch-all listeners (null key)
  const all = _eventListeners.get(null) ?? [];
  for (const fn of all) {
    try { fn(event); } catch { /* swallow */ }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Clear all registered hooks. Called by init() on re-initialization. */
export function clearHooks(): void {
  _configChangeHooks.length = 0;
  _alertHooks.length = 0;
  _eventListeners.clear();
}
