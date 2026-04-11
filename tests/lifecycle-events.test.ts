/**
 * Tests: Feature 1 — Multi-agent lifecycle events
 *
 * withAgent → AGENT_RUN_STARTED / AGENT_RUN_ENDED
 * withWorkflow → WORKFLOW_STARTED / WORKFLOW_ENDED
 * withSwarm → SWARM_STARTED / SWARM_ENDED
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withAgent,
  withWorkflow,
  withSwarm,
  _setLifecycleEmitter,
} from '@/agent/context';
import type { SyrinEvent } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCollectingEmitter() {
  const events: Array<{ event: SyrinEvent; sessionId: string }> = [];
  const emitter = {
    emit(event: SyrinEvent, sessionId: string) {
      events.push({ event, sessionId });
    },
  };
  return { emitter, events };
}

afterEach(() => {
  // Reset lifecycle emitter after each test so it doesn't bleed
  _setLifecycleEmitter(null);
});

// ---------------------------------------------------------------------------
// withAgent
// ---------------------------------------------------------------------------

describe('withAgent lifecycle events', () => {
  beforeEach(() => {
    _setLifecycleEmitter(null);
  });

  it('emits AGENT_RUN_STARTED on entry', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    await withAgent('researcher', async () => {
      /* noop */
    });

    const started = events.find((e) => e.event.event_type === 'AGENT_RUN_STARTED');
    expect(started).toBeDefined();
  });

  it('emits AGENT_RUN_ENDED on exit', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    await withAgent('researcher', async () => {
      /* noop */
    });

    const ended = events.find((e) => e.event.event_type === 'AGENT_RUN_ENDED');
    expect(ended).toBeDefined();
  });

  it('emits AGENT_RUN_ENDED even when fn throws', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    try {
      await withAgent('faulty', async () => {
        throw new Error('boom');
      });
    } catch {
      /* expected */
    }

    const ended = events.find((e) => e.event.event_type === 'AGENT_RUN_ENDED');
    expect(ended).toBeDefined();
  });

  it('AGENT_RUN_ENDED has duration_ms >= 0', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    await withAgent('timer-agent', async () => {
      await new Promise((r) => setTimeout(r, 5));
    });

    const ended = events.find((e) => e.event.event_type === 'AGENT_RUN_ENDED');
    expect(ended?.event.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('event fields match RunContext values exactly', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    await withAgent('field-check', async (ctx) => {
      // Verify started event carries the same run_id and agent_id as the ctx
      const started = events.find((e) => e.event.event_type === 'AGENT_RUN_STARTED');
      expect(started?.event.run_id).toBe(ctx.runId);
      expect(started?.event.agent_id).toBe('field-check');
      expect(started?.event.trace_id).toBe(ctx.traceId);
      expect(started?.event.call_depth).toBe(ctx.callDepth);
    });
  });

  it('no emitter set → no crash (graceful no-op)', async () => {
    // _setLifecycleEmitter(null) — already done in beforeEach
    await expect(
      withAgent('silent', async () => { /* noop */ })
    ).resolves.toBeUndefined();
  });

  it('parallel withAgent calls each emit their own events', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    await Promise.all([
      withAgent('alpha', async () => { await new Promise((r) => setTimeout(r, 5)); }),
      withAgent('beta', async () => { await new Promise((r) => setTimeout(r, 5)); }),
    ]);

    const startedAlpha = events.filter(
      (e) => e.event.event_type === 'AGENT_RUN_STARTED' && e.event.agent_id === 'alpha'
    );
    const startedBeta = events.filter(
      (e) => e.event.event_type === 'AGENT_RUN_STARTED' && e.event.agent_id === 'beta'
    );
    expect(startedAlpha).toHaveLength(1);
    expect(startedBeta).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// withWorkflow
// ---------------------------------------------------------------------------

describe('withWorkflow lifecycle events', () => {
  it('emits WORKFLOW_STARTED and WORKFLOW_ENDED', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    await withWorkflow('my-pipeline', async () => { /* noop */ });

    expect(events.find((e) => e.event.event_type === 'WORKFLOW_STARTED')).toBeDefined();
    expect(events.find((e) => e.event.event_type === 'WORKFLOW_ENDED')).toBeDefined();
  });

  it('WORKFLOW_ENDED has duration_ms >= 0', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    await withWorkflow('timer-wf', async () => {
      await new Promise((r) => setTimeout(r, 5));
    });

    const ended = events.find((e) => e.event.event_type === 'WORKFLOW_ENDED');
    expect(ended?.event.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('WORKFLOW_ENDED emitted even when fn throws', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    try {
      await withWorkflow('faulty-wf', async () => { throw new Error('wf boom'); });
    } catch { /* expected */ }

    expect(events.find((e) => e.event.event_type === 'WORKFLOW_ENDED')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// withSwarm
// ---------------------------------------------------------------------------

describe('withSwarm lifecycle events', () => {
  it('emits SWARM_STARTED and SWARM_ENDED', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    await withSwarm('my-swarm', async () => { /* noop */ });

    expect(events.find((e) => e.event.event_type === 'SWARM_STARTED')).toBeDefined();
    expect(events.find((e) => e.event.event_type === 'SWARM_ENDED')).toBeDefined();
  });

  it('SWARM_ENDED emitted even when fn throws', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    try {
      await withSwarm('faulty-swarm', async () => { throw new Error('swarm boom'); });
    } catch { /* expected */ }

    expect(events.find((e) => e.event.event_type === 'SWARM_ENDED')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Nesting: withAgent inside withWorkflow
// ---------------------------------------------------------------------------

describe('nested contexts', () => {
  it('nested withAgent inside withWorkflow has correct parentRunId and callDepth', async () => {
    const { emitter, events } = makeCollectingEmitter();
    _setLifecycleEmitter(emitter);

    await withWorkflow('outer-wf', async (wfCtx) => {
      await withAgent('inner-agent', async (agentCtx) => {
        expect(agentCtx.parentRunId).toBe(wfCtx.runId);
        expect(agentCtx.callDepth).toBe(1); // workflow is 0, agent is 1
      });
    });

    const agentStarted = events.find((e) => e.event.event_type === 'AGENT_RUN_STARTED');
    expect(agentStarted?.event.parent_run_id).toBeDefined();
    expect(agentStarted?.event.call_depth).toBe(1);
  });
});
