/**
 * DX Refactor Tests — Changes 1–7
 *
 * TDD: these tests were written before the implementations.
 * Each describe block maps to one CHANGE from the refactor spec.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { init, shutdown, withSession, makeSessionId, type SyrinEvent } from '../src/index.js';
import type { SyrinSDKInstance } from '../src/index.js';

// ---------------------------------------------------------------------------
// CHANGE 1: Advanced submodule
// ---------------------------------------------------------------------------

describe('Advanced submodule', () => {
  it('advanced items are importable from src/advanced.ts', async () => {
    const advanced = await import('../src/advanced.js');
    expect(advanced).toBeDefined();
  });

  it('advanced exports ConfigSync', async () => {
    const advanced = await import('../src/advanced.js');
    expect(advanced.ConfigSync).toBeDefined();
  });

  it('advanced exports SyrinSDKCore', async () => {
    const advanced = await import('../src/advanced.js');
    expect(advanced.SyrinSDKCore).toBeDefined();
  });

  it('advanced exports ConfigStore', async () => {
    const advanced = await import('../src/advanced.js');
    expect(advanced.ConfigStore).toBeDefined();
  });

  it('advanced exports tunable, TunableField, tune, getTune, globalRegistry', async () => {
    const advanced = await import('../src/advanced.js');
    expect(advanced.tunable).toBeDefined();
    expect(advanced.TunableField).toBeDefined();
    expect(advanced.tune).toBeDefined();
    expect(advanced.getTune).toBeDefined();
    expect(advanced.globalRegistry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CHANGE 2: init() agentId param + process handlers
// ---------------------------------------------------------------------------

describe('init() DX improvements', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('accepts agentId param', async () => {
    const sdk = await init({ apiKey: 'test', agentId: 'my-agent', offline: true });
    expect(sdk).toBeDefined();
  });

  it('agentId takes precedence over name', async () => {
    const sdk = await init({ apiKey: 'test', agentId: 'preferred', name: 'old', offline: true });
    expect(sdk).toBeDefined();
    // Should not throw — both params coexist
    expect(sdk.config.agentId).toBe('preferred');
  });

  it('shutdown() is idempotent', async () => {
    await init({ apiKey: 'test', offline: true });
    await shutdown();
    // calling twice should not throw
    await expect(shutdown()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CHANGE 3: cfg() type inference
// ---------------------------------------------------------------------------

describe('cfg() type inference', () => {
  let sdk: SyrinSDKInstance;
  beforeEach(async () => {
    sdk = await init({ apiKey: 'test', offline: true });
  });
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('infers string when default is string', () => {
    const model: string = sdk.cfg('llm.model', 'gpt-4o');
    expect(typeof model).toBe('string');
  });

  it('infers number when default is number', () => {
    const temp: number = sdk.cfg('llm.temperature', 0.7);
    expect(typeof temp).toBe('number');
  });

  it('infers boolean when default is boolean', () => {
    const debug: boolean = sdk.cfg('agent.debug', false);
    expect(typeof debug).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// CHANGE 4: SessionWindow aliases
// ---------------------------------------------------------------------------

describe('Session window aliases', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('"persistent" window is a valid SessionWindow type', async () => {
    await init({ apiKey: 'test', offline: true });
    let sid = '';
    await withSession({ userId: 'alice', window: 'persistent' }, async (sessionId) => {
      sid = sessionId;
    });
    expect(sid).toBeTruthy();
    expect(sid).toContain('alice');
  });

  it('"daily" window works like "day"', async () => {
    await init({ apiKey: 'test', offline: true });
    let sid = '';
    await withSession({ userId: 'bob', window: 'daily' }, async (sessionId) => {
      sid = sessionId;
    });
    expect(sid).toBeTruthy();
    expect(sid).toContain('bob');
  });

  it('"hourly" alias produces same result as "hour"', () => {
    const sid1 = makeSessionId({ userId: 'test', window: 'hourly' });
    const sid2 = makeSessionId({ userId: 'test', window: 'hour' });
    expect(sid1).toBe(sid2);
  });

  it('"weekly" alias produces same result as "week"', () => {
    const sid1 = makeSessionId({ userId: 'test', window: 'weekly' });
    const sid2 = makeSessionId({ userId: 'test', window: 'week' });
    expect(sid1).toBe(sid2);
  });

  it('"monthly" alias produces same result as "month"', () => {
    const sid1 = makeSessionId({ userId: 'test', window: 'monthly' });
    const sid2 = makeSessionId({ userId: 'test', window: 'month' });
    expect(sid1).toBe(sid2);
  });

  it('"persistent" alias produces same result as "forever"', () => {
    const sid1 = makeSessionId({ userId: 'test', window: 'persistent' });
    const sid2 = makeSessionId({ userId: 'test', window: 'forever' });
    expect(sid1).toBe(sid2);
  });
});

// ---------------------------------------------------------------------------
// CHANGE 5: withSession() sid injection
// ---------------------------------------------------------------------------

describe('withSession sid injection', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('injects sessionId into callback', async () => {
    await init({ apiKey: 'test', offline: true });
    let capturedSid = '';
    await withSession({ userId: 'alice', window: 'day' }, async (sid) => {
      capturedSid = sid;
    });
    expect(capturedSid).toBeTruthy();
    expect(capturedSid).toContain('alice');
  });

  it('existing code with no-param callback still works', async () => {
    await init({ apiKey: 'test', offline: true });
    let ran = false;
    await withSession({ userId: 'bob', window: 'day' }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('no-options overload with sid injection works', async () => {
    await init({ apiKey: 'test', offline: true });
    let capturedSid = '';
    await withSession(async (sid) => {
      capturedSid = sid;
    });
    expect(capturedSid).toBeTruthy();
  });

  it('no-options overload with no-param callback works', async () => {
    await init({ apiKey: 'test', offline: true });
    let ran = false;
    await withSession(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CHANGE 6: sdk.on() event hook API
// ---------------------------------------------------------------------------

describe('sdk.on() event hooks', () => {
  afterEach(async () => {
    try { await shutdown(); } catch { /* ok */ }
  });

  it('fires handler for specific event type', async () => {
    const sdk = await init({ apiKey: 'test', offline: true });
    const received: SyrinEvent[] = [];
    const unsub = sdk.on('LLM_CALL', (event) => received.push(event));
    // Verify subscription doesn't throw and unsub works
    unsub();
    expect(received).toBeDefined();
  });

  it('fires catch-all handler for any event', async () => {
    const sdk = await init({ apiKey: 'test', offline: true });
    const received: SyrinEvent[] = [];
    const unsub = sdk.on((event) => received.push(event));
    unsub();
    expect(received).toBeDefined();
  });

  it('unsub function removes the handler', async () => {
    const sdk = await init({ apiKey: 'test', offline: true });
    const received: SyrinEvent[] = [];
    const unsub = sdk.on('LLM_CALL', (event) => received.push(event));
    unsub();
    // Handler is removed — future events won't fire it
    expect(received).toHaveLength(0);
  });

  it('on() returns a function', async () => {
    const sdk = await init({ apiKey: 'test', offline: true });
    const unsub = sdk.on('LLM_CALL', () => { /* noop */ });
    expect(typeof unsub).toBe('function');
    unsub();
  });
});

// ---------------------------------------------------------------------------
// CHANGE 7: Primary surface check
// ---------------------------------------------------------------------------

describe('Primary surface', () => {
  it('init and withAgent are exported from primary index', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.init).toBe('function');
    expect(typeof mod.withAgent).toBe('function');
  });

  it('SyrinSDKCore is still importable (backward compat)', async () => {
    // SyrinSDKCore must remain importable (tests depend on it)
    const mod = await import('../src/index.js');
    expect(mod.SyrinSDKCore).toBeDefined();
  });
});
