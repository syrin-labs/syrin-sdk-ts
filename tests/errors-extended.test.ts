/**
 * Tests: src/errors.ts — all error class constructors and properties
 */

import { describe, it, expect } from 'vitest';
import {
  SyrinError,
  SetupError,
  AlreadyRatedError,
  SessionNotFoundError,
  ValidationError,
  GovernanceStopError,
  GovernanceApprovalRequiredError,
  GovernanceCheckpointRestoredError,
} from '@/errors';

describe('SyrinError', () => {
  it('extends Error', () => {
    const e = new SyrinError('test message');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(SyrinError);
  });

  it('has correct name', () => {
    const e = new SyrinError('test');
    expect(e.name).toBe('SyrinError');
  });

  it('stores message', () => {
    const e = new SyrinError('my error');
    expect(e.message).toBe('my error');
  });

  it('stores optional sessionId', () => {
    const e = new SyrinError('test', 'ses_123');
    expect(e.sessionId).toBe('ses_123');
  });

  it('stores optional httpStatus', () => {
    const e = new SyrinError('test', 'ses_123', 500);
    expect(e.httpStatus).toBe(500);
  });

  it('instanceof works correctly', () => {
    const e = new SyrinError('x');
    expect(e instanceof SyrinError).toBe(true);
    expect(e instanceof Error).toBe(true);
  });
});

describe('SetupError', () => {
  it('extends SyrinError', () => {
    const e = new SetupError('bad config');
    expect(e).toBeInstanceOf(SyrinError);
    expect(e).toBeInstanceOf(Error);
  });

  it('has correct name', () => {
    const e = new SetupError('bad config');
    expect(e.name).toBe('SetupError');
  });

  it('sets httpStatus to 400', () => {
    const e = new SetupError('missing api key');
    expect(e.httpStatus).toBe(400);
  });

  it('stores message', () => {
    const e = new SetupError('oops');
    expect(e.message).toBe('oops');
  });

  it('instanceof checks work', () => {
    const e = new SetupError('x');
    expect(e instanceof SetupError).toBe(true);
    expect(e instanceof SyrinError).toBe(true);
  });
});

describe('AlreadyRatedError', () => {
  it('extends SyrinError', () => {
    const e = new AlreadyRatedError('ses_abc');
    expect(e).toBeInstanceOf(SyrinError);
  });

  it('has correct name', () => {
    const e = new AlreadyRatedError();
    expect(e.name).toBe('AlreadyRatedError');
  });

  it('includes sessionId in message', () => {
    const e = new AlreadyRatedError('ses_xyz');
    expect(e.message).toContain('ses_xyz');
    expect(e.sessionId).toBe('ses_xyz');
    expect(e.httpStatus).toBe(409);
  });

  it('uses "unknown" when no sessionId provided', () => {
    const e = new AlreadyRatedError();
    expect(e.message).toContain('unknown');
  });

  it('instanceof works', () => {
    const e = new AlreadyRatedError('ses_1');
    expect(e instanceof AlreadyRatedError).toBe(true);
  });
});

describe('SessionNotFoundError', () => {
  it('extends SyrinError', () => {
    const e = new SessionNotFoundError('ses_missing');
    expect(e).toBeInstanceOf(SyrinError);
  });

  it('has correct name', () => {
    const e = new SessionNotFoundError();
    expect(e.name).toBe('SessionNotFoundError');
  });

  it('includes sessionId in message', () => {
    const e = new SessionNotFoundError('ses_gone');
    expect(e.message).toContain('ses_gone');
    expect(e.sessionId).toBe('ses_gone');
    expect(e.httpStatus).toBe(404);
  });

  it('uses "unknown" when no sessionId provided', () => {
    const e = new SessionNotFoundError();
    expect(e.message).toContain('unknown');
  });

  it('instanceof works', () => {
    const e = new SessionNotFoundError('ses_2');
    expect(e instanceof SessionNotFoundError).toBe(true);
  });
});

describe('ValidationError', () => {
  it('extends SyrinError', () => {
    const e = new ValidationError('invalid input');
    expect(e).toBeInstanceOf(SyrinError);
  });

  it('has correct name', () => {
    const e = new ValidationError('bad');
    expect(e.name).toBe('ValidationError');
  });

  it('sets httpStatus to 422', () => {
    const e = new ValidationError('bad field');
    expect(e.httpStatus).toBe(422);
  });

  it('stores message', () => {
    const e = new ValidationError('field x is required');
    expect(e.message).toBe('field x is required');
  });

  it('instanceof works', () => {
    const e = new ValidationError('x');
    expect(e instanceof ValidationError).toBe(true);
  });
});

