/**
 * Syrin SDK — Event emitter and HTTP batcher
 *
 * Flush strategy:
 *   1. Immediate — when queue reaches batchSize
 *   2. Idle timeout — scheduled lazily per emit(); fires idleFlushMs after
 *      the first queued event when a full batch hasn't triggered first.
 */

import type { SyrinSDKConfig, SyrinEvent, SyrinEventBase, IngestPayload, IngestResponse } from '@/types.js';
import type { SessionStore } from '@/core/session.js';
import type { ConfigStore } from '@/config/store.js';
import { SDK_VERSION } from '@/config/config.js';
import { GovernanceResponse } from '@/core/governance.js';
import { fireConfigChange, fireAlert, dispatchEvent } from '@/observability/hooks.js';
import { generateId, nowIso } from '@/utils/helpers.js';

// MAX_QUEUE_SIZE is now read from config.maxQueueSize (default: 1000)

/**
 * Redact the API key from error messages and log strings to prevent key leakage.
 *
 * @param text - The string that may contain the API key.
 * @param apiKey - The API key to redact.
 * @returns The string with all occurrences of the API key replaced with '****'.
 */
function redactApiKey(text: string, apiKey: string): string {
  if (!apiKey || !text) return text;
  return text.split(apiKey).join('****');
}

interface QueuedEvent {
  event: SyrinEvent;
  sessionId: string;
  /** Number of times this event has been re-queued after a failed POST. */
  _syrinRetry?: number;
}

const MAX_RETRY = 3;

