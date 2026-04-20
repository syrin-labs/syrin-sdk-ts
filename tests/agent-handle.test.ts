/**
 * agent-handle.test.ts — Tests for AgentHandle, sdk.workflow(), sdk.swarm(),
 * and module-level workflow()/swarm() functions.
 *
 * Covers:
 *  1.  sdk.agent("researcher") returns AgentHandle instance
 *  2.  handle.agentId getter returns "researcher"
 *  3.  handle.cfg("llm.temperature", 0.3) returns 0.3 (the default)
 *  4.  handle.cfg() uses agent namespace — not contaminated by global sdk.cfg()
 *  5.  Two agent handles are independent
 *  6.  handle.field("llm.temperature", 0.3, { ge: 0, le: 2 }) returns handle (fluent)
 *  7.  Multiple .field() calls can be chained
 *  8.  handle.run(async () => { ... }) — callback is called
 *  9.  Inside handle.run(), sdk.cfg() uses agent namespace
 * 10.  handle.session({ userId }, fn) — ctx.agentId === "researcher", ctx.sessionId is set
 * 11.  sdk.workflow("pipeline", fn) — ctx.workflowId === "pipeline"
 * 12.  sdk.swarm("swarm-1", fn) — ctx.swarmId === "swarm-1"
 * 13.  Module-level workflow("pipeline", fn) — workflowId is set
 * 14.  Module-level swarm("swarm-1", fn) — swarmId is set
 * 15.  Agents inside sdk.workflow() inherit the workflowId
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  init,
  shutdown,
  AgentHandle,
  workflow as moduleWorkflow,
  swarm as moduleSwarm,
  type SyrinSDKInstance,
  type SyrinContext,
} from '../src/index.js';
import { agentStorage, getRunContext } from '../src/agent/context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mkSdk(): Promise<SyrinSDKInstance> {
  return init({ apiKey: 'test', offline: true });
}

// ---------------------------------------------------------------------------
// AgentHandle basics
// ---------------------------------------------------------------------------

describe('AgentHandle basics', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('sdk.agent() returns an AgentHandle instance', async () => {
    const sdk = await mkSdk();
    const handle = sdk.agent('researcher');
    expect(handle).toBeInstanceOf(AgentHandle);
  });

  it('handle.agentId getter returns the registered agentId', async () => {
    const sdk = await mkSdk();
    const handle = sdk.agent('researcher');
    expect(handle.agentId).toBe('researcher');
  });

  it('handle.cfg() returns the default value', async () => {
    const sdk = await mkSdk();
    const handle = sdk.agent('researcher');
    const val = handle.cfg('llm.temperature', 0.3);
    expect(val).toBe(0.3);
  });

  it('handle.cfg() uses agent namespace — global sdk.cfg() with different default does not affect it', async () => {
    const sdk = await mkSdk();
    // Set a global default (outside any agent context)
    sdk.cfg('llm.temperature', 0.9);
    // Agent handle should return its own namespace value, not the global one
    const handle = sdk.agent('researcher');
    const val = handle.cfg('llm.temperature', 0.3);
    expect(val).toBe(0.3);
  });

  it('two agent handles are independent — different defaults do not bleed over', async () => {
    const sdk = await mkSdk();
    const researcher = sdk.agent('researcher');
    const writer = sdk.agent('writer');
    // Register defaults independently
    researcher.cfg('llm.temperature', 0.3);
    writer.cfg('llm.temperature', 0.9);
    // Each should report their own default
    expect(researcher.cfg('llm.temperature', 0.3)).toBe(0.3);
    expect(writer.cfg('llm.temperature', 0.9)).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// handle.field() — fluent field declaration
// ---------------------------------------------------------------------------

describe('AgentHandle.field()', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('handle.field() returns the handle itself (fluent)', async () => {
    const sdk = await mkSdk();
    const handle = sdk.agent('researcher');
    const returned = handle.field('llm.temperature', 0.3, { ge: 0, le: 2 });
    expect(returned).toBe(handle);
  });

  it('multiple .field() calls can be chained', async () => {
    const sdk = await mkSdk();
    const handle = sdk.agent('researcher');
    const returned = handle
      .field('llm.temperature', 0.3, { ge: 0, le: 2 })
      .field('llm.model', 'gpt-4o')
      .field('llm.max_tokens', 1024, { ge: 1 });
    expect(returned).toBe(handle);
  });
});

// ---------------------------------------------------------------------------
// handle.run() — agent context entry
// ---------------------------------------------------------------------------

describe('AgentHandle.run()', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('handle.run() calls the callback', async () => {
    const sdk = await mkSdk();
    const handle = sdk.agent('researcher');
    let called = false;
    await handle.run(async () => { called = true; });
    expect(called).toBe(true);
  });

  it('handle.run() returns the callback return value', async () => {
    const sdk = await mkSdk();
    const handle = sdk.agent('researcher');
    const result = await handle.run(async () => 42);
    expect(result).toBe(42);
  });

  it('inside handle.run(), agentStorage has the correct agentId', async () => {
    const sdk = await mkSdk();
    const handle = sdk.agent('researcher');
    let capturedAgentId: string | undefined;
    await handle.run(async () => {
      capturedAgentId = agentStorage.getStore()?.agentId;
    });
    expect(capturedAgentId).toBe('researcher');
  });

  it('inside handle.run(), sdk.cfg() uses the agent namespace', async () => {
    const sdk = await mkSdk();
    // Pre-register in agent namespace first
    const handle = sdk.agent('researcher');
    handle.cfg('llm.temperature', 0.3);

    let valueInsideRun: unknown;
    await handle.run(async () => {
      // Inside run(), agentStorage is set, so sdk.cfg reads agents.researcher.llm.temperature
      valueInsideRun = sdk.cfg('llm.temperature', 0.3);
    });
    expect(valueInsideRun).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// handle.session() — combined session + agent context
// ---------------------------------------------------------------------------

describe('AgentHandle.session()', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('ctx.agentId is set to the handle\'s agentId', async () => {
    const sdk = await mkSdk();
    const handle = sdk.agent('researcher');
    let captured: SyrinContext | null = null;
    await handle.session({ userId: 'alice' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured!.agentId).toBe('researcher');
  });

  it('ctx.sessionId is set when userId is provided', async () => {
    const sdk = await mkSdk();
    const handle = sdk.agent('researcher');
    let captured: SyrinContext | null = null;
    await handle.session({ userId: 'alice' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured!.sessionId).not.toBeNull();
    expect(captured!.sessionId).toMatch(/^u:alice/);
  });

  it('returns the callback return value', async () => {
    const sdk = await mkSdk();
    const handle = sdk.agent('researcher');
    const result = await handle.session({}, async (_ctx) => 'done');
    expect(result).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// sdk.workflow() — instance method
// ---------------------------------------------------------------------------

describe('sdk.workflow()', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('ctx.workflowId is set', async () => {
    const sdk = await mkSdk();
    let capturedWorkflowId: string | undefined;
    await sdk.workflow('pipeline', async (ctx) => {
      capturedWorkflowId = ctx.workflowId ?? undefined;
    });
    expect(capturedWorkflowId).toBe('pipeline');
  });

  it('returns the callback return value', async () => {
    const sdk = await mkSdk();
    const result = await sdk.workflow('pipeline', async (_ctx) => 99);
    expect(result).toBe(99);
  });

  it('agents nested inside sdk.workflow() inherit the workflowId', async () => {
    const sdk = await mkSdk();
    let capturedInner: ReturnType<typeof getRunContext>;
    await sdk.workflow('research-pipeline', async (_ctx) => {
      const { withAgent } = await import('../src/agent/context.js');
      await withAgent('inner-agent', async () => {
        capturedInner = getRunContext();
      });
    });
    expect(capturedInner?.workflowId).toBe('research-pipeline');
    expect(capturedInner?.agentId).toBe('inner-agent');
  });
});

// ---------------------------------------------------------------------------
// sdk.swarm() — instance method
// ---------------------------------------------------------------------------

describe('sdk.swarm()', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('ctx.swarmId is set', async () => {
    const sdk = await mkSdk();
    let capturedSwarmId: string | undefined;
    await sdk.swarm('swarm-1', async (ctx) => {
      capturedSwarmId = ctx.swarmId ?? undefined;
    });
    expect(capturedSwarmId).toBe('swarm-1');
  });

  it('returns the callback return value', async () => {
    const sdk = await mkSdk();
    const result = await sdk.swarm('swarm-1', async (_ctx) => 'swarm-done');
    expect(result).toBe('swarm-done');
  });
});

// ---------------------------------------------------------------------------
// Module-level workflow() and swarm()
// ---------------------------------------------------------------------------

describe('module-level workflow()', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('workflowId is set in run context', async () => {
    await mkSdk();
    let capturedWorkflowId: string | undefined;
    await moduleWorkflow('pipeline', async (ctx) => {
      capturedWorkflowId = ctx.workflowId ?? undefined;
    });
    expect(capturedWorkflowId).toBe('pipeline');
  });

  it('returns the callback return value', async () => {
    await mkSdk();
    const result = await moduleWorkflow('pipeline', async (_ctx) => 'wf-result');
    expect(result).toBe('wf-result');
  });

  it('works without SDK initialized', async () => {
    // Ensure no SDK is running
    try { await shutdown(); } catch { /* ok */ }
    let capturedWorkflowId: string | undefined;
    await moduleWorkflow('standalone', async (ctx) => {
      capturedWorkflowId = ctx.workflowId ?? undefined;
    });
    expect(capturedWorkflowId).toBe('standalone');
  });
});

describe('module-level swarm()', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('swarmId is set in run context', async () => {
    await mkSdk();
    let capturedSwarmId: string | undefined;
    await moduleSwarm('swarm-1', async (ctx) => {
      capturedSwarmId = ctx.swarmId ?? undefined;
    });
    expect(capturedSwarmId).toBe('swarm-1');
  });

  it('returns the callback return value', async () => {
    await mkSdk();
    const result = await moduleSwarm('swarm-1', async (_ctx) => 'swarm-result');
    expect(result).toBe('swarm-result');
  });

  it('works without SDK initialized', async () => {
    try { await shutdown(); } catch { /* ok */ }
    let capturedSwarmId: string | undefined;
    await moduleSwarm('standalone-swarm', async (ctx) => {
      capturedSwarmId = ctx.swarmId ?? undefined;
    });
    expect(capturedSwarmId).toBe('standalone-swarm');
  });
});
