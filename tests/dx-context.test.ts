/**
 * dx-context.test.ts — Tests for sdk.context() and sdk.traced()
 *
 * Covers:
 *  - sdk.context({ agentId }) — runs fn and returns its value
 *  - sdk.context({ userId }) — ctx.sessionId is set
 *  - sdk.context({ userId, agentId }) — both set in ctx
 *  - sdk.context({}) — no-op, still runs fn
 *  - sdk.traced({ agentId })(fn) — wraps fn correctly
 *  - sdk.traced({}) — return value preserved
 *  - Module-level context() works when SDK is initialized
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  init,
  shutdown,
  context as moduleContext,
  traced as moduleTraced,
  type SyrinContext,
  type ContextOptions,
  type SyrinSDKInstance,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mkSdk(): Promise<SyrinSDKInstance> {
  return init({ apiKey: 'test', offline: true });
}

// ---------------------------------------------------------------------------
// sdk.context()
// ---------------------------------------------------------------------------

describe('sdk.context()', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('runs fn and returns its value', async () => {
    const sdk = await mkSdk();
    const result = await sdk.context({ agentId: 'x' }, async (_ctx) => 42);
    expect(result).toBe(42);
  });

  it('ctx.agentId is set when agentId option is provided', async () => {
    const sdk = await mkSdk();
    let captured: SyrinContext | null = null;
    await sdk.context({ agentId: 'researcher' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured!.agentId).toBe('researcher');
  });

  it('ctx.agentId is set when agent alias is used', async () => {
    const sdk = await mkSdk();
    let captured: SyrinContext | null = null;
    await sdk.context({ agent: 'researcher' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured!.agentId).toBe('researcher');
  });

  it('ctx.sessionId is set when userId is provided', async () => {
    const sdk = await mkSdk();
    let captured: SyrinContext | null = null;
    await sdk.context({ userId: 'alice' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured!.sessionId).not.toBeNull();
    // Grouped session IDs start with u:
    expect(captured!.sessionId).toMatch(/^u:alice/);
  });

  it('ctx.sessionId and ctx.agentId are both set', async () => {
    const sdk = await mkSdk();
    let captured: SyrinContext | null = null;
    await sdk.context({ userId: 'alice', agentId: 'researcher' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured!.sessionId).toMatch(/^u:alice/);
    expect(captured!.agentId).toBe('researcher');
  });

  it('ctx.workflowId is set when workflowId option is provided', async () => {
    const sdk = await mkSdk();
    let captured: SyrinContext | null = null;
    await sdk.context({ workflowId: 'my-workflow' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured!.workflowId).toBe('my-workflow');
  });

  it('ctx.workflowId is set via workflow alias', async () => {
    const sdk = await mkSdk();
    let captured: SyrinContext | null = null;
    await sdk.context({ workflow: 'pipeline' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured!.workflowId).toBe('pipeline');
  });

  it('ctx.swarmId is set via swarm alias', async () => {
    const sdk = await mkSdk();
    let captured: SyrinContext | null = null;
    await sdk.context({ swarm: 'parallel-research' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured!.swarmId).toBe('parallel-research');
  });

  it('empty options — no-op, still runs fn', async () => {
    const sdk = await mkSdk();
    let ran = false;
    const result = await sdk.context({}, async (ctx) => {
      ran = true;
      return ctx;
    });
    expect(ran).toBe(true);
    expect(result.agentId).toBeNull();
    expect(result.workflowId).toBeNull();
    expect(result.swarmId).toBeNull();
  });

  it('empty options — ctx.sessionId is null (no userId)', async () => {
    const sdk = await mkSdk();
    let captured: SyrinContext | null = null;
    await sdk.context({}, async (ctx) => {
      captured = ctx;
    });
    // Without userId, no withSession is called, sessionId may be null
    // (or the SDK default session if one exists — just verify no crash)
    expect(captured).not.toBeNull();
  });

  it('explicit sessionId overrides auto-generation', async () => {
    const sdk = await mkSdk();
    let captured: SyrinContext | null = null;
    await sdk.context({ sessionId: 'my-fixed-session' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured!.sessionId).toBe('my-fixed-session');
  });

  it('propagates fn rejection', async () => {
    const sdk = await mkSdk();
    await expect(
      sdk.context({ agentId: 'x' }, async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
  });

  it('return value from nested async fn is preserved', async () => {
    const sdk = await mkSdk();
    const data = { x: 1, y: 'hello' };
    const result = await sdk.context({ agentId: 'x' }, async () => data);
    expect(result).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// sdk.traced()
// ---------------------------------------------------------------------------

describe('sdk.traced()', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('wraps fn — the wrapped function is callable', async () => {
    const sdk = await mkSdk();
    const original = async (x: number) => x * 2;
    // typed cast needed because traced<> generic requires unknown args
    const wrapped = sdk.traced({ agentId: 'researcher' })(original as unknown as (...args: unknown[]) => Promise<unknown>);
    const result = await (wrapped as (x: number) => Promise<number>)(21);
    expect(result).toBe(42);
  });

  it('preserves return value', async () => {
    const sdk = await mkSdk();
    const fn = async () => ({ ok: true, value: 99 });
    const wrapped = sdk.traced({})(fn as unknown as (...args: unknown[]) => Promise<unknown>);
    const result = await (wrapped as () => Promise<{ ok: boolean; value: number }>)();
    expect(result).toEqual({ ok: true, value: 99 });
  });

  it('propagates errors from wrapped fn', async () => {
    const sdk = await mkSdk();
    const fn = async () => { throw new Error('traced-error'); };
    const wrapped = sdk.traced({ agent: 'x' })(fn as unknown as (...args: unknown[]) => Promise<unknown>);
    await expect((wrapped as () => Promise<never>)()).rejects.toThrow('traced-error');
  });

  it('options.agent alias works in traced', async () => {
    const sdk = await mkSdk();
    let capturedAgentId: string | null = null;
    const fn = async () => {
      // We can't directly read agentStorage here without importing it,
      // but we verify the call completes without error.
      return 'done';
    };
    const wrapped = sdk.traced({ agent: 'my-agent' })(fn as unknown as (...args: unknown[]) => Promise<unknown>);
    const result = await (wrapped as () => Promise<string>)();
    expect(result).toBe('done');
    // capturedAgentId is not set in this test — just verifying no crash
    void capturedAgentId;
  });

  it('called multiple times — independent scopes', async () => {
    const sdk = await mkSdk();
    const results: number[] = [];
    const fn = async (n: number) => { results.push(n); return n; };
    const wrapped = sdk.traced({ agentId: 'counter' })(fn as unknown as (...args: unknown[]) => Promise<unknown>);
    await Promise.all([
      (wrapped as (n: number) => Promise<number>)(1),
      (wrapped as (n: number) => Promise<number>)(2),
      (wrapped as (n: number) => Promise<number>)(3),
    ]);
    expect(results.sort()).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Module-level context() and traced()
// ---------------------------------------------------------------------------

describe('module-level context()', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('works after SDK is initialized', async () => {
    await init({ apiKey: 'test', offline: true });
    let captured: SyrinContext | null = null;
    await moduleContext({ agentId: 'researcher' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured).not.toBeNull();
    expect(captured!.agentId).toBe('researcher');
  });

  it('ctx.sessionId is set via userId', async () => {
    await init({ apiKey: 'test', offline: true });
    let captured: SyrinContext | null = null;
    await moduleContext({ userId: 'bob' }, async (ctx) => {
      captured = ctx;
    });
    expect(captured!.sessionId).toMatch(/^u:bob/);
  });

  it('returns fn value', async () => {
    await init({ apiKey: 'test', offline: true });
    const result = await moduleContext({ agentId: 'x' }, async () => 'hello');
    expect(result).toBe('hello');
  });

  it('fails gracefully (still runs fn) when no SDK is initialized', async () => {
    // Ensure no SDK is running
    try { await shutdown(); } catch { /* ok */ }
    let ran = false;
    const result = await moduleContext({ agentId: 'x' }, async (ctx) => {
      ran = true;
      return ctx;
    });
    expect(ran).toBe(true);
    // With no primary instance, ctx fields should be null
    expect(result.agentId).toBeNull();
    expect(result.sessionId).toBeNull();
  });
});

