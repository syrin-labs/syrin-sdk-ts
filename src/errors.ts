/**
 * Syrin SDK — Custom error classes for typed error handling.
 */

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

export class AlreadyRatedError extends SyrinError {
  constructor(sessionId?: string) {
    super(`Session ${sessionId ?? 'unknown'} has already been rated`, sessionId, 409);
    this.name = 'AlreadyRatedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SessionNotFoundError extends SyrinError {
  constructor(sessionId?: string) {
    super(`Session ${sessionId ?? 'unknown'} not found`, sessionId, 404);
    this.name = 'SessionNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends SyrinError {
  constructor(message: string) {
    super(message, undefined, 422);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
