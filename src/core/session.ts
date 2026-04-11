/**
 * Syrin SDK — Session management
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { SessionState } from '@/types.js';
import { generateId, nowIso } from '@/utils/helpers.js';

/**
 * AsyncLocalStorage for per-call session scoping.
 * Equivalent to Python's contextvars.ContextVar.
 */
export const sessionStorage = new AsyncLocalStorage<string>();

/**
 * Simple async lock for Node.js (single-threaded event loop).
 * Uses a queue of resolve callbacks to serialize critical sections.
 */
class AsyncMutex {
  private _locked = false;
  private _queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (!this._locked) {
        this._locked = true;
        resolve(this._release.bind(this));
      } else {
        this._queue.push(() => resolve(this._release.bind(this)));
      }
    });
  }

  private _release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }
}

const ALLOWED_CONFIG_KEYS = new Set([
  'temperature', 'max_tokens', 'model',
  'system_prompt', 'disabled_tools', 'enabled_tools',
]);

function _validateConfigValue(key: string, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  switch (key) {
    case 'temperature': return typeof value === 'number';
    case 'max_tokens':  return typeof value === 'number' && Number.isInteger(value);
    case 'model':       return typeof value === 'string';
    case 'system_prompt': return typeof value === 'string';
    case 'disabled_tools':
    case 'enabled_tools': return Array.isArray(value);
    default: return false;
  }
}

export class SessionStore {
  private sessions: Map<string, SessionState> = new Map();
  private mutex = new AsyncMutex();

  /**
   * Get existing session or create a new one.
   */
  async getOrCreate(sessionId: string, agentId?: string): Promise<SessionState> {
    const release = await this.mutex.acquire();
    try {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        // Update agentId if newly provided
        if (agentId && !existing.agentId) {
          existing.agentId = agentId;
        }
        return existing;
      }

      const newSession: SessionState = {
        sessionId,
        agentId,
        activeConfig: {},
        localConfig: {},
        cumulativeCostUsd: 0,
        callCount: 0,
        callIndex: 0,
        startedAt: nowIso(),
        toolValidationResults: {},
        pendingGovernance: [],
        injectedMessages: [],
        lastCheckpointId: undefined,
        lastConversationHash: undefined,
      };
      this.sessions.set(sessionId, newSession);
      return newSession;
    } finally {
      release();
    }
  }

  /**
   * Get existing session synchronously (returns undefined if not found).
   */
  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Apply config updates to a session's activeConfig.
   */
  applyConfigUpdate(sessionId: string, updates: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        console.warn(`[Syrin] Ignoring unknown remote config key: "${key}"`);
        continue;
      }
      if (!_validateConfigValue(key, value)) {
        console.warn(`[Syrin] Remote config key "${key}" has unexpected type (${typeof value}) — dropping`);
        continue;
      }
      if (value === null || value === undefined) {
        delete session.activeConfig[key];
      } else {
        session.activeConfig[key] = value;
      }
    }
  }

  /**
   * Merge local config overrides (wins over remote config).
   * Pass null/undefined for a key to clear it.
   */
  setLocalConfig(sessionId: string, overrides: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null || value === undefined) {
        delete session.localConfig[key];
      } else {
        session.localConfig[key] = value;
      }
    }
  }

  /**
   * Return merged effective config: activeConfig + localConfig (local wins).
   */
  getEffectiveConfig(sessionId: string): Record<string, unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    return { ...session.activeConfig, ...session.localConfig };
  }

  /**
   * Atomically pop all pending governance actions.
   */
  popGovernanceActions(sessionId: string): import('../types.js').GovernanceAction[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const actions = [...session.pendingGovernance];
    session.pendingGovernance.length = 0;
    return actions;
  }

  /**
   * Atomically pop all pending injected messages.
   */
  popInjectedMessages(sessionId: string): Array<{ role: string; content: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const messages = [...session.injectedMessages];
    session.injectedMessages.length = 0;
    return messages;
  }

  appendGovernanceAction(sessionId: string, action: import('../types.js').GovernanceAction): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingGovernance.push(action);
  }

  appendInjectedMessage(sessionId: string, message: { role: string; content: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.injectedMessages.push(message);
  }

  incrementCallIndex(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.callIndex++;
  }

  /**
   * Record a completed call, updating cost and call count.
   */
  recordCall(sessionId: string, costUsd: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cumulativeCostUsd += costUsd;
    session.callCount += 1;
  }

  /**
   * Merge tool validation results into the session store.
   */
  async storeToolValidationResults(
    sessionId: string,
    results: Record<string, { valid: boolean; error?: string }>
  ): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      session.toolValidationResults = { ...session.toolValidationResults, ...results };
    } finally {
      release();
    }
  }

  /**
   * Return the validation result for a specific tool call ID.
   */
  getToolValidation(
    sessionId: string,
    toolCallId: string
  ): { valid: boolean; error?: string } | undefined {
    return this.sessions.get(sessionId)?.toolValidationResults[toolCallId];
  }

  /**
   * Remove a session from the store.
   */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Remove sessions older than `olderThanMs` milliseconds (default: 1 hour).
   * Returns the number removed. Call periodically to prevent unbounded memory growth.
   */
  clearStaleSessions(olderThanMs: number = 3_600_000): number {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const [id, session] of this.sessions) {
      const startedAt = new Date(session.startedAt).getTime();
      if (!isNaN(startedAt) && startedAt < cutoff) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Return all session IDs currently tracked.
   */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }
}

/**
 * Factory to create a session ID, either from config or generating a fresh one.
 */
export function resolveSessionId(configuredSessionId?: string): string {
  return configuredSessionId ?? generateId('ses_');
}
