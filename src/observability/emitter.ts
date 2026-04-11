/**
 * Syrin SDK — Event emitter and HTTP batcher
 *
 * Flush strategy:
 *   1. Immediate — when queue reaches batchSize
 *   2. Idle timeout — scheduled lazily per emit(); fires idleFlushMs after
 *      the first queued event when a full batch hasn't triggered first.
 */

import type { SyrinConfig, SyrinEvent, IngestPayload, IngestResponse } from '@/types.js';
import type { SessionStore } from '@/core/session.js';
import { SDK_VERSION } from '@/config/config.js';
import { GovernanceResponse } from '@/core/governance.js';
import { fireConfigChange, fireAlert } from '@/observability/hooks.js';

const MAX_QUEUE_SIZE = 1000;

interface QueuedEvent {
  event: SyrinEvent;
  sessionId: string;
}

export class Emitter {
  private config: SyrinConfig;
  private sessionStore: SessionStore;
  private queue: QueuedEvent[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private flushPromise: Promise<void> | null = null;

  constructor(config: SyrinConfig, sessionStore: SessionStore) {
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
    const primarySessionId = batch[0]!.sessionId;
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
        console.warn(
          `[Syrin] Ingest failed (HTTP ${response.status}). Re-queuing events.`
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
          if (this.config.debug) {
            console.log('[Syrin] Received config_updates:', data.config_updates);
          }
          const sessionIds = new Set(batch.map((q) => q.sessionId));
          for (const sid of sessionIds) {
            this.sessionStore.applyConfigUpdate(sid, data.config_updates);
            fireConfigChange(sid, data.config_updates);
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
          for (const sid of sessionIds) {
            this._applyGovernance(sid, data.governance);
          }
        }
      }
    } catch (err) {
      if (this.config.debug) {
        console.warn('[Syrin] Ingest network error (detail):', err);
      } else {
        console.warn('[Syrin] Failed to reach Syrin backend. Events re-queued.');
      }
      this._requeue(batch);
    }
  }

  private _applyGovernance(sessionId: string, governanceData: import('../types.js').GovernanceData): void {
    const gov = new GovernanceResponse(governanceData);

    if (gov.loopDetected && this.config.debug) {
      console.warn(`[Syrin] Backend detected loop for session ${sessionId} (drift_score=${gov.driftScore}, incident=${gov.incidentId})`);
    }

    for (const action of gov.actions) {
      const actionType = action.type;
      if (actionType === 'stop') {
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
