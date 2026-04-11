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
import { SDK_VERSION } from '@/config/config.js';
import { GovernanceResponse } from '@/core/governance.js';
import { fireConfigChange, fireAlert } from '@/observability/hooks.js';
import { generateId, nowIso } from '@/utils/helpers.js';

const MAX_QUEUE_SIZE = 1000;

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
}

export class Emitter {
  private config: SyrinSDKConfig;
  private sessionStore: SessionStore;
  private queue: QueuedEvent[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private flushPromise: Promise<void> | null = null;
  /** Snapshot of the last config_updates map received from the backend.
   *  Used to suppress CONFIG_APPLIED spam: we only emit when values actually change. */
  private _lastConfigSnapshot: Record<string, unknown> = {};

  constructor(config: SyrinSDKConfig, sessionStore: SessionStore) {
    this.config = config;
    this.sessionStore = sessionStore;
  }

  start(): void {
    // No persistent interval — idle flush is scheduled lazily per emit().
    if (!this.config.offline) {
      this._checkHealth().catch(() => { /* already warned inside */ });
    }
  }

  emit(event: SyrinEvent, sessionId: string): void {
    const queued: QueuedEvent = { event, sessionId };

    // Enforce max queue size: drop oldest
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      const excess = this.queue.length - MAX_QUEUE_SIZE + 1;
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
      const response = await fetch(`${this.config.backendUrl}/health`, {
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

    // Group events by sessionId for the payload
    const primarySessionId = batch[0].sessionId;
    const session = this.sessionStore.getSession(primarySessionId);

    const payload: IngestPayload = {
      session_id: primarySessionId,
      agent_id: session?.agentId ?? this.config.agentId,
      sdk: { language: 'typescript', version: SDK_VERSION },
      events: batch.map((q) => q.event),
    };

    try {
      const response = await fetch(`${this.config.backendUrl}/ingest`, {
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
          `[Syrin] Ingest failed (HTTP ${response.status} at ${this.config.backendUrl}/ingest). Re-queuing events.`
        );
        this._requeue(batch);
      } else {
        const data = (await response.json()) as IngestResponse;

        if (this.config.debug) {
          console.log(
            `[Syrin] Flushed ${batch.length} event(s). Backend ok=${data.ok}`
          );
        }

        if (data.config_updates && Object.keys(data.config_updates).length > 0) {
          // Diff against the last known snapshot — only act when values actually changed.
          // The backend always echoes the full active config on every ingest response,
          // so without this guard every flush would emit a CONFIG_APPLIED event.
          const changedKeys = Object.keys(data.config_updates).filter(
            (k) => this._lastConfigSnapshot[k] !== (data.config_updates as Record<string, unknown>)[k],
          );
          this._lastConfigSnapshot = { ...data.config_updates } as Record<string, unknown>;

          if (this.config.debug) {
            console.log('[Syrin] Received config_updates:', data.config_updates, '— changed:', changedKeys);
          }

          const sessionIds = new Set(batch.map((q) => q.sessionId));
          for (const sid of sessionIds) {
            this.sessionStore.applyConfigUpdate(sid, data.config_updates);
            if (changedKeys.length > 0) {
              fireConfigChange(sid, data.config_updates);
              // Emit CONFIG_APPLIED only when something actually changed
              const configEvent: SyrinEvent = {
                event_id: generateId('evt_'),
                event_type: 'CONFIG_APPLIED',
                timestamp: nowIso(),
                session_id: sid,
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
              try { this.emit(configEvent, sid); } catch { /* fail-open */ }
            }
          }
        }

        if (data.tool_validation_results && Object.keys(data.tool_validation_results).length > 0) {
          if (this.config.debug) {
            console.log('[Syrin] Received tool_validation_results:', data.tool_validation_results);
          }
          const sessionIds = new Set(batch.map((q) => q.sessionId));
          for (const sid of sessionIds) {
            await this.sessionStore.storeToolValidationResults(sid, data.tool_validation_results);
          }
        }

        if (data.governance) {
          const sessionIds = new Set(batch.map((q) => q.sessionId));
          const pollPromises: Promise<void>[] = [];
          for (const sid of sessionIds) {
            const polls = this._applyGovernance(sid, data.governance);
            pollPromises.push(...polls);
          }
          // Await all approval polls so events are visible before flush() resolves
          if (pollPromises.length > 0) {
            await Promise.allSettled(pollPromises);
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
        `${this.config.backendUrl}/approvals/${approvalId}`,
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

      const status = body['status'] as string | undefined;

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
        this.sessionStore.appendGovernanceAction(sessionId, action);
        console.warn(`[Syrin] Backend sent STOP action for session ${sessionId} — reason: ${action['reason'] ?? '?'}`);
      } else if (actionType === 'inject_message') {
        this.sessionStore.appendInjectedMessage(sessionId, {
          role: (action['role'] as string) ?? 'system',
          content: (action['content'] as string) ?? '',
        });
        if (this.config.debug) {
          console.log(`[Syrin] inject_message queued for session ${sessionId}`);
        }
      } else if (actionType === 'alert') {
        fireAlert(action as Record<string, unknown>);
        console.info(`[Syrin][${action['level'] ?? 'info'}] alert for session ${sessionId}: ${action['message'] ?? ''}`);
      } else if (actionType === 'checkpoint' || actionType === 'restore') {
        this.sessionStore.appendGovernanceAction(sessionId, action);
        if (this.config.debug) {
          console.log(`[Syrin] ${actionType} action queued for session ${sessionId}`);
        }
      }
    }

    return pollPromises;
  }

  private _requeue(batch: QueuedEvent[]): void {
    const available = MAX_QUEUE_SIZE - this.queue.length;
    const toRequeue = batch.slice(0, Math.max(0, available));
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
