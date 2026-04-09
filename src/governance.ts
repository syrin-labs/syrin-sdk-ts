/**
 * Syrin SDK — Governance types and action executor.
 *
 * The backend sends governance directives in the /ingest response:
 *
 *   {
 *     "ok": true,
 *     "governance": {
 *       "actions": [
 *         { "type": "stop",           "reason": "Cost limit exceeded", "incident_id": "..." },
 *         { "type": "inject_message", "role": "system", "content": "Focus on X" },
 *         { "type": "alert",          "level": "warning", "message": "High latency" },
 *         { "type": "checkpoint",     "label": "pre-recovery" },
 *         { "type": "restore",        "checkpoint_id": "ckpt_abc" }
 *       ],
 *       "loop_detected": false,
 *       "drift_score": 0.12,
 *       "incident_id": null
 *     }
 *   }
 *
 * Actions are queued on the session and executed before the next intercepted call.
 */

/** Thrown when the backend sends a `stop` governance action. */
export class GovernanceStopError extends Error {
  readonly reason: string;
  readonly incidentId: string | undefined;

  constructor(reason = 'Stopped by Syrin governance', incidentId?: string) {
    super(reason);
    this.name = 'GovernanceStopError';
    this.reason = reason;
    this.incidentId = incidentId;
    // Maintain proper prototype chain
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface GovernanceAction {
  type: 'stop' | 'inject_message' | 'alert' | 'checkpoint' | 'restore' | string;
  [key: string]: unknown;
}

export interface GovernanceData {
  actions?: GovernanceAction[];
  loop_detected?: boolean;
  drift_score?: number | null;
  incident_id?: string | null;
}

export class GovernanceResponse {
  readonly actions: GovernanceAction[];
  readonly loopDetected: boolean;
  readonly driftScore: number | null;
  readonly incidentId: string | null;

  constructor(data: GovernanceData) {
    this.actions = data.actions ?? [];
    this.loopDetected = data.loop_detected ?? false;
    this.driftScore = data.drift_score ?? null;
    this.incidentId = data.incident_id ?? null;
  }

  get hasStop(): boolean {
    return this.actions.some((a) => a.type === 'stop');
  }

  get hasInject(): boolean {
    return this.actions.some((a) => a.type === 'inject_message');
  }
}

// Alert level constants
export const ALERT_INFO = 'info';
export const ALERT_WARNING = 'warning';
export const ALERT_CRITICAL = 'critical';
