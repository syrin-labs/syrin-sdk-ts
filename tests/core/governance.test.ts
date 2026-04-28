/**
 * Tests: src/core/governance.ts — GovernanceStopError, GovernanceResponse
 */

import { describe, it, expect } from 'vitest';
import {
  GovernanceStopError,
  GovernanceResponse,
  ALERT_INFO,
  ALERT_WARNING,
  ALERT_CRITICAL,
} from '@/core/governance';

describe('GovernanceStopError (governance module)', () => {
  it('extends Error', () => {
    const e = new GovernanceStopError();
    expect(e).toBeInstanceOf(Error);
  });

  it('has name GovernanceStopError', () => {
    const e = new GovernanceStopError();
    expect(e.name).toBe('GovernanceStopError');
  });

  it('uses default reason', () => {
    const e = new GovernanceStopError();
    expect(e.reason).toBe('Stopped by Syrin governance');
    expect(e.message).toBe('Stopped by Syrin governance');
  });

  it('stores custom reason', () => {
    const e = new GovernanceStopError('Budget exceeded');
    expect(e.reason).toBe('Budget exceeded');
    expect(e.message).toBe('Budget exceeded');
  });

  it('stores optional incidentId', () => {
    const e = new GovernanceStopError('Loop', 'inc_001');
    expect(e.incidentId).toBe('inc_001');
  });

  it('incidentId is undefined when not provided', () => {
    const e = new GovernanceStopError('Loop');
    expect(e.incidentId).toBeUndefined();
  });

  it('instanceof check works (prototype chain preserved)', () => {
    const e = new GovernanceStopError('test');
    expect(e instanceof GovernanceStopError).toBe(true);
    expect(e instanceof Error).toBe(true);
  });

  it('can be caught as Error', () => {
    let caught: Error | null = null;
    try {
      throw new GovernanceStopError('stop now');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toBe('stop now');
    expect(caught instanceof GovernanceStopError).toBe(true);
  });
});

describe('GovernanceResponse', () => {
  it('defaults to empty actions, loopDetected=false, driftScore=null, incidentId=null', () => {
    const gov = new GovernanceResponse({});
    expect(gov.actions).toEqual([]);
    expect(gov.loopDetected).toBe(false);
    expect(gov.driftScore).toBeNull();
    expect(gov.incidentId).toBeNull();
  });

  it('stores actions from data', () => {
    const gov = new GovernanceResponse({
      actions: [{ type: 'stop', reason: 'test' }],
    });
    expect(gov.actions).toHaveLength(1);
    expect(gov.actions[0].type).toBe('stop');
  });

  it('stores loopDetected from data', () => {
    const gov = new GovernanceResponse({ loop_detected: true });
    expect(gov.loopDetected).toBe(true);
  });

  it('stores driftScore from data', () => {
    const gov = new GovernanceResponse({ drift_score: 0.75 });
    expect(gov.driftScore).toBe(0.75);
  });

  it('stores incidentId from data', () => {
    const gov = new GovernanceResponse({ incident_id: 'inc_xyz' });
    expect(gov.incidentId).toBe('inc_xyz');
  });

  it('hasStop returns true when stop action present', () => {
    const gov = new GovernanceResponse({
      actions: [{ type: 'stop', reason: 'test' }],
    });
    expect(gov.hasStop).toBe(true);
  });

  it('hasStop returns false when no stop action', () => {
    const gov = new GovernanceResponse({
      actions: [{ type: 'alert', message: 'hey' }],
    });
    expect(gov.hasStop).toBe(false);
  });

  it('hasInject returns true when inject_message action present', () => {
    const gov = new GovernanceResponse({
      actions: [{ type: 'inject_message', content: 'hello' }],
    });
    expect(gov.hasInject).toBe(true);
  });

  it('hasInject returns false when no inject_message', () => {
    const gov = new GovernanceResponse({
      actions: [{ type: 'stop' }],
    });
    expect(gov.hasInject).toBe(false);
  });

  it('handles mixed actions', () => {
    const gov = new GovernanceResponse({
      actions: [
        { type: 'stop', reason: 'cost' },
        { type: 'inject_message', content: 'shutting down' },
        { type: 'alert', message: 'alert!' },
      ],
    });
    expect(gov.hasStop).toBe(true);
    expect(gov.hasInject).toBe(true);
    expect(gov.actions).toHaveLength(3);
  });

  it('handles null drift_score and incident_id', () => {
    const gov = new GovernanceResponse({
      drift_score: null,
      incident_id: null,
    });
    expect(gov.driftScore).toBeNull();
    expect(gov.incidentId).toBeNull();
  });
});

describe('alert level constants', () => {
  it('ALERT_INFO is "info"', () => {
    expect(ALERT_INFO).toBe('info');
  });

  it('ALERT_WARNING is "warning"', () => {
    expect(ALERT_WARNING).toBe('warning');
  });

  it('ALERT_CRITICAL is "critical"', () => {
    expect(ALERT_CRITICAL).toBe('critical');
  });
});
