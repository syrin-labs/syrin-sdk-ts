/** SAGE (drift detection) string constants for workflow recovery. */

/** Where SAGE drift detection runs within a workflow. */
export const SageMode = {
  BETWEEN_ALL: 'between-all',
  AT_END: 'at-end',
  CUSTOM: 'custom',
  DISABLED: 'disabled',
} as const;

export type SageModeName = typeof SageMode[keyof typeof SageMode];

/** Recovery action types returned by SAGE. */
export const RecoveryType = {
  INJECT: 'INJECT',
  ROLLBACK: 'ROLLBACK',
  OBSERVE: 'OBSERVE',
  ALERT: 'ALERT',
} as const;

export type RecoveryTypeName = typeof RecoveryType[keyof typeof RecoveryType];

/** SAGE evaluation status values in handoff responses. */
export const SageStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  CIRCUIT_OPEN: 'circuit_open',
} as const;

export type SageStatusName = typeof SageStatus[keyof typeof SageStatus];
