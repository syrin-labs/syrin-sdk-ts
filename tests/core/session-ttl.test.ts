/**
 * Tests: P0-4 — SessionStore auto-eviction (TTL)
 *
 * Verifies that SessionStore can be configured to evict stale sessions
 * automatically via a periodic setInterval, and that the timer is
 * properly cleaned up via destroy().
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionStore } from '@/core/session';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('P0-4: SessionStore auto-eviction', () => {
  it('default constructor (no options) does NOT start a timer', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const store = new SessionStore();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    store.destroy();
  });

  it('autoEvictIntervalMs option starts a periodic timer', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const store = new SessionStore({ autoEvictIntervalMs: 100, sessionTtlMs: 50 });

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    store.destroy();
  });

  it('destroy() clears the eviction interval — no dangling timer', () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const store = new SessionStore({ autoEvictIntervalMs: 100, sessionTtlMs: 50 });
    store.destroy();

    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });

  it('calling destroy() on a store with no timer is a no-op (does not throw)', () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    expect(() => store.destroy()).not.toThrow();
  });

  it('evicts sessions older than sessionTtlMs after the interval fires', async () => {
    vi.useFakeTimers();

    const TTL_MS = 50;
    const INTERVAL_MS = 100;

    const store = new SessionStore({ autoEvictIntervalMs: INTERVAL_MS, sessionTtlMs: TTL_MS });

    // Create a session
    await store.getOrCreate('ses_old', 'agent-1');

    // Advance time past the TTL so the session is stale
    vi.advanceTimersByTime(TTL_MS + 10);

    // Advance through the eviction interval
    vi.advanceTimersByTime(INTERVAL_MS);

    // Session should be gone
    expect(store.getSession('ses_old')).toBeUndefined();

    store.destroy();
  });

  it('recently-active sessions are NOT evicted when timer fires', async () => {
    vi.useFakeTimers();

    const TTL_MS = 200;
    const INTERVAL_MS = 100;

    const store = new SessionStore({ autoEvictIntervalMs: INTERVAL_MS, sessionTtlMs: TTL_MS });

    // Create a fresh session
    await store.getOrCreate('ses_fresh', 'agent-2');

    // Advance only past the interval but not the TTL
    vi.advanceTimersByTime(INTERVAL_MS + 10);

    // Session should still be present
    expect(store.getSession('ses_fresh')).toBeDefined();

    store.destroy();
  });

  it('after destroy(), advancing time does NOT evict sessions (timer is cleared)', async () => {
    vi.useFakeTimers();

    const TTL_MS = 50;
    const INTERVAL_MS = 100;

    const store = new SessionStore({ autoEvictIntervalMs: INTERVAL_MS, sessionTtlMs: TTL_MS });
    await store.getOrCreate('ses_keep', 'agent-3');

    // Destroy before the interval fires
    store.destroy();

    // Advance time well past TTL + interval
    vi.advanceTimersByTime(TTL_MS + INTERVAL_MS + 500);

    // Session should still be there — no timer is running to evict it
    expect(store.getSession('ses_keep')).toBeDefined();
  });
});
