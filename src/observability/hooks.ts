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

type ConfigChangeHook = (sessionId: string, updates: Record<string, unknown>) => void;
type AlertHook = (action: Record<string, unknown>) => void;

const _configChangeHooks: ConfigChangeHook[] = [];
const _alertHooks: AlertHook[] = [];

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
// Lifecycle
// ---------------------------------------------------------------------------

/** Clear all registered hooks. Called by init() on re-initialization. */
export function clearHooks(): void {
  _configChangeHooks.length = 0;
  _alertHooks.length = 0;
}
