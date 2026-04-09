/**
 * Tests: src/framework-context.ts
 *
 * Uses AsyncLocalStorage under the hood — tests run entirely in-process.
 */

import { describe, it, expect } from 'vitest';
import type { FrameworkContext } from '@/framework-context';
import { getFrameworkContext, withFrameworkContext } from '@/framework-context';

function makeCtx(overrides: Partial<FrameworkContext> = {}): FrameworkContext {
  return {
    framework: 'langgraph',
    agentId: 'agent-1',
    sessionId: 'ses-abc',
    runId: 'run-xyz',
    extra: {},
    ...overrides,
  };
}

describe('framework-context', () => {
  it('getFrameworkContext returns undefined when not set', () => {
    // Outside any withFrameworkContext call, the store is empty
    expect(getFrameworkContext()).toBeUndefined();
  });

  it('withFrameworkContext sets and returns context', () => {
    const ctx = makeCtx({ framework: 'crewai', graphId: 'g1', nodeName: 'n1' });
    withFrameworkContext(ctx, () => {
      const result = getFrameworkContext();
      expect(result).toBeDefined();
      expect(result!.framework).toBe('crewai');
      expect(result!.agentId).toBe('agent-1');
      expect(result!.sessionId).toBe('ses-abc');
      expect(result!.runId).toBe('run-xyz');
      expect(result!.graphId).toBe('g1');
      expect(result!.nodeName).toBe('n1');
    });
  });

  it('withFrameworkContext clears context after callback', () => {
    const ctx = makeCtx();
    withFrameworkContext(ctx, () => {
      // inside — context is set
      expect(getFrameworkContext()).toBeDefined();
    });
    // outside — context is cleared
    expect(getFrameworkContext()).toBeUndefined();
  });

  it('withFrameworkContext restores context on exception', () => {
    const ctx = makeCtx();
    expect(() => {
      withFrameworkContext(ctx, () => {
        throw new Error('boom');
      });
    }).toThrow('boom');
    // After the exception, context must still be cleared
    expect(getFrameworkContext()).toBeUndefined();
  });

  it('withFrameworkContext supports nesting', () => {
    const outer = makeCtx({ framework: 'mastra', runId: 'outer-run' });
    const inner = makeCtx({ framework: 'agno', runId: 'inner-run' });

    withFrameworkContext(outer, () => {
      expect(getFrameworkContext()!.runId).toBe('outer-run');

      withFrameworkContext(inner, () => {
        expect(getFrameworkContext()!.runId).toBe('inner-run');
        expect(getFrameworkContext()!.framework).toBe('agno');
      });

      // After inner returns, outer context is restored
      expect(getFrameworkContext()!.runId).toBe('outer-run');
      expect(getFrameworkContext()!.framework).toBe('mastra');
    });

    expect(getFrameworkContext()).toBeUndefined();
  });

  it('extra field defaults to empty object when not provided', () => {
    const ctx: FrameworkContext = {
      framework: 'langgraph',
      agentId: undefined,
      sessionId: 'ses-1',
      runId: 'run-1',
      extra: {},
    };
    withFrameworkContext(ctx, () => {
      const result = getFrameworkContext();
      expect(result!.extra).toEqual({});
    });
  });

  it('optional fields are undefined by default', () => {
    const ctx = makeCtx(); // graphId, nodeName, taskName not set
    withFrameworkContext(ctx, () => {
      const result = getFrameworkContext();
      expect(result!.graphId).toBeUndefined();
      expect(result!.nodeName).toBeUndefined();
      expect(result!.taskName).toBeUndefined();
    });
  });
});
