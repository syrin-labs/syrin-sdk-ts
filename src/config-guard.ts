/**
 * Syrin SDK — ConfigGuard
 *
 * Provides circuit-breaker (ConfigFuse), auto-revert (AutoRevert),
 * snapshot anchoring (AnchorStore), and a unified safe-apply API (ConfigGuard)
 * for config updates.
 */

import { ConfigStore } from '@/config-store';
import { TunableRegistry } from '@/tunable';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

export type OnValidationFail = 'rejectField' | 'rejectAll';
export type OnApplyError = 'rollback' | 'rollbackAndAlert' | 'freeze';
export type OnRuntimeError = 'revertAndContinue' | 'revertAndRetry' | 'alertOnly' | 'ignore';

export interface RecoveryPolicy {
  onValidationFail: OnValidationFail;
  onApplyError: OnApplyError;
  onRuntimeError: OnRuntimeError;
  /** Window (seconds) in which a runtime error triggers auto-revert. */
  crashWindowSeconds: number;
  /** Number of consecutive failures before fuse blows. */
  fuseThreshold: number;
  /** Seconds after blowing before fuse enters HALF_OPEN. */
  fuseResetSeconds: number;
  /** Maximum number of anchors to retain. */
  maxAnchors: number;
  /** After a revert, retry the original operation. */
  retryAfterRevert: boolean;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  onValidationFail: 'rejectField',
  onApplyError: 'rollbackAndAlert',
  onRuntimeError: 'revertAndContinue',
  crashWindowSeconds: 30,
  fuseThreshold: 3,
  fuseResetSeconds: 300,
  maxAnchors: 5,
  retryAfterRevert: true,
};

// ---------------------------------------------------------------------------
// SafeApplyResult
// ---------------------------------------------------------------------------

export interface SafeApplyResult {
  success: boolean;
  namespace: string;
  applied: Record<string, unknown>;
  rejected: Record<string, string>;
  rolledBack: boolean;
  error?: Error;
  anchorId?: string;
}

// ---------------------------------------------------------------------------
// ConfigAnchor
// ---------------------------------------------------------------------------

export interface ConfigAnchor {
  anchorId: string;
  createdAt: Date;
  /** 'preApply' | 'manual' | 'sessionStart' | any user-provided string */
  reason: string;
  /** Flat snapshot: "namespace.field" → value */
  values: Record<string, unknown>;
  isLastGood: boolean;
}

// ---------------------------------------------------------------------------
// AnchorStore
// ---------------------------------------------------------------------------

export class AnchorStore {
  private _anchors: ConfigAnchor[] = [];

  constructor(
    private readonly configStore: ConfigStore,
    private readonly maxAnchors: number = 5,
  ) {}

  /**
   * Take a snapshot anchor with the given reason. Returns the new anchor.
   */
  take(reason: string): ConfigAnchor {
    const anchor: ConfigAnchor = {
      anchorId: randomUUID(),
      createdAt: new Date(),
      reason,
      values: this.configStore.snapshot(),
      isLastGood: false,
    };
    this._anchors.unshift(anchor); // newest first
    this._evict();
    return anchor;
  }

  /**
   * Restore the ConfigStore to the state captured in the given anchor.
   */
  restore(anchorId: string): void {
    const anchor = this.get(anchorId);
    if (!anchor) {
      throw new Error(`Anchor not found: ${anchorId}`);
    }
    this.configStore.restoreSnapshot(anchor.values);
  }

  /**
   * Mark an anchor (or the most recent anchor if anchorId is omitted) as the
   * "last known good" configuration. Clears the flag on all other anchors.
   */
  promoteToLastGood(anchorId?: string): void {
    const target = anchorId
      ? this._anchors.find(a => a.anchorId === anchorId)
      : this._anchors[0];

    if (!target) return;

    for (const a of this._anchors) {
      a.isLastGood = a === target;
    }
  }

  /**
   * Return the anchor marked as last-good, or undefined.
   */
  lastGood(): ConfigAnchor | undefined {
    return this._anchors.find(a => a.isLastGood);
  }

  /**
   * Get a specific anchor by ID.
   */
  get(anchorId: string): ConfigAnchor | undefined {
    return this._anchors.find(a => a.anchorId === anchorId);
  }

  /**
   * List all anchors, newest first.
   */
  list(): ConfigAnchor[] {
    return [...this._anchors];
  }

  private _evict(): void {
    while (this._anchors.length > this.maxAnchors) {
      this._anchors.pop(); // remove oldest (tail)
    }
  }
}

// ---------------------------------------------------------------------------
// ConfigFuse (circuit breaker)
// ---------------------------------------------------------------------------

