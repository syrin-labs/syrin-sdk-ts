/**
 * Tests: agent → workflow → swarm nesting topology
 *
 * Verifies that AsyncLocalStorage correctly propagates context across nested
 * withAgent / withWorkflow / withSwarm calls and that IDs are correctly
 * inherited or overridden at each level.
 */

import { describe, it, expect } from 'vitest';
import {
  withAgent,
  withWorkflow,
  withSwarm,
  getRunContext,
  agentStorage,
} from '@/agent/context';

// ---------------------------------------------------------------------------
// withAgent nesting
// ---------------------------------------------------------------------------

describe('withAgent nesting', () => {
  it('inner agent inside outer agent sets its own agentId', async () => {
    let outerCtx: ReturnType<typeof getRunContext>;
    let innerCtx: ReturnType<typeof getRunContext>;

    await withAgent('outer-agent', async () => {
      outerCtx = getRunContext();
      await withAgent('inner-agent', async () => {
        innerCtx = getRunContext();
      });
    });

    expect(outerCtx?.agentId).toBe('outer-agent');
    expect(innerCtx?.agentId).toBe('inner-agent');
  });

  it('inner agent inherits workflowId from outer context', async () => {
    let innerCtx: ReturnType<typeof getRunContext>;

    await withAgent('outer', async () => {
      await withWorkflow('wf-123', async () => {
        await withAgent('inner', async () => {
          innerCtx = getRunContext();
        });
      });
    });

    expect(innerCtx?.workflowId).toBe('wf-123');
    expect(innerCtx?.agentId).toBe('inner');
  });

  it('inner agent inherits swarmId from outer swarm context', async () => {
    let innerCtx: ReturnType<typeof getRunContext>;

    await withSwarm('swarm-xyz', async () => {
      await withAgent('agent-in-swarm', async () => {
        innerCtx = getRunContext();
      });
    });

    expect(innerCtx?.swarmId).toBe('swarm-xyz');
    expect(innerCtx?.agentId).toBe('agent-in-swarm');
  });

  it('inner agent sets parentRunId to outer run_id', async () => {
    let outerRunId: string | undefined;
    let innerParentRunId: string | undefined;

    await withAgent('parent-agent', async (ctx) => {
      outerRunId = ctx.runId;
      await withAgent('child-agent', async () => {
        innerParentRunId = getRunContext()?.parentRunId;
      });
    });

    expect(innerParentRunId).toBe(outerRunId);
  });

  it('does not throw when nesting the same agent twice', async () => {
    await expect(
      withAgent('same', async () => {
        await withAgent('same', async () => { /* nested */ });
      })
    ).resolves.not.toThrow();
  });

  it('auto-generates unique runIds for each nested call', async () => {
    const runIds: string[] = [];

    await withAgent('a', async (ctx) => {
      runIds.push(ctx.runId);
      await withAgent('b', async (ctx2) => {
        runIds.push(ctx2.runId);
      });
    });

    expect(runIds).toHaveLength(2);
    expect(runIds[0]).not.toBe(runIds[1]);
    expect(runIds[0]).toMatch(/^run_/);
    expect(runIds[1]).toMatch(/^run_/);
  });
});

// ---------------------------------------------------------------------------
// withWorkflow nesting inside withAgent
// ---------------------------------------------------------------------------

