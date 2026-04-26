/**
 * Syrin SDK — complete error class hierarchy.
 *
 * Error taxonomy:
 *   SyrinError                        — base for all SDK errors
 *     SetupError                      — init/config failures (surfaced, non-silent)
 *     AlreadyRatedError               — HTTP 409 from feedback endpoint
 *     SessionNotFoundError            — HTTP 404 for unknown session_id
 *     ValidationError                 — local validation failure (bad input)
 *     GovernanceStopError             — backend sent a STOP action
 *     GovernanceApprovalRequiredError — backend requires HITL approval before proceeding
 *     GovernanceCheckpointRestoredError — backend restored from a checkpoint
 */

/** Base error class for all Syrin SDK exceptions. */
export class SyrinError extends Error {
  constructor(
    message: string,
    public readonly sessionId?: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'SyrinError';
    // Maintain proper prototype chain in transpiled ES5
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Raised when SDK initialisation or configuration fails.
 *
 * Unlike most SDK errors which are fail-open, setup errors are surfaced
 * immediately during `init()` so misconfigurations are visible.
 *
 * Examples:
 * - Missing API key
 * - Insecure backend URL without opt-in
 * - Invalid configuration options
 */
export class SetupError extends SyrinError {
  constructor(message: string) {
    super(message, undefined, 400);
    this.name = 'SetupError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Raised when a session has already been rated (HTTP 409).
 *
 * @example
 * ```ts
 * try {
 *   await sdk.rateSession(sessionId, { rating: 'positive' });
 * } catch (e) {
 *   if (e instanceof AlreadyRatedError) {
 *     console.log('Session was already rated.');
 *   }
 * }
 * ```
 */
export class AlreadyRatedError extends SyrinError {
  constructor(sessionId?: string) {
    super(`Session ${sessionId ?? 'unknown'} has already been rated`, sessionId, 409);
    this.name = 'AlreadyRatedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Raised when the `session_id` does not exist on the backend (HTTP 404).
 *
 * @example
 * ```ts
 * try {
 *   await sdk.rateSession(sessionId, { rating: 'positive' });
 * } catch (e) {
 *   if (e instanceof SessionNotFoundError) {
 *     console.log('Session may have expired.');
 *   }
 * }
 * ```
 */
export class SessionNotFoundError extends SyrinError {
  constructor(sessionId?: string) {
    super(`Session ${sessionId ?? 'unknown'} not found`, sessionId, 404);
    this.name = 'SessionNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Raised when local input validation fails before making any HTTP call.
 *
 * @example
 * ```ts
 * try {
 *   await sdk.rateSession('', { rating: 'positive' });
 * } catch (e) {
 *   if (e instanceof ValidationError) {
 *     console.log(`Bad input: ${e.message}`);
 *   }
 * }
 * ```
 */
export class ValidationError extends SyrinError {
  constructor(message: string) {
    super(message, undefined, 422);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the Syrin backend sends a `stop` governance action.
 *
 * Agents should catch this for graceful cleanup (save state, log, notify user).
 *
 * @example
 * ```ts
 * try {
 *   const response = await openai.chat.completions.create({ ... });
 * } catch (e) {
 *   if (e instanceof GovernanceStopError) {
 *     logger.warn(`Agent stopped: ${e.reason} (incident=${e.incidentId})`);
 *     process.exit(0);
 *   }
 *   throw e;
 * }
 * ```
 */
export class GovernanceStopError extends Error {
  /** Human-readable explanation from the backend. */
  readonly reason: string;
  /** Incident reference ID for correlation with the Syrin dashboard. */
  readonly incidentId: string | undefined;
  /** Drift score (0.0–1.0) at the time the stop action fired, if available. */
  readonly driftScore: number | undefined;

  constructor(
    reason = 'Stopped by Syrin governance',
    incidentId?: string,
    driftScore?: number,
  ) {
    super(reason);
    this.name = 'GovernanceStopError';
    this.reason = reason;
    this.incidentId = incidentId;
    this.driftScore = driftScore;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the backend requires human-in-the-loop approval before proceeding.
 *
 * The agent should pause, notify the operator, and retry after approval or
 * handle rejection gracefully.
 *
 * @example
 * ```ts
 * try {
 *   const response = await openai.chat.completions.create({ ... });
 * } catch (e) {
 *   if (e instanceof GovernanceApprovalRequiredError) {
 *     await notifyOperator(e.toolName, e.reason, e.approvalId);
 *   }
 * }
 * ```
 */
export class GovernanceApprovalRequiredError extends Error {
  /** Unique identifier for this approval request. */
  readonly approvalId: string;
  /** The tool or action awaiting approval. */
  readonly toolName: string;
  /** Why approval is required. */
  readonly reason: string;

  constructor(approvalId: string, toolName = 'unknown', reason = 'Human approval required') {
    super(`Approval required for '${toolName}' (id=${approvalId}): ${reason}`);
    this.name = 'GovernanceApprovalRequiredError';
    this.approvalId = approvalId;
    this.toolName = toolName;
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the backend restores a checkpoint (rolls back conversation state).
 *
 * The agent should restart processing from the restored conversation state.
 *
 * @example
 * ```ts
 * try {
 *   const response = await openai.chat.completions.create({ ... });
 * } catch (e) {
 *   if (e instanceof GovernanceCheckpointRestoredError) {
 *     logger.info(`Conversation restored from checkpoint ${e.checkpointId}`);
 *     // Reload messages from the checkpoint and continue
 *   }
 * }
 * ```
 */
export class GovernanceCheckpointRestoredError extends Error {
  /** ID of the checkpoint that was restored. */
  readonly checkpointId: string;
  /** Why the restore was triggered. */
  readonly reason: string;

  constructor(checkpointId: string, reason = 'Restored by Syrin governance') {
    super(`Checkpoint '${checkpointId}' restored: ${reason}`);
    this.name = 'GovernanceCheckpointRestoredError';
    this.checkpointId = checkpointId;
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