type FuseState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class ConfigFuse {
  private _state: FuseState = 'CLOSED';
  private _failures = 0;
  private _openedAt: number | null = null;

  constructor(
    private readonly policy: RecoveryPolicy,
    private readonly _now: () => number = () => Date.now(),
  ) {}

  /**
   * Returns true if the fuse will allow a new apply (CLOSED or HALF_OPEN).
   */
  isAccepting(): boolean {
    return this.state !== 'OPEN';
  }

  /**
   * Report a failure. Increments counter and may trip the fuse.
   */
  recordFailure(): void {
    this._failures++;
    if (this._state === 'CLOSED' && this._failures >= this.policy.fuseThreshold) {
      this._trip();
    } else if (this._state === 'HALF_OPEN') {
      // Failure in HALF_OPEN → re-open
      this._trip();
    }
  }

  /**
   * Report a success. In HALF_OPEN this closes the fuse.
   */
  recordSuccess(): void {
    if (this._state === 'HALF_OPEN' || this._state === 'OPEN') {
      this._close();
    }
    this._failures = 0;
  }

  /**
   * Manually reset the fuse to CLOSED.
   */
  manualReset(): void {
    this._close();
  }

  /**
   * Forcibly trip the fuse with an explicit reason (for testing / external triggers).
   */
  blow(reason: string): void {
    void reason; // reason is informational
    this._trip();
  }

  get state(): FuseState {
    // Evaluate OPEN → HALF_OPEN transition based on elapsed time
    if (this._state === 'OPEN' && this._openedAt !== null) {
      const elapsed = this._now() - this._openedAt;
      if (elapsed >= this.policy.fuseResetSeconds * 1000) {
        return 'HALF_OPEN';
      }
    }
    return this._state;
  }

  get consecutiveFailures(): number {
    return this._failures;
  }

  private _trip(): void {
    this._state = 'OPEN';
    this._openedAt = this._now();
  }

  private _close(): void {
    this._state = 'CLOSED';
    this._failures = 0;
    this._openedAt = null;
  }
}

// ---------------------------------------------------------------------------
// AutoRevert
// ---------------------------------------------------------------------------

export class AutoRevert {
  private _lastApplyAt: number | null = null;

  constructor(
    private readonly anchorStore: AnchorStore,
    private readonly policy: RecoveryPolicy,
    private readonly onRevert?: (error: Error, anchor: ConfigAnchor) => void,
    private readonly _now: () => number = () => Date.now(),
  ) {}

  /**
   * Record that a config apply just occurred.
   */
  recordApply(): void {
    this._lastApplyAt = this._now();
  }

  /**
   * Returns true if the given error occurred within the crash window after
   * the last apply — meaning we should revert.
   */
  shouldRevert(error: Error): boolean {
    void error;
    if (this._lastApplyAt === null) return false;
    const elapsed = this._now() - this._lastApplyAt;
    return elapsed <= this.policy.crashWindowSeconds * 1000;
  }

