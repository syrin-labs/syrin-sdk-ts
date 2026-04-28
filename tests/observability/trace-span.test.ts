/**
 * Tests: src/observability/trace-span.ts
 * Covers: TraceSpan.log(), delegation, fail-open behaviour.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TraceSpan } from '@/observability/trace-span';
import { setRegisteredEmitter, clearRegisteredEmitter } from '@/agent/emitter-registry';
import type { RunContext } from '@/types';
import type { SyrinEvent } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    agentId: 'agent_x',
    runId: 'run_001',
    workflowId: 'wf_001',
    swarmId: undefined,
    parentRunId: undefined,
    ...overrides,
  };
}

interface CapturedEmit {
  event: SyrinEvent;
  sessionId: string;
}

function makeEmitter(): { emit: ReturnType<typeof vi.fn>; captured: CapturedEmit[] } {
  const captured: CapturedEmit[] = [];
  const emit = vi.fn((event: SyrinEvent, sessionId: string) => {
    captured.push({ event, sessionId });
  });
  return { emit, captured };
}

afterEach(() => {
  clearRegisteredEmitter();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Delegation tests
// ---------------------------------------------------------------------------

describe('TraceSpan delegation', () => {
  it('delegates agentId from RunContext', () => {
    const span = new TraceSpan(makeCtx({ agentId: 'my-agent' }));
    expect(span.agentId).toBe('my-agent');
  });

  it('delegates runId from RunContext', () => {
    const span = new TraceSpan(makeCtx({ runId: 'run_xyz' }));
    expect(span.runId).toBe('run_xyz');
  });

  it('delegates workflowId from RunContext', () => {
    const span = new TraceSpan(makeCtx({ workflowId: 'wf_abc' }));
    expect(span.workflowId).toBe('wf_abc');
  });

  it('delegates swarmId from RunContext', () => {
    const span = new TraceSpan(makeCtx({ swarmId: 'swarm_1' }));
    expect(span.swarmId).toBe('swarm_1');
  });

  it('delegates parentRunId from RunContext', () => {
    const span = new TraceSpan(makeCtx({ parentRunId: 'run_parent' }));
    expect(span.parentRunId).toBe('run_parent');
  });

  it('context getter returns the underlying RunContext', () => {
    const ctx = makeCtx();
    const span = new TraceSpan(ctx);
    expect(span.context).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// log() — event emission
// ---------------------------------------------------------------------------

describe('TraceSpan.log()', () => {
  it('emits TRACE_EVENT with correct event_type', () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test', agentId: 'a1' });

    const span = new TraceSpan(makeCtx());
    span.log('GUARDRAIL', 'pii-check', { blocked: false });

    expect(captured).toHaveLength(1);
    expect(captured[0].event.event_type).toBe('TRACE_EVENT');
  });

  it('emits correct trace_type', () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const span = new TraceSpan(makeCtx());
    span.log('GUARDRAIL', 'label', { blocked: false });

    const raw = captured[0].event as unknown as Record<string, unknown>;
    expect(raw['trace_type']).toBe('GUARDRAIL');
  });

  it('normalizes trace_type to uppercase', () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const span = new TraceSpan(makeCtx());
    span.log('guardrail', 'test');

    const raw = captured[0].event as unknown as Record<string, unknown>;
    expect(raw['trace_type']).toBe('GUARDRAIL');
  });

  it('emits the label field', () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const span = new TraceSpan(makeCtx());
    span.log('CUSTOM', 'my-label', {});

    const raw = captured[0].event as unknown as Record<string, unknown>;
    expect(raw['label']).toBe('my-label');
  });

  it('emits the data payload', () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const span = new TraceSpan(makeCtx());
    span.log('BUDGET_PRE', 'cost estimate', { estimated_usd: 0.003 });

    const raw = captured[0].event as unknown as Record<string, unknown>;
    expect(raw['data']).toEqual({ estimated_usd: 0.003 });
  });

  it('emits run_id from the RunContext', () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const span = new TraceSpan(makeCtx({ runId: 'run_999' }));
    span.log('CHECKPOINT', 'step 1');

    const raw = captured[0].event as unknown as Record<string, unknown>;
    expect(raw['run_id']).toBe('run_999');
  });

  it('emits agent_id from the RunContext', () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const span = new TraceSpan(makeCtx({ agentId: 'ctx-agent' }));
    span.log('TOOL_CALL', 'web_search');

    const raw = captured[0].event as unknown as Record<string, unknown>;
    expect(raw['agent_id']).toBe('ctx-agent');
  });

  it('accepts unknown trace_type — still emits (fail-open)', () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const span = new TraceSpan(makeCtx());
    span.log('MY_CUSTOM_TYPE', 'something');

    expect(captured).toHaveLength(1);
    const raw = captured[0].event as unknown as Record<string, unknown>;
    expect(raw['trace_type']).toBe('MY_CUSTOM_TYPE');
  });

  it('empty trace_type falls back to CUSTOM', () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const span = new TraceSpan(makeCtx());
    span.log('', 'unlabeled');

    const raw = captured[0].event as unknown as Record<string, unknown>;
    expect(raw['trace_type']).toBe('CUSTOM');
  });

  it('fail-open: log() does not throw when SDK is not initialized', () => {
    // No emitter registered
    const span = new TraceSpan(makeCtx());
    expect(() => span.log('GUARDRAIL', 'test', { ok: true })).not.toThrow();
  });

  it('fail-open: log() does not throw when emitter throws internally', () => {
    const emit = vi.fn(() => { throw new Error('emitter crash'); });
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const span = new TraceSpan(makeCtx());
    expect(() => span.log('GUARDRAIL', 'test')).not.toThrow();
  });
});
