/**
 * Governance action type string constants.
 * Backend sends these in `governance.actions[].type`.
 */
export const GovernanceActionType = {
  STOP: 'stop',
  INJECT_MESSAGE: 'inject_message',
  ALERT: 'alert',
  CHECKPOINT: 'checkpoint',
  RESTORE: 'restore',
  CONFIG_OVERRIDE: 'config_override',
  REQUIRE_APPROVAL: 'require_approval',
} as const;

export type GovernanceActionTypeName = typeof GovernanceActionType[keyof typeof GovernanceActionType];