  /**
   * Execute a revert: restore last-good anchor and update the fuse.
   */
  doRevert(error: Error, fuse: ConfigFuse): void {
    const anchor = this.anchorStore.lastGood();
    if (anchor) {
      this.anchorStore.restore(anchor.anchorId);
      fuse.recordFailure();
      if (this.onRevert) {
        this.onRevert(error, anchor);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ConfigGuard
// ---------------------------------------------------------------------------

export class ConfigGuard {
  readonly fuse: ConfigFuse;
  readonly anchorStore: AnchorStore;
  readonly autoRevert: AutoRevert;

  constructor(
    private readonly configStore: ConfigStore,
    private readonly tunableRegistry: TunableRegistry,
    policy: Partial<RecoveryPolicy> = {},
    private readonly healthCheck?: () => void | Promise<void>,
  ) {
    const fullPolicy: RecoveryPolicy = { ...DEFAULT_RECOVERY_POLICY, ...policy };
    this.fuse = new ConfigFuse(fullPolicy);
    this.anchorStore = new AnchorStore(configStore, fullPolicy.maxAnchors);
    this.autoRevert = new AutoRevert(this.anchorStore, fullPolicy);
    this._policy = fullPolicy;
  }

  private readonly _policy: RecoveryPolicy;

  /**
   * Safely apply field updates to a single namespace.
   * - Takes an anchor before applying.
   * - Validates each field against the ConfigStore schema.
   * - On partial failure, behaviour depends on policy.onValidationFail.
   * - Runs healthCheck if provided; rolls back on failure.
   * - Notifies ConfigFuse of success or failure.
   */
  safeApply(namespace: string, updates: Record<string, unknown>): SafeApplyResult {
    // Check fuse first
    if (!this.fuse.isAccepting()) {
      return {
        success: false,
        namespace,
        applied: {},
        rejected: {},
        rolledBack: false,
        error: new Error(`ConfigFuse is ${this.fuse.state} — apply rejected`),
      };
    }

    // Take anchor before mutating state
    const anchor = this.anchorStore.take('preApply');
    const result: SafeApplyResult = {
      success: false,
      namespace,
      applied: {},
      rejected: {},
      rolledBack: false,
      anchorId: anchor.anchorId,
    };

    // Validate all fields
    const validFields: Record<string, unknown> = {};
    const rejectedFields: Record<string, string> = {};

    for (const [field, value] of Object.entries(updates)) {
      const err = this.configStore.validateValue(namespace, field, value);
      if (err) {
        rejectedFields[field] = err;
      } else {
        validFields[field] = value;
      }
    }

    // Handle validation failures
    if (Object.keys(rejectedFields).length > 0) {
      if (this._policy.onValidationFail === 'rejectAll') {
        result.rejected = rejectedFields;
        result.rolledBack = true;
        this.fuse.recordFailure();
        return result;
      }
      // rejectField: continue with valid fields only
      result.rejected = rejectedFields;
    }

    // Apply valid fields
    try {
      for (const [field, value] of Object.entries(validFields)) {
        this.configStore.set(namespace, field, value);
        result.applied[field] = value;
      }

      // Also apply to tunable registry if registered
      for (const [field, value] of Object.entries(validFields)) {
        this.tunableRegistry.applyUpdate(namespace, field, value);
      }

      // Run health check if provided
      if (this.healthCheck) {
        const healthResult = this.healthCheck();
        if (healthResult instanceof Promise) {
          // We handle the sync path; treat async as best-effort
          healthResult.catch(() => {
            // Can't rollback here synchronously; ignored for async
          });
        }
      }

      this.autoRevert.recordApply();

      result.success = Object.keys(result.rejected).length === 0;
      if (result.success) {
        this.fuse.recordSuccess();
      } else {
        this.fuse.recordFailure();
      }
    } catch (err) {
      // Error during apply → rollback
      const error = err instanceof Error ? err : new Error(String(err));
      result.error = error;
      result.rolledBack = true;
      result.success = false;
      // Restore snapshot
      this.anchorStore.restore(anchor.anchorId);
      this.fuse.recordFailure();
    }

    return result;
  }

  /**
   * Apply a batch of "namespace.field" → value updates, grouped by namespace.
   */
  safeApplyBatch(updates: Record<string, unknown>): SafeApplyResult[] {
    // Group by namespace
    const groups: Record<string, Record<string, unknown>> = {};

    for (const [path, value] of Object.entries(updates)) {
      const dotIdx = path.indexOf('.');
      if (dotIdx === -1) continue;
      const namespace = path.substring(0, dotIdx);
      const field = path.substring(dotIdx + 1);
      if (!groups[namespace]) groups[namespace] = {};
      groups[namespace][field] = value;
    }

    const results: SafeApplyResult[] = [];
    for (const [namespace, fields] of Object.entries(groups)) {
      results.push(this.safeApply(namespace, fields));
    }
    return results;
  }

  /**
   * Take a manual anchor with the given reason.
   */
  takeAnchor(reason = 'manual'): ConfigAnchor {
    return this.anchorStore.take(reason);
  }

  /**
   * Restore a specific anchor by ID.
   */
  restoreAnchor(anchorId: string): void {
    this.anchorStore.restore(anchorId);
  }

  /**
   * Restore the last-good anchor (if one exists).
   */
  restoreLastGood(): void {
    const lg = this.anchorStore.lastGood();
    if (lg) {
      this.anchorStore.restore(lg.anchorId);
    }
  }

  /**
   * List all current anchors (newest first).
   */
  listAnchors(): ConfigAnchor[] {
    return this.anchorStore.list();
  }

  /**
   * Manually reset the circuit breaker fuse.
   */
  resetFuse(): void {
    this.fuse.manualReset();
  }

  /**
   * Get the current fuse state.
   */
  fuseState(): { state: string; consecutiveFailures: number } {
    return {
      state: this.fuse.state,
      consecutiveFailures: this.fuse.consecutiveFailures,
    };
  }

  /**
   * Promote the most recent anchor to last-good status.
   */
  promoteLastGood(): void {
    const list = this.anchorStore.list();
    if (list.length > 0) {
      this.anchorStore.promoteToLastGood(list[0].anchorId);
    }
  }
}