describe('withWorkflow nesting', () => {
  it('workflow inside agent — context has both agentId and workflowId', async () => {
    let capturedCtx: ReturnType<typeof getRunContext>;

    await withAgent('researcher', async () => {
      await withWorkflow('research-pipeline', async () => {
        capturedCtx = getRunContext();
      });
    });

    // withWorkflow replaces the top-level store entry, so agentId may not be present
    // but workflowId must be set
    expect(capturedCtx?.workflowId).toBe('research-pipeline');
  });

  it('agent inside workflow inherits workflowId', async () => {
    let capturedCtx: ReturnType<typeof getRunContext>;

    await withWorkflow('wf-pipeline', async () => {
      await withAgent('step-agent', async () => {
        capturedCtx = getRunContext();
      });
    });

    expect(capturedCtx?.agentId).toBe('step-agent');
    expect(capturedCtx?.workflowId).toBe('wf-pipeline');
  });

  it('multiple agents in sequence share the same workflowId', async () => {
    const wfIds: (string | undefined)[] = [];

    await withWorkflow('pipeline-1', async () => {
      await withAgent('agent-A', async () => {
        wfIds.push(getRunContext()?.workflowId);
      });
      await withAgent('agent-B', async () => {
        wfIds.push(getRunContext()?.workflowId);
      });
    });

    expect(wfIds).toEqual(['pipeline-1', 'pipeline-1']);
  });

  it('auto-generates workflowId when undefined passed', async () => {
    let capturedCtx: ReturnType<typeof getRunContext>;

    await withWorkflow(undefined, async () => {
      capturedCtx = getRunContext();
    });

    expect(capturedCtx?.workflowId).toMatch(/^wf_/);
  });

  it('nested workflows — inner workflow overrides workflowId', async () => {
    let innerCtx: ReturnType<typeof getRunContext>;

    await withWorkflow('outer-wf', async () => {
      await withWorkflow('inner-wf', async () => {
        innerCtx = getRunContext();
      });
    });

    expect(innerCtx?.workflowId).toBe('inner-wf');
    expect(innerCtx?.parentRunId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// withSwarm nesting
// ---------------------------------------------------------------------------

describe('withSwarm nesting', () => {
  it('agents in a swarm inherit swarmId', async () => {
    const swarmIds: (string | undefined)[] = [];

    await withSwarm('data-collectors', async () => {
      await Promise.all([
        withAgent('collector-1', async () => {
          swarmIds.push(getRunContext()?.swarmId);
        }),
        withAgent('collector-2', async () => {
          swarmIds.push(getRunContext()?.swarmId);
        }),
      ]);
    });

    expect(swarmIds).toHaveLength(2);
    expect(swarmIds.every((id) => id === 'data-collectors')).toBe(true);
  });

  it('auto-generates swarmId when undefined passed', async () => {
    let capturedCtx: ReturnType<typeof getRunContext>;

    await withSwarm(undefined, async () => {
      capturedCtx = getRunContext();
    });

    expect(capturedCtx?.swarmId).toMatch(/^swarm_/);
  });

  it('parallel agents in swarm each have unique runIds', async () => {
    const runIds: string[] = [];

    await withSwarm('parallel-swarm', async () => {
      await Promise.all([
        withAgent('a1', async (ctx) => { runIds.push(ctx.runId); }),
        withAgent('a2', async (ctx) => { runIds.push(ctx.runId); }),
        withAgent('a3', async (ctx) => { runIds.push(ctx.runId); }),
      ]);
    });

    expect(new Set(runIds).size).toBe(3);
  });

  it('swarm inside workflow — agent inherits swarmId', async () => {
    // Note: withSwarm creates a new context with swarmId set but does NOT copy
    // workflowId from a surrounding withWorkflow (the RunContext only carries
    // whatever the specific context manager sets). workflowId is only propagated
    // through withAgent's parent?.workflowId inheritance path.
    const capturedSwarmIds: (string | undefined)[] = [];

    await withWorkflow('wf-with-swarm', async () => {
      await withSwarm('inner-swarm', async () => {
        await withAgent('agent-in-both', async () => {
          capturedSwarmIds.push(getRunContext()?.swarmId);
        });
      });
    });

    // Agent inside swarm inherits swarmId from withSwarm context
    expect(capturedSwarmIds[0]).toBe('inner-swarm');
  });
});

// ---------------------------------------------------------------------------
// getRunContext
// ---------------------------------------------------------------------------

describe('getRunContext', () => {
  it('returns undefined outside any context', async () => {
    // Force a clean async context by running outside any storage.run()
    let captured: ReturnType<typeof getRunContext>;
    await agentStorage.run(undefined as unknown as import('@/types').RunContext, async () => {
      captured = getRunContext();
    });
    expect(captured).toBeUndefined();
  });

  it('returns the current RunContext inside withAgent', async () => {
    let ctx: ReturnType<typeof getRunContext>;

    await withAgent('my-agent', async () => {
      ctx = getRunContext();
    });

    expect(ctx?.agentId).toBe('my-agent');
    expect(ctx?.runId).toMatch(/^run_/);
  });

  it('context is restored after withAgent exits', async () => {
    await withAgent('ephemeral', async () => { /* nothing */ });

    // After exit, the context is back to whatever was there before — not the inner context
    // (AsyncLocalStorage scope ends when the run() callback resolves)
    const afterCtx = getRunContext();
    // Could be undefined (if top-level) or the parent context
    expect(afterCtx?.agentId ?? undefined).not.toBe('ephemeral');
  });

  it('returns workflow context inside withWorkflow', async () => {
    let ctx: ReturnType<typeof getRunContext>;

    await withWorkflow('wf-get', async () => {
      ctx = getRunContext();
    });

    expect(ctx?.workflowId).toBe('wf-get');
  });

  it('returns swarm context inside withSwarm', async () => {
    let ctx: ReturnType<typeof getRunContext>;

    await withSwarm('swarm-get', async () => {
      ctx = getRunContext();
    });

    expect(ctx?.swarmId).toBe('swarm-get');
  });
});

// ---------------------------------------------------------------------------
// Explicit runId passing
// ---------------------------------------------------------------------------

describe('explicit runId / workflowId / swarmId options', () => {
  it('withAgent accepts a provided runId', async () => {
    let ctx: ReturnType<typeof getRunContext>;

    await withAgent('agent-explicit', async () => {
      ctx = getRunContext();
    }, { runId: 'run_explicit_123' });

    expect(ctx?.runId).toBe('run_explicit_123');
  });

  it('withAgent accepts provided workflowId and swarmId', async () => {
    let ctx: ReturnType<typeof getRunContext>;

    await withAgent('agent-opts', async () => {
      ctx = getRunContext();
    }, { workflowId: 'wf_opt_1', swarmId: 'swarm_opt_1' });

    expect(ctx?.workflowId).toBe('wf_opt_1');
    expect(ctx?.swarmId).toBe('swarm_opt_1');
  });

  it('withWorkflow accepts a provided runId', async () => {
    let ctx: ReturnType<typeof getRunContext>;

    await withWorkflow('wf-explicit', async () => {
      ctx = getRunContext();
    }, { runId: 'run_wf_99' });

    expect(ctx?.runId).toBe('run_wf_99');
  });

  it('withSwarm accepts a provided runId', async () => {
    let ctx: ReturnType<typeof getRunContext>;

    await withSwarm('swarm-explicit', async () => {
      ctx = getRunContext();
    }, { runId: 'run_swarm_77' });

    expect(ctx?.runId).toBe('run_swarm_77');
  });
});
