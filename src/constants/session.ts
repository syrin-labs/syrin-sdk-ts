/** Session type string constants. */

/** Valid values for the `session_type` field in ingest payloads. */
export const SessionTypeValue = {
  PRODUCTION: 'production',
  CHAT_TEST: 'chat_test',
  WORKFLOW_TEST: 'workflow_test',
  SIMULATION: 'simulation',
} as const;
