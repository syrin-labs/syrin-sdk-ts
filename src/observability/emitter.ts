/**
 * Syrin SDK — Event emitter and HTTP batcher
 *
 * Flush strategy:
 *   1. Immediate — when queue reaches batchSize
 *   2. Idle timeout — scheduled lazily per emit(); fires idleFlushMs after
 *      the first queued event when a full batch hasn't triggered first.
 */

import type { SyrinConfig, SyrinEvent, IngestPayload, IngestResponse, ContextInjection, GovernanceData, ExperimentAssignment } from '@/types.js';
import type { SessionStore } from '@/core/session.js';
import { SDK_VERSION } from '@/config/config.js';
import { GovernanceResponse } from '@/core/governance.js';
import { GovernanceCheckpointRestoredError } from '@/errors.js';
import { fireConfigChange, fireAlert } from '@/observability/hooks.js';
import { generateId, nowIso, stableHash } from '@/utils/helpers.js';
import { parseBilling, logBillingOnIngest } from '@/billing.js';

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
  /** Unix ms until which the emitter must not flush (rate-limit backoff). */
  private retryAfterUntil = 0;
  /** Registered callbacks for context injections. */
  private injectionCallbacks: Set<(injection: ContextInjection) => void> = new Set();

  constructor(config: SyrinConfig, sessionStore: SessionStore) {
    this.config = config;
    this.sessionStore = sessionStore;
  }

  /**
   * Register a callback that fires when the backend returns context injections.
   * Returns an unsubscribe function.
   */
  onContextInjection(callback: (injection: ContextInjection) => void): () => void {
    this.injectionCallbacks.add(callback);
    return () => { this.injectionCallbacks.delete(callback); };
  }

  start(): void {
    // No persistent interval — idle flush is scheduled lazily per emit().
    if (!this.config.offline) {
      this._checkHealth().catch(() => { /* already warned inside */ });
    }
  }

  emit(event: SyrinEvent, sessionId: string): void {
    const queued: QueuedEvent = { event, sessionId };

    // Enforce max queue size: drop the 2 oldest events (one becomes the sentinel slot,
    // one makes room for the incoming event) so the queue never exceeds MAX_QUEUE_SIZE.
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      const [dropped] = this.queue.splice(0, 2); // remove 2; sentinel + new event take their slots
      console.warn(
        `[Syrin SDK] Event queue full (${MAX_QUEUE_SIZE}): dropped event ` +
        `type=${dropped.event.event_type} id=${String(dropped.event.event_id)}. ` +
        'Increase SYRIN_MAX_QUEUE_SIZE or reduce event rate.'
      );
      // Inject a sentinel so the backend receives an auditable record of the loss
      const overflowEvent: SyrinEvent = {
        event_id: generateId('evt_'),
        event_type: 'QUEUE_OVERFLOW',
        timestamp: nowIso(),
        session_id: dropped.sessionId,
        dropped_event_id: dropped.event.event_id,
        dropped_event_type: dropped.event.event_type,
        queue_size: MAX_QUEUE_SIZE,
        model: '',
        provider: '',
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        stream: false,
        config_applied: false,
        duration_ms: 0,
      } as unknown as SyrinEvent;
      this.queue.push({ event: overflowEvent, sessionId: dropped.sessionId });
    }

    this.queue.push(queued);

    // Auto-flush immediately when batch size reached; otherwise schedule idle flush
    if (this.queue.length >= this.config.batchSize) {
      this._cancelIdleTimer();
      this.flush().catch((err) => {
        console.warn('[Syrin SDK] Batch-full flush error:', err);
      });
    } else {
      this._scheduleIdleFlush();
    }
  }

  async flush(): Promise<void> {
    // Cancel any pending idle timer — we're flushing now.
    this._cancelIdleTimer();

    if (this.config.offline) {
      if (this.config.debug) {
        console.log('[Syrin SDK] Offline mode — skipping flush.');
      }
      return;
    }

    // Respect Retry-After backoff from a prior 429 response
    if (this.retryAfterUntil > 0 && Date.now() < this.retryAfterUntil) {
      if (this.config.debug) {
        const waitSec = ((this.retryAfterUntil - Date.now()) / 1000).toFixed(1);
        console.log(`[Syrin SDK] Rate-limited — skipping flush for ${waitSec}s more.`);
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
        if (this.config.debug) console.warn('[Syrin SDK] Idle flush error:', err);
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
          `[Syrin SDK] Backend health check failed (HTTP ${response.status}). ` +
          'Check your backendUrl setting.'
        );
      } else if (this.config.debug) {
        console.log('[Syrin SDK] Backend health check OK.');
      }
    } catch {
      console.warn(
        `[Syrin SDK] Syrin backend unreachable at ${this.config.backendUrl}. ` +
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
      ...(session?.sessionType ? { session_type: session.sessionType } : {}),
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
        if (response.status === 401 || response.status === 403) {
          // Auth errors won't resolve themselves — drop the batch and warn loudly.
          console.warn(
            `[Syrin SDK] ⚠ Backend returned HTTP ${response.status} — check your API key and backend URL. ` +
            `${batch.length} event(s) dropped. Correct the key and restart the process.`
          );
          // No requeue
        } else if (response.status === 429) {
          // Rate-limited — honour Retry-After if present, else back off 60 s
          const retryAfterHeader = response.headers.get('Retry-After');
          const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60;
          const backoffMs = (isNaN(retryAfterSec) ? 60 : retryAfterSec) * 1000;
          this.retryAfterUntil = Date.now() + backoffMs;
          console.warn(
            `[Syrin SDK] Rate limit exceeded (HTTP 429). ` +
            `Pausing ingest for ${(backoffMs / 1000).toFixed(0)}s. Events re-queued.`
          );
          this._requeue(batch);
        } else if (response.status === 402) {
          // Billing limit — drop and warn; retrying won't help until the plan is upgraded.
          const body = await response.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
          const code = String(body['code'] ?? 'PLAN_LIMIT_EXCEEDED');
          console.warn(
            `[Syrin SDK] ⚠ Billing limit reached (HTTP 402, code=${code}). ` +
            `${batch.length} event(s) dropped. Upgrade at https://app.syrin.ai/billing`
          );
          // No requeue
        } else {
          // 5xx or unexpected — requeue for retry
          console.warn(
            `[Syrin SDK] Ingest failed (HTTP ${response.status}). Re-queuing ${batch.length} event(s).`
          );
          this._requeue(batch);
        }
      } else {
        const data = (await response.json()) as IngestResponse;

        if (this.config.debug) {
          console.log(
            `[Syrin SDK] Flushed ${batch.length} event(s). Backend ok=${data.ok}`
          );
        }

        if (data.config_updates && Object.keys(data.config_updates).length > 0) {
          if (this.config.debug) {
            console.log('[Syrin SDK] Received config_updates:', data.config_updates);
          }
          const sessionIds = new Set(batch.map((q) => q.sessionId));
          for (const sid of sessionIds) {
            this.sessionStore.applyConfigUpdate(sid, data.config_updates);
            fireConfigChange(sid, data.config_updates);
          }
        }

        if (data.tool_validation_results && Object.keys(data.tool_validation_results).length > 0) {
          if (this.config.debug) {
            console.log('[Syrin SDK] Received tool_validation_results:', data.tool_validation_results);
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

        if (data.experiments && data.experiments.length > 0) {
          const sessionIds = new Set(batch.map((q) => q.sessionId));
          for (const sid of sessionIds) {
            this._applyExperiments(sid, data.experiments);
          }
        }

        // Accept both camelCase (SDK-generated) and snake_case (backend wire format)
        const dataLoose = data as unknown as Record<string, unknown>;
        const incomingInjections = dataLoose['pendingInjections'] as typeof data.pendingInjections
          ?? dataLoose['pending_injections'] as typeof data.pendingInjections;
        if (incomingInjections && incomingInjections.length > 0) {
          const sessionIds = new Set(batch.map((q) => q.sessionId));
          for (const sid of sessionIds) {
            this.sessionStore.appendInjections(sid, incomingInjections);
          }
          // Fire registered callbacks for each injection
          for (const injection of incomingInjections) {
            for (const cb of this.injectionCallbacks) {
              try { cb(injection); } catch { /* fail-open */ }
            }
          }
          // Emit a CONTEXT_INJECTION telemetry event for each injection received
          const primarySid = batch[0].sessionId;
          const session = this.sessionStore.getSession(primarySid);
          for (const injection of incomingInjections) {
            const injectionSource = _mapInjectionSource(injection);
            const injectionType = _mapInjectionType(injection);
            const contentHash = stableHash(injection.content);
            const injEvent: SyrinEvent = {
              event_id: generateId('evt_'),
              event_type: 'CONTEXT_INJECTION',
              timestamp: nowIso(),
              session_id: primarySid,
              agent_id: session?.agentId ?? this.config.agentId,
              injection_source: injectionSource,
              injection_type: injectionType,
              content_hash: contentHash,
              ...(this.config.captureContent ? { content: injection.content } : {}),
            } as unknown as SyrinEvent;
            this.emit(injEvent, primarySid);
          }
          if (this.config.debug) {
            console.log(`[Syrin SDK] Received ${incomingInjections.length} context injection(s).`);
          }
        }

        const billingData = (data as unknown as Record<string, unknown>)['billing'];
        if (billingData) {
          const billing = parseBilling(billingData);
          if (billing) logBillingOnIngest(billing);
        }
      }
    } catch (err) {
      if (this.config.debug) {
        console.warn('[Syrin SDK] Ingest network error (detail):', err);
      } else {
        console.warn('[Syrin SDK] Failed to reach Syrin backend. Events re-queued.');
      }
      this._requeue(batch);
    }
  }

  private _applyGovernance(sessionId: string, governanceData: GovernanceData): void {
    const gov = new GovernanceResponse(governanceData);

    // Persist governance signals to session state so diagnose() can surface them
    const session = this.sessionStore.getSession(sessionId);
    if (session) {
      if (gov.loopDetected) session.lastLoopDetected = true;
      if (gov.driftScore != null) session.lastDriftScore = gov.driftScore;
      if (gov.incidentId != null) session.lastIncidentId = gov.incidentId;
    }

    if (gov.loopDetected) {
      console.warn(`[Syrin SDK] Backend detected loop for session ${sessionId} (drift_score=${gov.driftScore}, incident=${gov.incidentId})`);
    }

    for (const action of gov.actions) {
      const actionType = action.type;
      if (actionType === 'stop') {
        this.sessionStore.appendGovernanceAction(sessionId, action);
        console.warn(`[Syrin SDK] Backend sent STOP action for session ${sessionId} — reason: ${String(action['reason'] ?? '?')}`);
      } else if (actionType === 'inject_message') {
        this.sessionStore.appendInjectedMessage(sessionId, {
          role: (action['role'] as string) ?? 'system',
          content: (action['content'] as string) ?? '',
        });
        if (this.config.debug) {
          console.log(`[Syrin SDK] inject_message queued for session ${sessionId}`);
        }
      } else if (actionType === 'alert') {
        fireAlert(action as Record<string, unknown>);
        console.info(`[Syrin SDK][${String(action['level'] ?? 'info')}] alert for session ${sessionId}: ${String(action['message'] ?? '')}`);
      } else if (actionType === 'checkpoint') {
        this.sessionStore.appendGovernanceAction(sessionId, action);
        if (this.config.debug) {
          console.log(`[Syrin SDK] checkpoint action queued for session ${sessionId}`);
        }
      } else if (actionType === 'restore') {
        const checkpointId = (action['checkpoint_id'] ?? action['checkpointId']) as string | undefined;
        const reason = (action['reason'] as string | undefined) ?? 'Restored by Syrin governance';
        console.info(`[Syrin SDK] restore action received for session ${sessionId} (checkpoint=${checkpointId})`);
        throw new GovernanceCheckpointRestoredError(checkpointId ?? 'unknown', reason);
      } else if (actionType === 'config_override') {
        // Backend explicitly overrides one or more config keys.
        const fieldPath = (action['field_path'] ?? action['key']) as string | undefined;
        const value = action['value'];
        if (fieldPath != null && value !== undefined) {
          const override = { [fieldPath]: value };
          this.sessionStore.applyConfigUpdate(sessionId, override);
          if (this.config.debug) {
            console.log(`[Syrin SDK] config_override applied for session ${sessionId}: ${fieldPath}=${JSON.stringify(value)}`);
          }
          // Inject correction_hint as a system message if present
          const hint = action['correction_hint'] as string | undefined;
          if (hint) {
            this.sessionStore.appendInjectedMessage(sessionId, {
              role: 'system',
              content: `[Syrin Governance] ${hint}`,
            });
          }
        } else if (this.config.debug) {
          console.warn(`[Syrin SDK] config_override missing field_path/key or value — ignoring`, action);
        }
      } else if (actionType === 'require_approval') {
        const approvalId = action['approval_id'] as string | undefined;
        const toolName = (action['tool_name'] as string | undefined) ?? 'unknown';
        const reason = (action['reason'] as string | undefined) ?? 'Human approval required';

        if (!approvalId) {
          if (this.config.debug) {
            console.warn('[Syrin SDK] require_approval action missing approval_id — ignoring');
          }
          return;
        }

        // Inject a system message so the agent naturally informs the user
        this.sessionStore.appendInjectedMessage(sessionId, {
          role: 'system',
          content:
            `[Syrin Governance] The action '${toolName}' requires human approval ` +
            `(reason: ${reason}). Approval ID: ${approvalId}. ` +
            'Inform the user this action is pending approval. Do NOT retry the tool call.',
        });
        console.warn(`[Syrin SDK] require_approval for session ${sessionId} — tool=${toolName} approval_id=${approvalId}`);
      }
    }
  }

  private _applyExperiments(sessionId: string, assignments: ExperimentAssignment[]): void {
    for (const assignment of assignments) {
      if (!assignment.overrides || Object.keys(assignment.overrides).length === 0) continue;
      if (this.config.debug) {
        console.log(`[Syrin SDK] Experiment variant assigned: ${assignment.variantName} (session=${sessionId})`);
      }
      this.sessionStore.mergeExperimentOverrides(sessionId, assignment.overrides);

      // Emit EXPERIMENT_ASSIGNED telemetry event so backend can track variant distribution.
      // Use emit() so overflow sentinel logic applies; experiment events never trigger further
      // experiment handling because they carry no `experiments` field in the response.
      const session = this.sessionStore.getSession(sessionId);
      const expEvent = {
        event_id: generateId('evt_'),
        event_type: 'EXPERIMENT_ASSIGNED' as const,
        timestamp: nowIso(),
        session_id: sessionId,
        agent_id: session?.agentId ?? this.config.agentId,
        experiment_id: assignment.experimentId,
        variant_id: assignment.variantId,
        variant_name: assignment.variantName,
        overrides: assignment.overrides,
      };
      this.emit(expEvent as unknown as SyrinEvent, sessionId);
    }
  }

  private _requeue(batch: QueuedEvent[]): void {
    // Mirror Python: drop events that have failed 3+ times to prevent indefinite re-queuing
    // when the backend is persistently unavailable.
    const eligible: QueuedEvent[] = [];
    for (const item of batch) {
      const retries = ((item.event as unknown as Record<string, unknown>)['_syrin_retry'] as number | undefined) ?? 0;
      if (retries >= 3) {
        console.warn(
          `[Syrin SDK] Dropping event type=${item.event.event_type} id=${String(item.event.event_id)} ` +
          `after ${retries} failed delivery attempt(s).`
        );
        continue;
      }
      (item.event as unknown as Record<string, unknown>)['_syrin_retry'] = retries + 1;
      eligible.push(item);
    }
    const available = MAX_QUEUE_SIZE - this.queue.length;
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

// ---------------------------------------------------------------------------
// CONTEXT_INJECTION helpers
// ---------------------------------------------------------------------------

/** Map ContextInjection.injection_type to the telemetry event's injection_source field. */
function _mapInjectionSource(
  injection: ContextInjection
): 'config' | 'governance' | 'operator' | 'experiment' {
  const t = injection.injection_type;
  if (t === 'governance_correction') return 'governance';
  if (t === 'manual') return 'operator';
  if (t === 'world_state' || t === 'constraint' || t === 'fact') return 'config';
  if (t === 'custom') return 'operator';
  return 'operator';
}

/** Map ContextInjection.injection_type to the telemetry event's injection_type field. */
function _mapInjectionType(
  injection: ContextInjection
): 'system_prompt' | 'message' | 'context' {
  const t = injection.injection_type;
  if (t === 'governance_correction') return 'message';
  if (t === 'manual') return 'message';
  if (t === 'world_state' || t === 'constraint' || t === 'fact') return 'context';
  if (t === 'custom') return 'message';
  return 'message';
}