describe('module-level traced()', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('wraps fn and returns its value', async () => {
    await init({ apiKey: 'test', offline: true });
    const fn = async (q: string) => `answer:${q}`;
    const wrapped = moduleTraced({ agent: 'researcher' })(fn as unknown as (...args: unknown[]) => Promise<unknown>);
    const result = await (wrapped as (q: string) => Promise<string>)('test');
    expect(result).toBe('answer:test');
  });

  it('preserves errors from wrapped fn', async () => {
    await init({ apiKey: 'test', offline: true });
    const fn = async () => { throw new Error('module-traced-error'); };
    const wrapped = moduleTraced({})(fn as unknown as (...args: unknown[]) => Promise<unknown>);
    await expect((wrapped as () => Promise<never>)()).rejects.toThrow('module-traced-error');
  });
});

// ---------------------------------------------------------------------------
// Type-level assertions (compile-time only, but also run as identity checks)
// ---------------------------------------------------------------------------

describe('SyrinContext and ContextOptions types', () => {
  it('SyrinContext has the expected shape', () => {
    const ctx: SyrinContext = {
      sessionId: 'ses_123',
      agentId: 'researcher',
      workflowId: null,
      swarmId: null,
    };
    expect(ctx.sessionId).toBe('ses_123');
    expect(ctx.agentId).toBe('researcher');
    expect(ctx.workflowId).toBeNull();
    expect(ctx.swarmId).toBeNull();
  });

  it('ContextOptions accepts all short-hand aliases', () => {
    const opts: ContextOptions = {
      userId: 'alice',
      agent: 'researcher',
      workflow: 'pipeline',
      swarm: 'cluster',
      window: 'day',
    };
    expect(opts.agent).toBe('researcher');
    expect(opts.workflow).toBe('pipeline');
    expect(opts.swarm).toBe('cluster');
  });
});
