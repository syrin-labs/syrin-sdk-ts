/**
 * Tests: src/agent.ts — multi-agent context management
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  agentStorage,
  withAgent,
  withWorkflow,
  withSwarm,
  getRunContext,
} from '@/agent/context';

afterEach(() => {
  // AsyncLocalStorage clears itself automatically per async context.
  // Nothing to clean up.
});

// ---------------------------------------------------------------------------
// withAgent
// ---------------------------------------------------------------------------

describe('withAgent', () => {
  it('sets agentId in store', async () => {
    let captured: ReturnType<typeof getRunContext>;
    await withAgent('researcher', async () => {
      captured = getRunContext();
    });
    expect(captured?.agentId).toBe('researcher');
  });

  it('auto-generates runId', async () => {
    let captured: ReturnType<typeof getRunContext>;
    await withAgent('writer', async () => {
      captured = getRunContext();
    });
    expect(captured?.runId).toBeDefined();
    expect(typeof captured?.runId).toBe('string');
    expect(captured?.runId.startsWith('run_')).toBe(true);
  });

  it('uses provided runId', async () => {
    let captured: ReturnType<typeof getRunContext>;
    await withAgent('writer', async () => {
      captured = getRunContext();
    }, { runId: 'run-explicit' });
    expect(captured?.runId).toBe('run-explicit');
  });

  it('clears context after fn completes', async () => {
    await withAgent('agent-a', async () => { /* noop */ });
    expect(getRunContext()).toBeUndefined();
  });

  it('clears context on error', async () => {
    try {
      await withAgent('faulty', async () => { throw new Error('boom'); });
    } catch { /* expected */ }
    expect(getRunContext()).toBeUndefined();
  });

  it('inherits workflowId from outer context', async () => {
    let captured: ReturnType<typeof getRunContext>;
    await withWorkflow('my-workflow', async () => {
      await withAgent('inner-agent', async () => {
        captured = getRunContext();
      });
    });
    expect(captured?.workflowId).toBe('my-workflow');
    expect(captured?.agentId).toBe('inner-agent');
  });

  it('inherits swarmId from outer context', async () => {
    let captured: ReturnType<typeof getRunContext>;
    await withSwarm('my-swarm', async () => {
      await withAgent('swarm-member', async () => {
        captured = getRunContext();
      });
    });
    expect(captured?.swarmId).toBe('my-swarm');
  });

  it('sets parentRunId from outer context', async () => {
    let outerRunId: string | undefined;
    let innerParentRunId: string | undefined;

    await withWorkflow('wf', async (wfCtx) => {
      outerRunId = wfCtx.runId;
      await withAgent('child', async (agentCtx) => {
        innerParentRunId = agentCtx.parentRunId;
      });
    });
    expect(innerParentRunId).toBe(outerRunId);
  });
});

// ---------------------------------------------------------------------------
// Parallel isolation
// ---------------------------------------------------------------------------

describe('parallel agent isolation', () => {
  it('two concurrent agents get independent contexts', async () => {
    const results: Record<string, string | undefined> = {};

    const runAgent = async (name: string) => {
      await withAgent(name, async () => {
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        const ctx = getRunContext();
        results[name] = ctx?.agentId;
      });
    };

    await Promise.all([
      runAgent('agent-alpha'),
      runAgent('agent-beta'),
    ]);

    expect(results['agent-alpha']).toBe('agent-alpha');
    expect(results['agent-beta']).toBe('agent-beta');
  });
});

// ---------------------------------------------------------------------------
// withWorkflow
// ---------------------------------------------------------------------------

describe('withWorkflow', () => {
  it('sets workflowId', async () => {
    let captured: ReturnType<typeof getRunContext>;
    await withWorkflow('pipeline-1', async () => {
      captured = getRunContext();
    });
    expect(captured?.workflowId).toBe('pipeline-1');
  });

  it('auto-generates workflowId when not provided', async () => {
    let captured: ReturnType<typeof getRunContext>;
    await withWorkflow(undefined, async () => {
      captured = getRunContext();
    });
    expect(captured?.workflowId?.startsWith('wf_')).toBe(true);
  });

  it('clears context after fn', async () => {
    await withWorkflow('wf-1', async () => { /* noop */ });
    expect(getRunContext()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// withSwarm
// ---------------------------------------------------------------------------

describe('withSwarm', () => {
  it('sets swarmId', async () => {
    let captured: ReturnType<typeof getRunContext>;
    await withSwarm('swarm-a', async () => {
      captured = getRunContext();
    });
    expect(captured?.swarmId).toBe('swarm-a');
  });

  it('auto-generates swarmId', async () => {
    let captured: ReturnType<typeof getRunContext>;
    await withSwarm(undefined, async () => {
      captured = getRunContext();
    });
    expect(captured?.swarmId?.startsWith('swarm_')).toBe(true);
  });

  it('all parallel agents inside swarm share swarmId', async () => {
    const swarmIds: (string | undefined)[] = [];

    await withSwarm('research-swarm', async () => {
      await Promise.all([
        withAgent('agent-x', async () => {
          swarmIds.push(getRunContext()?.swarmId);
        }),
        withAgent('agent-y', async () => {
          swarmIds.push(getRunContext()?.swarmId);
        }),
      ]);
    });

    expect(swarmIds).toHaveLength(2);
    expect(swarmIds.every((id) => id === 'research-swarm')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getRunContext
// ---------------------------------------------------------------------------

describe('getRunContext', () => {
  it('returns undefined outside any context', () => {
    expect(getRunContext()).toBeUndefined();
  });

  it('returns current context inside withAgent', async () => {
    let ctx: ReturnType<typeof getRunContext>;
    await withAgent('inspector', async () => {
      ctx = getRunContext();
    });
    expect(ctx?.agentId).toBe('inspector');
  });
});
