/**
 * Hardening tests — pre-launch bug fixes
 *
 * FIX 1: Session auto-cleanup memory leak
 * FIX 2: API key redaction in heartbeat logs
 * FIX 3: Config type validation before applying remote updates
 * FIX 4: Anchors cannot be overridden by remote config
 * FIX 5: Checkpoint requests need timeouts
 * FIX 6: Per-call skip context manager
 * FIX 7: SDK health check
 * FIX 8: Streaming token estimation when stream breaks early
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '@/core/session';
import { Heartbeat } from '@/core/heartbeat';
import { ConfigStore } from '@/config/store';
import { CheckpointClient } from '@/core/checkpoint';
import { withSkip, _skipStore } from '@/utils/skip';

// ---------------------------------------------------------------------------
// FIX 1 — Session auto-cleanup
// ---------------------------------------------------------------------------

describe('FIX 1 — Session auto-cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('disposes cleanup timer on dispose()', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const store = new SessionStore();
    store.dispose();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('dispose() is idempotent — second call does not throw', () => {
    const store = new SessionStore();
    store.dispose();
    expect(() => store.dispose()).not.toThrow();
  });

  it('dispose() sets internal timer to null (no double-clear)', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const store = new SessionStore();
    store.dispose();
    const callCount = clearSpy.mock.calls.length;
    store.dispose(); // second call — should not call clearInterval again
    expect(clearSpy.mock.calls.length).toBe(callCount);
  });

  it('clearStaleSessions is called by cleanup timer after 1 hour', () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const spy = vi.spyOn(store, 'clearStaleSessions');
    vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour
    expect(spy).toHaveBeenCalledOnce();
    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — Heartbeat API key redaction
// ---------------------------------------------------------------------------

describe('FIX 2 — Heartbeat security', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('redacts API key from error log messages', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Connection refused to Bearer sk-test-secret-key endpoint')
    );
    const hb = new Heartbeat({
      agentId: 'agent-1',
      backendUrl: 'http://localhost:9999',
      apiKey: 'sk-test-secret-key',
      offline: false,
      intervalMs: 30000,
      debug: true,
    });
    await (hb as unknown as { _send(s: boolean): Promise<void> })._send(false);
    expect(warnSpy).toHaveBeenCalled();
    const logged = warnSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('sk-test-secret-key');
    expect(logged).toContain('****');
    warnSpy.mockRestore();
  });

  it('does not log anything in non-debug mode on error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const hb = new Heartbeat({
      agentId: 'agent-1',
      backendUrl: 'http://localhost:9999',
      apiKey: 'sk-secret',
      offline: false,
      intervalMs: 30000,
      debug: false,
    });
    await (hb as unknown as { _send(s: boolean): Promise<void> })._send(false);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs non-2xx heartbeat response in debug mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);
    const hb = new Heartbeat({
      agentId: 'agent-1',
      backendUrl: 'http://localhost',
      apiKey: 'key',
      offline: false,
      intervalMs: 30000,
      debug: true,
    });
    await (hb as unknown as { _send(s: boolean): Promise<void> })._send(false);
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('401');
    warnSpy.mockRestore();
  });

  it('does not log non-2xx in non-debug mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);
    const hb = new Heartbeat({
      agentId: 'agent-1',
      backendUrl: 'http://localhost',
      apiKey: 'key',
      offline: false,
      intervalMs: 30000,
      debug: false,
    });
    await (hb as unknown as { _send(s: boolean): Promise<void> })._send(false);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — Config type validation
// ---------------------------------------------------------------------------

describe('FIX 3 — Config injection security', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('rejects string value for numeric field', () => {
    const rejected = store.applyUpdates({ 'llm.temperature': 'evil-string' });
    expect(Object.keys(rejected)).toContain('llm.temperature');
    expect(store.get('llm', 'temperature')).toBeNull(); // unchanged (default)
  });

  it('rejects boolean value for numeric field', () => {
    const rejected = store.applyUpdates({ 'llm.max_tokens': true });
    expect(Object.keys(rejected)).toContain('llm.max_tokens');
  });

  it('rejects unknown config keys in known namespace', () => {
    const rejected = store.applyUpdates({ 'llm.nonexistent_field': 'value' });
    expect(Object.keys(rejected)).toContain('llm.nonexistent_field');
  });

  it('accepts valid numeric value', () => {
    const rejected = store.applyUpdates({ 'llm.temperature': 0.5 });
    expect(Object.keys(rejected)).not.toContain('llm.temperature');
    expect(store.get('llm', 'temperature')).toBe(0.5);
  });

  it('accepts valid string value for model field', () => {
    const rejected = store.applyUpdates({ 'llm.model': 'gpt-4o' });
    expect(Object.keys(rejected)).not.toContain('llm.model');
    expect(store.get('llm', 'model')).toBe('gpt-4o');
  });

  it('rejects value exceeding le constraint', () => {
    const rejected = store.applyUpdates({ 'llm.temperature': 3.5 }); // le: 2.0
    expect(Object.keys(rejected)).toContain('llm.temperature');
    expect(store.get('llm', 'temperature')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — Anchors cannot be overridden
// ---------------------------------------------------------------------------

describe('FIX 4 — Anchors survive remote config override', () => {
  it('anchored key appears in rejected when remote config tries to override', () => {
    const store = new ConfigStore();
    store.anchor('llm.temperature', 0.1);
    const rejected = store.applyUpdates({ 'llm.temperature': 0.9 }, 'remote');
    expect(Object.keys(rejected)).toContain('llm.temperature');
  });

  it('anchored value is preserved after override attempt', () => {
    const store = new ConfigStore();
    store.anchor('llm.temperature', 0.1);
    store.applyUpdates({ 'llm.temperature': 0.9 }, 'remote');
    expect(store.get('llm', 'temperature')).toBe(0.1);
  });

  it('unanchored field can be updated normally', () => {
    const store = new ConfigStore();
    store.anchor('llm.temperature', 0.1);
    const rejected = store.applyUpdates({ 'llm.model': 'gpt-4o' }, 'remote');
    expect(Object.keys(rejected)).not.toContain('llm.model');
    expect(store.get('llm', 'model')).toBe('gpt-4o');
  });

  it('unanchor allows subsequent override', () => {
    const store = new ConfigStore();
    store.anchor('llm.temperature', 0.1);
    store.unanchor('llm.temperature');
    const rejected = store.applyUpdates({ 'llm.temperature': 0.9 }, 'remote');
    expect(Object.keys(rejected)).not.toContain('llm.temperature');
    expect(store.get('llm', 'temperature')).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// FIX 5 — Checkpoint timeout
// ---------------------------------------------------------------------------

describe('FIX 5 — Checkpoint request timeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('passes AbortSignal to fetch with httpTimeoutMs from config', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
    } as Response);
    const client = new CheckpointClient({
      backendUrl: 'http://localhost:9999',
      apiKey: 'key',
      offline: false,
      httpTimeoutMs: 1234,
    } as import('@/types').SyrinSDKConfig);
    await client.save('ses_1', [{ role: 'user', content: 'hi' }]);
    expect(fetchSpy).toHaveBeenCalled();
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(opts.signal).toBeDefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('checkpoint save returns local checkpoint when backend unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new CheckpointClient({
      backendUrl: 'http://localhost:9999',
      apiKey: 'key',
      offline: false,
      httpTimeoutMs: 100,
    } as import('@/types').SyrinSDKConfig);
    const cp = await client.save('ses_1', [{ role: 'user', content: 'hi' }]);
    expect(cp.checkpointId).toBeTruthy();
    expect(cp.sessionId).toBe('ses_1');
  });

  it('offline mode skips fetch entirely', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const client = new CheckpointClient({
      backendUrl: 'http://localhost',
      apiKey: 'key',
      offline: true,
      httpTimeoutMs: 100,
    } as import('@/types').SyrinSDKConfig);
    await client.save('ses_1', []);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FIX 6 — withSkip per-call bypass
// ---------------------------------------------------------------------------

describe('FIX 6 — withSkip context manager', () => {
  it('withSkip sets the skip store to true inside the callback', async () => {
    let valueInsideFn: boolean | undefined;
    await withSkip(async () => {
      valueInsideFn = _skipStore.getStore();
    });
    expect(valueInsideFn).toBe(true);
  });

  it('skip store is undefined outside withSkip', () => {
    expect(_skipStore.getStore()).toBeUndefined();
  });

  it('skip store returns to undefined after withSkip resolves', async () => {
    await withSkip(async () => {
      // inside
    });
    expect(_skipStore.getStore()).toBeUndefined();
  });

  it('withSkip returns the value from fn', async () => {
    const result = await withSkip(async () => 42);
    expect(result).toBe(42);
  });

  it('withSkip propagates errors from fn', async () => {
    await expect(
      withSkip(async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
  });

  it('nested withSkip calls preserve skip semantics', async () => {
    let innerValue: boolean | undefined;
    await withSkip(async () => {
      await withSkip(async () => {
        innerValue = _skipStore.getStore();
      });
    });
    expect(innerValue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIX 7 — SDK health check
// ---------------------------------------------------------------------------

describe('FIX 7 — healthCheck()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns true when backend responds 200 OK', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const { SyrinSDKInstance } = await import('@/index');
    // We test via the class method directly using a minimal stub instance
    const instance = Object.create(SyrinSDKInstance.prototype) as InstanceType<typeof SyrinSDKInstance>;
    (instance as unknown as Record<string, unknown>)['_config'] = {
      backendUrl: 'http://localhost:4000',
      apiKey: 'syrin_test',
    };
    expect(await instance.healthCheck()).toBe(true);
  });

  it('returns false when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const { SyrinSDKInstance } = await import('@/index');
    const instance = Object.create(SyrinSDKInstance.prototype) as InstanceType<typeof SyrinSDKInstance>;
    (instance as unknown as Record<string, unknown>)['_config'] = {
      backendUrl: 'http://localhost:9999',
      apiKey: 'key',
    };
    expect(await instance.healthCheck()).toBe(false);
  });

  it('returns false when backend responds non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);
    const { SyrinSDKInstance } = await import('@/index');
    const instance = Object.create(SyrinSDKInstance.prototype) as InstanceType<typeof SyrinSDKInstance>;
    (instance as unknown as Record<string, unknown>)['_config'] = {
      backendUrl: 'http://localhost:4000',
      apiKey: 'key',
    };
    expect(await instance.healthCheck()).toBe(false);
  });

  it('healthCheck calls /health endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const { SyrinSDKInstance } = await import('@/index');
    const instance = Object.create(SyrinSDKInstance.prototype) as InstanceType<typeof SyrinSDKInstance>;
    (instance as unknown as Record<string, unknown>)['_config'] = {
      backendUrl: 'http://localhost:4000',
      apiKey: 'mykey',
    };
    await instance.healthCheck();
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4000/health',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer mykey' }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// FIX 8 — Streaming token estimation on early break
// ---------------------------------------------------------------------------

describe('FIX 8 — Streaming token estimation', () => {
  // These tests require the OpenAI adapter streaming module (src/adapters/openai/stream)
  // which will be implemented as part of the Tier-1 adapter framework.
  it.todo('estimates output tokens when stream ends without usage data');
  it.todo('uses actual usage data when provided in stream');
});