describe('GovernanceStopError (from errors.ts)', () => {
  it('extends Error', () => {
    const e = new GovernanceStopError();
    expect(e).toBeInstanceOf(Error);
  });

  it('has correct name', () => {
    const e = new GovernanceStopError();
    expect(e.name).toBe('GovernanceStopError');
  });

  it('stores reason', () => {
    const e = new GovernanceStopError('cost limit exceeded');
    expect(e.reason).toBe('cost limit exceeded');
    expect(e.message).toBe('cost limit exceeded');
  });

  it('uses default reason when not provided', () => {
    const e = new GovernanceStopError();
    expect(e.reason).toBe('Stopped by Syrin governance');
  });

  it('stores optional incidentId', () => {
    const e = new GovernanceStopError('stopped', 'inc_abc');
    expect(e.incidentId).toBe('inc_abc');
  });

  it('stores optional driftScore', () => {
    const e = new GovernanceStopError('stopped', 'inc_1', 0.85);
    expect(e.driftScore).toBe(0.85);
  });

  it('instanceof works correctly', () => {
    const e = new GovernanceStopError('x');
    expect(e instanceof GovernanceStopError).toBe(true);
    expect(e instanceof Error).toBe(true);
  });

  it('undefined incidentId when not provided', () => {
    const e = new GovernanceStopError('reason');
    expect(e.incidentId).toBeUndefined();
    expect(e.driftScore).toBeUndefined();
  });
});

describe('GovernanceApprovalRequiredError', () => {
  it('extends Error', () => {
    const e = new GovernanceApprovalRequiredError('appr_1');
    expect(e).toBeInstanceOf(Error);
  });

  it('has correct name', () => {
    const e = new GovernanceApprovalRequiredError('appr_1');
    expect(e.name).toBe('GovernanceApprovalRequiredError');
  });

  it('stores approvalId, toolName, reason', () => {
    const e = new GovernanceApprovalRequiredError('appr_42', 'delete_user', 'Destructive action');
    expect(e.approvalId).toBe('appr_42');
    expect(e.toolName).toBe('delete_user');
    expect(e.reason).toBe('Destructive action');
  });

  it('uses defaults for toolName and reason', () => {
    const e = new GovernanceApprovalRequiredError('appr_x');
    expect(e.toolName).toBe('unknown');
    expect(e.reason).toBe('Human approval required');
  });

  it('includes approvalId in message', () => {
    const e = new GovernanceApprovalRequiredError('appr_123', 'send_email', 'needs review');
    expect(e.message).toContain('appr_123');
    expect(e.message).toContain('send_email');
  });

  it('instanceof works', () => {
    const e = new GovernanceApprovalRequiredError('appr_1');
    expect(e instanceof GovernanceApprovalRequiredError).toBe(true);
    expect(e instanceof Error).toBe(true);
  });
});

describe('GovernanceCheckpointRestoredError', () => {
  it('extends Error', () => {
    const e = new GovernanceCheckpointRestoredError('ckpt_1');
    expect(e).toBeInstanceOf(Error);
  });

  it('has correct name', () => {
    const e = new GovernanceCheckpointRestoredError('ckpt_1');
    expect(e.name).toBe('GovernanceCheckpointRestoredError');
  });

  it('stores checkpointId and reason', () => {
    const e = new GovernanceCheckpointRestoredError('ckpt_abc', 'Loop detected');
    expect(e.checkpointId).toBe('ckpt_abc');
    expect(e.reason).toBe('Loop detected');
  });

  it('uses default reason', () => {
    const e = new GovernanceCheckpointRestoredError('ckpt_1');
    expect(e.reason).toBe('Restored by Syrin governance');
  });

  it('includes checkpointId in message', () => {
    const e = new GovernanceCheckpointRestoredError('ckpt_xyz');
    expect(e.message).toContain('ckpt_xyz');
  });

  it('instanceof works', () => {
    const e = new GovernanceCheckpointRestoredError('ckpt_1');
    expect(e instanceof GovernanceCheckpointRestoredError).toBe(true);
    expect(e instanceof Error).toBe(true);
  });
});