export class Emitter {
  private config: SyrinSDKConfig;
  private sessionStore: SessionStore;
  private _configStore: ConfigStore | null = null;
  private queue: QueuedEvent[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private flushPromise: Promise<void> | null = null;
  /** Snapshot of the last config_updates map received from the backend.
   *  Used to suppress CONFIG_APPLIED spam: we only emit when values actually change. */
  private _lastConfigSnapshot: Record<string, unknown> = {};

  constructor(config: SyrinSDKConfig, sessionStore: SessionStore, configStore?: ConfigStore) {
    this.config = config;
    this.sessionStore = sessionStore;
    this._configStore = configStore ?? null;
  }

  /**
   * Wire a ConfigStore into the emitter after construction.
   * Called by init() once the ConfigStore is created and ready.
   * This allows framework adapters to receive config_updates from the ingest
   * response — not just the SessionStore / CallInterceptor path.
   */
  setConfigStore(store: ConfigStore): void {
    this._configStore = store;
  }

  start(): void {
    // No persistent interval — idle flush is scheduled lazily per emit().
    if (!this.config.offline) {
      this._checkHealth().catch(() => { /* already warned inside */ });
    }
  }

  emit(event: SyrinEvent, sessionId: string): void {
    // Fire sdk.on() listeners immediately (synchronous, before queuing)
    try { dispatchEvent(event); } catch { /* fail-open */ }

    const queued: QueuedEvent = { event, sessionId };

    // Enforce max queue size: drop oldest
    const maxQ = this.config.maxQueueSize ?? 1000;
    if (this.queue.length >= maxQ) {
      const excess = this.queue.length - maxQ + 1;
      this.queue.splice(0, excess);
      if (this.config.debug) {
        console.warn(`[Syrin] Queue full, dropped ${excess} oldest event(s).`);
      }
    }

    this.queue.push(queued);

    // Auto-flush immediately when batch size reached; otherwise schedule idle flush
    if (this.queue.length >= this.config.batchSize) {
      this._cancelIdleTimer();
      this.flush().catch((err) => {
        if (this.config.debug) console.warn('[Syrin] Batch-full flush error:', err);
      });
    } else {
      this._scheduleIdleFlush();
    }
  }

  async flush(): Promise<void> {
    if (this.config.offline) {
      if (this.config.debug) {
        console.log('[Syrin] Offline mode — skipping flush.');
      }
      return;
    }

    // If a flush is in progress, wait for it — our event may be in that batch
    if (this.flushPromise) {
      await this.flushPromise;
      // After it completes, if the queue is now empty our event was already sent
      if (this.queue.length === 0) return;
    }

    if (this.queue.length === 0) return;

    this.flushing = true;
    this.flushPromise = this._doFlush().finally(() => {
      this.flushing = false;
      this.flushPromise = null;
    });
    await this.flushPromise;
  }

  private _scheduleIdleFlush(): void {
    if (this.idleTimer !== null) return; // already scheduled
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.flush().catch((err) => {
        if (this.config.debug) console.warn('[Syrin] Idle flush error:', err);
      });
    }, this.config.idleFlushMs);
    // Allow Node.js to exit even if timer is pending
    const timer = this.idleTimer as unknown as { unref?: () => void };
    if (timer.unref) timer.unref();
  }

  private _cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async _checkHealth(): Promise<void> {
    try {
      const response = await fetch(`${this.config.backendUrl}/api/v1/health`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        console.warn(
          `[Syrin] Backend health check failed (HTTP ${response.status}). ` +
          'Check your backendUrl setting.'
        );
      } else if (this.config.debug) {
        console.log('[Syrin] Backend health check OK.');
      }
    } catch {
      console.warn(
        `[Syrin] Syrin backend unreachable at ${this.config.backendUrl}. ` +
        'Events will be queued locally. Check your backendUrl setting.'
      );
    }
  }

  private async _doFlush(): Promise<void> {
    // Take current batch
    const batch = this.queue.splice(0, this.config.batchSize);

    // Group by sessionId — each session gets its own POST so session_id is always correct
    const bySession = new Map<string, QueuedEvent[]>();
    for (const qe of batch) {
      let group = bySession.get(qe.sessionId);
      if (!group) {
        group = [];
        bySession.set(qe.sessionId, group);
      }
      group.push(qe);
    }

    // Fire one POST per session group (in parallel); await all so flush() only resolves when done
    await Promise.allSettled(
      Array.from(bySession.entries()).map(([sessionId, group]) =>
        this._postBatch(sessionId, group)
      )
    );
  }

  private async _postBatch(sessionId: string, batch: QueuedEvent[]): Promise<void> {
    const session = this.sessionStore.getSession(sessionId);

    const payload: IngestPayload = {
      session_id: sessionId,
      agent_id: session?.agentId ?? this.config.agentId,
      sdk: { language: 'typescript', version: SDK_VERSION },
      events: batch.map((q) => q.event),
    };

    try {
      const response = await fetch(`${this.config.backendUrl}/api/v1/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          'X-Syrin-SDK': `typescript/${SDK_VERSION}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        // Only log status code and URL — never log request headers (they contain the API key)
        console.warn(
          `[Syrin] Ingest failed (HTTP ${response.status} at ${this.config.backendUrl}/api/v1/ingest). Re-queuing events.`
        );
        this._requeue(batch);
      } else {
        const data = (await response.json()) as IngestResponse;

        if (this.config.debug) {
          console.log(
            `[Syrin] Flushed ${batch.length} event(s) for session ${sessionId}. Backend ok=${data.ok}`
          );
        }

        let configUpdates = data.config_updates;

        // Enterprise controls: disableRemoteConfig / configUpdateAllowlist
        if (configUpdates && Object.keys(configUpdates).length > 0) {
          if (this.config.disableRemoteConfig) {
            console.info('[Syrin] Remote config update ignored: disableRemoteConfig=true');
            configUpdates = undefined;
          } else if (this.config.configUpdateAllowlist) {
            const allowlist = new Set(this.config.configUpdateAllowlist);
            const rejected = Object.keys(configUpdates).filter((k) => !allowlist.has(k));
            if (rejected.length > 0) {
              console.info(`[Syrin] Remote config keys blocked by allowlist: ${rejected.join(', ')}`);
            }
            configUpdates = Object.fromEntries(
              Object.entries(configUpdates).filter(([k]) => allowlist.has(k))
            ) as typeof configUpdates;
          }
        }

        if (configUpdates && Object.keys(configUpdates).length > 0) {
          // Diff against the last known snapshot — only act when values actually changed.
          // The backend always echoes the full active config on every ingest response,
          // so without this guard every flush would emit a CONFIG_APPLIED event.
          const changedKeys = Object.keys(configUpdates).filter(
            (k) => this._lastConfigSnapshot[k] !== (configUpdates)[k],
          );
          this._lastConfigSnapshot = { ...configUpdates } as Record<string, unknown>;

          if (changedKeys.length > 0) {
            console.info('[Syrin] Config update applied:', changedKeys.join(', '));
          }

          // Update SessionStore — engine.beforeCall() reads effectiveConfig from here
          this.sessionStore.applyConfigUpdate(sessionId, configUpdates);

          // Update ConfigStore — framework adapters (LangChain _buildConfig, etc.) read from here
          if (this._configStore) {
            try {
              this._configStore.applyUpdates(configUpdates, 'remote');
            } catch { /* non-fatal — config store errors must not break event delivery */ }
          }

          if (changedKeys.length > 0) {
            fireConfigChange(sessionId, configUpdates);
            // Emit CONFIG_APPLIED only when something actually changed
            const configEvent: SyrinEvent = {
              event_id: generateId('evt_'),
              event_type: 'CONFIG_APPLIED',
              timestamp: nowIso(),
              session_id: sessionId,
              config_keys: changedKeys,
              model: '',
              provider: '',
              input_tokens: 0,
              output_tokens: 0,
              cost_usd: 0,
              stream: false,
              config_applied: true,
              duration_ms: 0,
            };
            try { this.emit(configEvent, sessionId); } catch { /* fail-open */ }
          }
        }

        if (data.tool_validation_results && Object.keys(data.tool_validation_results).length > 0) {
          if (this.config.debug) {
            console.log('[Syrin] Received tool_validation_results:', data.tool_validation_results);
          }
          await this.sessionStore.storeToolValidationResults(sessionId, data.tool_validation_results);
        }

        if (data.governance) {
          const polls = this._applyGovernance(sessionId, data.governance);
          if (polls.length > 0) {
            await Promise.allSettled(polls);
          }
        }
      }
    } catch (err) {
      if (this.config.debug) {
        // Redact API key from error messages before logging
        const errMsg = err instanceof Error ? redactApiKey(err.message, this.config.apiKey) : String(err);
        console.warn('[Syrin] Ingest network error (detail):', errMsg);
      } else {
        console.warn('[Syrin] Failed to reach Syrin backend. Events re-queued.');
      }
      this._requeue(batch);
    }
  }

  /**
   * Build a minimal SyrinEvent for approval lifecycle events.
   * DRY helper used by all three APPROVAL_* event types.
   */
  private _buildApprovalEvent(
    eventType: SyrinEvent['event_type'],
    sessionId: string,
    approvalId: string,
    toolName: string,
    reason?: string,
  ): SyrinEvent {
    const base: SyrinEventBase & { event_type: SyrinEvent['event_type']; approval_id: string; tool_name: string; reason: string | null } = {
      event_id: generateId('evt_'),
      event_type: eventType,
      timestamp: nowIso(),
      session_id: sessionId,
      approval_id: approvalId,
      tool_name: toolName,
      reason: reason ?? null,
      model: '',
      provider: '',
      duration_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      stream: false,
      config_applied: false,
    };
    // Cast is safe: the event_type discriminant is set from the caller
    return base as SyrinEvent;
  }

  /**
   * Poll the backend for the outcome of a `require_approval` action and emit
   * the appropriate APPROVAL_GRANTED or APPROVAL_REJECTED event.
   * Non-fatal — any network or parsing error is swallowed.
   */
  private async _pollApproval(
    sessionId: string,
    approvalId: string,
    toolName: string,
  ): Promise<void> {
    try {
      const res = await fetch(
        `${this.config.backendUrl}/api/v1/approvals/${approvalId}`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) return;

      let body: Record<string, unknown>;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        return;
      }

      const status = (body['approval'] as Record<string, unknown> | undefined)?.['status'] as string | undefined;

      if (status === 'approved') {
        const ev = this._buildApprovalEvent('APPROVAL_GRANTED', sessionId, approvalId, toolName);
        try { this.emit(ev, sessionId); } catch { /* fail-open */ }
      } else if (status === 'rejected' || status === 'expired') {
        const ev = this._buildApprovalEvent('APPROVAL_REJECTED', sessionId, approvalId, toolName, status);
        try { this.emit(ev, sessionId); } catch { /* fail-open */ }
      }
      // 'pending' → no event; caller decides whether to retry
    } catch {
      // Network failure — non-fatal
    }
  }

  private _applyGovernance(sessionId: string, governanceData: import('../types.js').GovernanceData): Promise<void>[] {
    const gov = new GovernanceResponse(governanceData);
    const pollPromises: Promise<void>[] = [];

    if (gov.loopDetected && this.config.debug) {
      console.warn(`[Syrin] Backend detected loop for session ${sessionId} (drift_score=${gov.driftScore}, incident=${gov.incidentId})`);
    }

    for (const action of gov.actions) {
      const actionType = action.type;

      // Emit GOVERNANCE_TRIGGERED before processing (even for unknown types)
      const govEvent: SyrinEvent = {
        event_id: generateId('evt_'),
        event_type: 'GOVERNANCE_TRIGGERED',
        timestamp: nowIso(),
        session_id: sessionId,
        action_type: actionType,
        incident_id: (action as Record<string, unknown>)['incident_id'] as string ?? null,
        reason: (action as Record<string, unknown>)['reason'] as string ?? null,
        model: '',
        provider: '',
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        stream: false,
        config_applied: false,
        duration_ms: 0,
      };
      try { this.emit(govEvent, sessionId); } catch { /* fail-open */ }

      if (actionType === 'require_approval') {
        const approvalId = (action as Record<string, unknown>)['approval_id'] as string | undefined;
        const toolName   = (action as Record<string, unknown>)['tool_name']   as string | undefined;
        // Guard: approval_id is required to emit events and poll
        if (!approvalId) continue;
        const resolvedToolName = toolName ?? '';
        const requestedEv = this._buildApprovalEvent(
          'APPROVAL_REQUESTED',
          sessionId,
          approvalId,
          resolvedToolName,
        );
        try { this.emit(requestedEv, sessionId); } catch { /* fail-open */ }
        // Collect poll promise — awaited by _doFlush() via pollPromises
        pollPromises.push(this._pollApproval(sessionId, approvalId, resolvedToolName));
      } else if (actionType === 'stop') {
        // Attach drift_score from the GovernanceResponse envelope so engine can pass it to GovernanceStopError
        const enrichedAction = gov.driftScore != null
          ? { ...action, drift_score: gov.driftScore }
          : action;
        this.sessionStore.appendGovernanceAction(sessionId, enrichedAction);
        console.warn(`[Syrin] Backend sent STOP action for session ${sessionId} — reason: ${action['reason'] ?? '?'}`);
      } else if (actionType === 'inject_message') {
        const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);
        let rawRole = (action['role'] as string) ?? 'system';
        let rawContent = (action['content'] as string) ?? '';
        // Validate role: only known chat roles accepted.
        if (!ALLOWED_ROLES.has(rawRole)) {
          console.warn(`[Syrin] inject_message has invalid role '${rawRole}' — defaulting to 'system'`);
          rawRole = 'system';
        }
        // Validate content: must be a string, capped at 10 000 chars.
        if (typeof rawContent !== 'string') {
          console.warn('[Syrin] inject_message content is not a string — ignoring');
        } else {
          if (rawContent.length > 10_000) {
            console.warn(`[Syrin] inject_message content truncated to 10 000 chars (was ${rawContent.length})`);
            rawContent = rawContent.slice(0, 10_000);
          }
          this.sessionStore.appendInjectedMessage(sessionId, { role: rawRole, content: rawContent });
          if (this.config.debug) {
            console.log(`[Syrin] inject_message queued for session ${sessionId} (role=${rawRole} len=${rawContent.length})`);
          }
        }
      } else if (actionType === 'alert') {
        fireAlert(action as Record<string, unknown>);
        console.info(`[Syrin][${action['level'] ?? 'info'}] alert for session ${sessionId}: ${action['message'] ?? ''}`);
      } else if (actionType === 'checkpoint' || actionType === 'restore') {
        // Validate checkpoint label length to prevent unbounded metadata growth.
        let validatedAction = action;
        if (actionType === 'checkpoint') {
          const rawLabel = (action as Record<string, unknown>)['label'];
          if (typeof rawLabel === 'string' && rawLabel.length > 255) {
            console.warn(`[Syrin] checkpoint label truncated to 255 chars (was ${rawLabel.length})`);
            validatedAction = { ...action, label: rawLabel.slice(0, 255) } as typeof action;
          }
        }
        this.sessionStore.appendGovernanceAction(sessionId, validatedAction);
        if (this.config.debug) {
          console.log(`[Syrin] ${actionType} action queued for session ${sessionId}`);
        }
      }
    }

    return pollPromises;
  }

  private _requeue(batch: QueuedEvent[]): void {
    // Increment retry counter; drop events that have already been retried MAX_RETRY times.
    // After the Nth increment the event has failed N times total — drop at N >= MAX_RETRY.
    const eligible = batch
      .map((qe) => ({ ...qe, _syrinRetry: (qe._syrinRetry ?? 0) + 1 }))
      .filter((qe) => qe._syrinRetry < MAX_RETRY);

    const available = (this.config.maxQueueSize ?? 1000) - this.queue.length;
    const toRequeue = eligible.slice(0, Math.max(0, available));
    this.queue.unshift(...toRequeue);
  }

  async stop(): Promise<void> {
    this._cancelIdleTimer();
    await this.flush();
  }

  /** Returns current queue size — for testing. */
  queueSize(): number {
    return this.queue.length;
  }
}
