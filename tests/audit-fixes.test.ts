/**
 * Tests for audit fixes:
 *  Fix 1: Auto-refresh timer cleared on shutdown()
 *  Fix 2: ConfigGuard.safeApply() async health check rollback
 *  Fix 3: Emitter retry limit (drop after 3 retries)
 *  Fix 4: Double-patching prevention in registerAdapter()
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ConfigGuard, type RecoveryPolicy, DEFAULT_RECOVERY_POLICY } from '@/config/guard';
import { ConfigStore } from '@/config/store';
import { TunableRegistry, _setAutoRefreshCallback } from '@/tunable/tunable';
import { Emitter } from '@/observability/emitter';
import { SessionStore } from '@/core/session';
import type { SyrinSDKConfig, SyrinEvent } from '@/types';
import { generateId, nowIso } from '@/utils/helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SyrinSDKConfig> = {}): SyrinSDKConfig {
  return {
    apiKey: 'syrin_test_key',
    backendUrl: 'http://localhost:19999',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:19999',
    debug: false,
    captureContent: false,
    offline: true, // offline so no real HTTP calls
    batchIntervalMs: 60000,
    batchSize: 50,
    idleFlushMs: 60000,
    maxQueueSize: 1000,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<SyrinEvent> = {}): SyrinEvent {
  return {
    event_id: generateId('evt_'),
    event_type: 'LLM_CALL',
    timestamp: nowIso(),
    duration_ms: 100,
    model: 'gpt-4o',
    provider: 'openai',
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.001,
    stream: false,
    config_applied: false,
    ...overrides,
  };
}

function makeGuard(
  policyOverrides: Partial<RecoveryPolicy> = {},
  healthCheck?: () => void | Promise<void>,
): { guard: ConfigGuard; store: ConfigStore } {
  const store = new ConfigStore();
  store.registerSection('test', {
    temperature: { name: 'temperature', type: 'number', default: 0.7, ge: 0.0, le: 2.0 },
  });
  const registry = new TunableRegistry();
  const guard = new ConfigGuard(store, registry, policyOverrides, healthCheck);
  return { guard, store };
}

// ---------------------------------------------------------------------------
// Fix 1: Auto-refresh timer cleared on shutdown()
// ---------------------------------------------------------------------------

describe('Fix 1: Tunable auto-refresh timer cleanup on shutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
    // Clear the auto-refresh callback to avoid cross-test contamination
    _setAutoRefreshCallback(null);
  });

  it('clears auto-refresh timer so it does not fire after shutdown', async () => {
    vi.useFakeTimers();

    // Install a spy as the auto-refresh callback
    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    _setAutoRefreshCallback(refreshSpy);

    // Dynamically import tunable to get the live module-level state
    const { tune, clearAutoRefreshTimer } = await import('@/tunable/tunable.js');

    // tune() schedules the auto-refresh timer
    const target = { x: 1 };
    tune({ target, namespace: 'fix1-test', fields: { x: 'number' } });

    // Clear the timer (simulating what shutdown() should call)
    clearAutoRefreshTimer();

    // Advance timers past the debounce period — callback must NOT fire
    vi.runAllTimers();

    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('auto-refresh callback fires normally when timer is NOT cleared', async () => {
    vi.useFakeTimers();

    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    _setAutoRefreshCallback(refreshSpy);

    const { tune } = await import('@/tunable/tunable.js');

    const target = { x: 1 };
    tune({ target, namespace: 'fix1-test-fires', fields: { x: 'number' } });

    // Advance past the 50ms debounce without clearing
    vi.runAllTimers();

    expect(refreshSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Fix 2: ConfigGuard async health check rollback
// ---------------------------------------------------------------------------

describe('Fix 2: ConfigGuard async health check rollback', () => {
  it('rolls back config if async health check rejects', async () => {
    const asyncHealthCheck = vi.fn().mockRejectedValue(new Error('unhealthy'));

    const { guard, store } = makeGuard({}, asyncHealthCheck);

    // Read initial value (should be the default)
    const before = store.get('test', 'temperature');

    // Apply a new value — health check will reject
    const result = await guard.safeApply('test', { temperature: 1.5 });

    // Should indicate failure and rollback
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);

    // Config must be restored to the pre-apply value
    const after = store.get('test', 'temperature');
    expect(after).toEqual(before);
  });

  it('keeps config if async health check resolves', async () => {
    const asyncHealthCheck = vi.fn().mockResolvedValue(undefined);

    const { guard, store } = makeGuard({}, asyncHealthCheck);

    const result = await guard.safeApply('test', { temperature: 1.2 });

    expect(result.success).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(store.get('test', 'temperature')).toBe(1.2);
  });

  it('returns SafeApplyResult with rolledBack=false on synchronous success (no regression)', () => {
    const syncHealthCheck = vi.fn(); // sync, no throw

    const { guard } = makeGuard({}, syncHealthCheck);
    const result = guard.safeApply('test', { temperature: 0.5 });

    // sync path returns synchronously — not a Promise
    expect(result instanceof Promise).toBe(false);
    expect((result as import('@/config/guard').SafeApplyResult).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: Emitter retry limit
// ---------------------------------------------------------------------------

describe('Fix 3: Emitter retry limit (drop after 3 retries)', () => {
  let sessionStore: SessionStore;

  beforeEach(() => {
    sessionStore = new SessionStore();
  });

  it('drops a QueuedEvent that has already been retried 3 times', () => {
    const emitter = new Emitter(makeConfig({ offline: false }), sessionStore);

    // Use _requeue to push an event that already hit max retries
    // We access the private method via casting to inspect the internal queue
    const event = makeEvent();
    const queuedWithMaxRetries = { event, sessionId: 'ses_test', _syrinRetry: 3 };

    // Force the item into the requeue path directly
    (emitter as unknown as { _requeue: (batch: unknown[]) => void })._requeue([queuedWithMaxRetries]);

    // The event should be dropped — queue size must be 0
    expect(emitter.queueSize()).toBe(0);
  });

  it('requeues a fresh event with _syrinRetry incremented to 1', () => {
    const emitter = new Emitter(makeConfig({ offline: false }), sessionStore);

    const event = makeEvent();
    const freshQueued = { event, sessionId: 'ses_test' };

    (emitter as unknown as { _requeue: (batch: unknown[]) => void })._requeue([freshQueued]);

    expect(emitter.queueSize()).toBe(1);
    // Verify retry counter was set
    const queue = (emitter as unknown as { queue: Array<{ _syrinRetry?: number }> }).queue;
    expect(queue[0]._syrinRetry).toBe(1);
  });

  it('increments _syrinRetry on subsequent requeue calls', () => {
    const emitter = new Emitter(makeConfig({ offline: false }), sessionStore);

    const event = makeEvent();
    let queued: unknown = { event, sessionId: 'ses_test' };

    const _requeue = (emitter as unknown as { _requeue: (batch: unknown[]) => void })._requeue.bind(emitter);

    _requeue([queued]);
    queued = (emitter as unknown as { queue: unknown[] }).queue.shift();

    _requeue([queued]);
    queued = (emitter as unknown as { queue: unknown[] }).queue.shift();

    _requeue([queued]);

    // After 3 requeue calls (_syrinRetry would be 3), it should be dropped
    expect(emitter.queueSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 4: Double-patching prevention in registerAdapter()
// ---------------------------------------------------------------------------

describe('Fix 4: Double-patching prevention in registerAdapter()', () => {
  it('does not call install() a second time if adapter is already installed', async () => {
    const { SyrinSDKCore } = await import('@/core/engine.js');
    const { Emitter } = await import('@/observability/emitter.js');
    const { SessionStore } = await import('@/core/session.js');
    const { OTelBridge } = await import('@/observability/otel.js');
    const { CheckpointClient } = await import('@/core/checkpoint.js');

    const config = makeConfig();
    const ss = new SessionStore();
    const em = new Emitter(config, ss);
    const otel = new OTelBridge(config);
    const cp = new CheckpointClient(config);
    const core = new SyrinSDKCore(config, ss, em, otel, cp);

    let installCount = 0;
    let installed = false;

    const mockAdapter = {
      name: 'mock-adapter',
      install: vi.fn(async () => { installCount++; installed = true; }),
      uninstall: vi.fn(() => { installed = false; }),
      isInstalled: vi.fn(() => installed),
      configSchema: vi.fn(() => ({})),
    };

    // First registration — should call install()
    await core.registerAdapter(mockAdapter);
    expect(mockAdapter.install).toHaveBeenCalledTimes(1);

    // Second registration of the same adapter — should NOT call install() again
    await core.registerAdapter(mockAdapter);
    expect(mockAdapter.install).toHaveBeenCalledTimes(1);

    core.uninstallAll();
  });

  it('installs a different adapter instance of the same class (separate isInstalled state)', async () => {
    const { SyrinSDKCore } = await import('@/core/engine.js');
    const { Emitter } = await import('@/observability/emitter.js');
    const { SessionStore } = await import('@/core/session.js');
    const { OTelBridge } = await import('@/observability/otel.js');
    const { CheckpointClient } = await import('@/core/checkpoint.js');

    const config = makeConfig();
    const ss = new SessionStore();
    const em = new Emitter(config, ss);
    const otel = new OTelBridge(config);
    const cp = new CheckpointClient(config);
    const core = new SyrinSDKCore(config, ss, em, otel, cp);

    // Adapter A — not yet installed
    const adapterA = {
      name: 'fresh-adapter',
      install: vi.fn(async () => {}),
      uninstall: vi.fn(),
      isInstalled: vi.fn(() => false), // NOT installed
      configSchema: vi.fn(() => ({})),
    };

    await core.registerAdapter(adapterA);
    // isInstalled() returns false → install() should be called
    expect(adapterA.install).toHaveBeenCalledTimes(1);

    core.uninstallAll();
  });
});
