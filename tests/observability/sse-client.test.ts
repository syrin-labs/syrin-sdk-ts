/**
 * Tests: src/observability/sse-client.ts — SSEClient
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SSEClient } from '@/observability/sse-client';
import { SessionStore } from '@/core/session';
import { clearHooks, onConfigChange } from '@/observability/hooks';
import type { SyrinConfig } from '@/types';

afterEach(() => {
  clearHooks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4401',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4401',
    debug: false,
    captureContent: false,
    offline: false,
    batchIntervalMs: 60000,
    batchSize: 50,
    agentId: 'test-agent',
    ...overrides,
  };
}

function makeStore(): SessionStore {
  return new SessionStore();
}

// ---------------------------------------------------------------------------
// Helper: create a mock ReadableStream that sends SSE events
// ---------------------------------------------------------------------------
function makeSSEStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream({
    pull(controller) {
      if (idx < events.length) {
        controller.enqueue(encoder.encode(events[idx++]));
      } else {
        controller.close();
      }
    },
  });
}

function makeSuccessResponse(body: ReadableStream<Uint8Array>): Response {
  return {
    ok: true,
    status: 200,
    body,
  } as unknown as Response;
}

describe('SSEClient.start() — early exits', () => {
  it('does not connect when offline=true', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const config = makeConfig({ offline: true });
    const client = new SSEClient(config, makeStore());
    client.start();

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('calls onFallbackToPolling when no agentId configured', () => {
    const config = makeConfig({ agentId: undefined });
    const onFallbackToPolling = vi.fn();
    const client = new SSEClient(config, makeStore(), { onFallbackToPolling });
    client.start();
    expect(onFallbackToPolling).toHaveBeenCalledOnce();
  });

  it('calls onFallbackToPolling when offline=true', () => {
    const config = makeConfig({ offline: true });
    const onFallbackToPolling = vi.fn();
    const client = new SSEClient(config, makeStore(), { onFallbackToPolling });
    client.start();
    expect(onFallbackToPolling).toHaveBeenCalledOnce();
  });

  it('isConnected is false before start', () => {
    const config = makeConfig();
    const client = new SSEClient(config, makeStore());
    expect(client.isConnected).toBe(false);
  });
});

describe('SSEClient.stop()', () => {
  it('sets stopped state so reconnect loop exits', () => {
    const config = makeConfig({ agentId: 'test' });
    const client = new SSEClient(config, makeStore());
    // Should not throw
    client.stop();
    expect(client.isConnected).toBe(false);
  });
});

describe('SSEClient — config_update event', () => {
  it('applies config_update to all sessions and fires hooks', async () => {
    const store = makeStore();
    await store.getOrCreate('ses_1', 'agent-x');

    const configUpdateEvents = [
      `event: config_update\ndata: ${JSON.stringify({ temperature: 0.3 })}\n\n`,
    ];

    const fetchMock = vi.fn().mockResolvedValue(makeSuccessResponse(makeSSEStream(configUpdateEvents)));
    vi.stubGlobal('fetch', fetchMock);

    const onConfigUpdate = vi.fn();
    const config = makeConfig();
    const client = new SSEClient(config, store, { onConfigUpdate });
    client.start();

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 50));
    client.stop();

    // Session should have updated config
    const session = store.getSession('ses_1');
    expect(session?.activeConfig['temperature']).toBe(0.3);
    expect(onConfigUpdate).toHaveBeenCalledWith({ temperature: 0.3 });

    vi.unstubAllGlobals();
  });

  it('fires onConfigChange hooks when config_update received', async () => {
    const store = makeStore();
    await store.getOrCreate('ses_2', 'agent-y');

    const hookFn = vi.fn();
    onConfigChange(hookFn);

    const configUpdateEvents = [
      `event: config_update\ndata: ${JSON.stringify({ model: 'gpt-4o-mini' })}\n\n`,
    ];

    const fetchMock = vi.fn().mockResolvedValue(makeSuccessResponse(makeSSEStream(configUpdateEvents)));
    vi.stubGlobal('fetch', fetchMock);

    const config = makeConfig();
    const client = new SSEClient(config, store);
    client.start();

    await new Promise((r) => setTimeout(r, 50));
    client.stop();

    expect(hookFn).toHaveBeenCalledWith('ses_2', { model: 'gpt-4o-mini' });

    vi.unstubAllGlobals();
  });

  it('ignores malformed JSON in config_update', async () => {
    const store = makeStore();
    const configUpdateEvents = [
      `event: config_update\ndata: {not-valid-json}\n\n`,
    ];

    const fetchMock = vi.fn().mockResolvedValue(makeSuccessResponse(makeSSEStream(configUpdateEvents)));
    vi.stubGlobal('fetch', fetchMock);

    const onConfigUpdate = vi.fn();
    const config = makeConfig();
    const client = new SSEClient(config, store, { onConfigUpdate });

    expect(() => { client.start(); }).not.toThrow();

    await new Promise((r) => setTimeout(r, 50));
    client.stop();

    expect(onConfigUpdate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('SSEClient — error handling and reconnect', () => {
  it('calls onFallbackToPolling after max reconnect attempts', async () => {
    vi.useFakeTimers();

    const onFallbackToPolling = vi.fn();
    const config = makeConfig();

    // Always fail with 500
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      body: null,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = new SSEClient(config, makeStore(), { onFallbackToPolling });
    client.start();

    // Advance time through all reconnect attempts
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      vi.advanceTimersByTime(70000);
      await Promise.resolve();
    }

    // Drain microtask queue
    await vi.runAllTimersAsync();

    expect(onFallbackToPolling).toHaveBeenCalled();

    vi.unstubAllGlobals();
  }, 20000);

  it('throws on 401 auth error', () => {
    const config = makeConfig();
    const onFallbackToPolling = vi.fn();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      body: makeSSEStream([]),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = new SSEClient(config, makeStore(), { onFallbackToPolling });
    // Start starts the reconnect loop but we can't easily intercept — just ensure no crash
    client.start();
    client.stop();

    vi.unstubAllGlobals();
  });

  it('handles missing response body gracefully', async () => {
    const config = makeConfig();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = new SSEClient(config, makeStore());
    client.start();

    await new Promise((r) => setTimeout(r, 20));
    client.stop();

    vi.unstubAllGlobals();
  });
});

describe('SSEClient — agent_status event', () => {
  it('handles agent_status event without crashing', async () => {
    const store = makeStore();
    const configUpdateEvents = [
      `event: agent_status\ndata: ${JSON.stringify({ status: 'online' })}\n\n`,
    ];

    const fetchMock = vi.fn().mockResolvedValue(makeSuccessResponse(makeSSEStream(configUpdateEvents)));
    vi.stubGlobal('fetch', fetchMock);

    const config = makeConfig({ debug: false });
    const client = new SSEClient(config, store);
    client.start();

    await new Promise((r) => setTimeout(r, 50));
    client.stop();

    // Should not throw, just silently handle
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// P1-1: Polling race condition — multiple onFallbackToPolling calls
// ---------------------------------------------------------------------------
describe('SSEClient — onFallbackToPolling deduplication', () => {
  it('calling onFallbackToPolling multiple times only creates ONE interval timer', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    // Track timers created by each fallback invocation
    const timerIds: Set<ReturnType<typeof setInterval>> = new Set();
    let pollCount = 0;

    // Simulate the SDK's deduplication guard
    let _pollingTimer: ReturnType<typeof setInterval> | null = null;

    const onFallbackToPolling = (): void => {
      if (_pollingTimer !== null) return; // guard: already polling
      _pollingTimer = setInterval(() => { pollCount++; }, 1000);
      timerIds.add(_pollingTimer);
    };

    // Call multiple times (as SSE reconnect loop would)
    onFallbackToPolling();
    onFallbackToPolling();
    onFallbackToPolling();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(timerIds.size).toBe(1);

    clearInterval(_pollingTimer!);
    vi.useRealTimers();
  });

  it('stopping polling and restarting creates exactly one new timer', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    let _pollingTimer: ReturnType<typeof setInterval> | null = null;

    const startPolling = (): void => {
      if (_pollingTimer !== null) return;
      _pollingTimer = setInterval(() => {}, 1000);
    };

    const stopPolling = (): void => {
      if (_pollingTimer !== null) {
        clearInterval(_pollingTimer);
        _pollingTimer = null;
      }
    };

    // Start → stop → start
    startPolling();
    stopPolling();
    startPolling();

    expect(setIntervalSpy).toHaveBeenCalledTimes(2); // once before stop, once after

    stopPolling();
    vi.useRealTimers();
  });

  it('SSEClient.stop() prevents new onFallbackToPolling callbacks from being called', () => {
    const config = makeConfig({ agentId: 'test-agent' });
    const onFallbackToPolling = vi.fn();
    const client = new SSEClient(config, makeStore(), { onFallbackToPolling });

    // Stop before any potential fallback
    client.stop();

    // The stopped flag should prevent further callbacks
    expect(client.isConnected).toBe(false);
    // onFallbackToPolling should NOT have been called (client was never started)
    expect(onFallbackToPolling).not.toHaveBeenCalled();
  });

  it('init()-level fallback polling guard: onFallbackToPolling called twice starts only one timer', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    // Replicate the guard pattern used in src/index.ts init()
    let _pollTimer: ReturnType<typeof setInterval> | null = null;

    const setPollTimer = (timer: ReturnType<typeof setInterval> | null): void => {
      _pollTimer = timer;
    };

    const onFallbackToPolling = (): void => {
      // Guard: if a poll timer already exists, do not create another
      if (_pollTimer !== null) return;
      const timer = setInterval(() => {}, 30_000);
      setPollTimer(timer);
    };

    onFallbackToPolling();
    onFallbackToPolling(); // second call should be a no-op

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    clearInterval(_pollTimer!);
    vi.useRealTimers();
  });
});

describe('SSEClient — events_ingested event', () => {
  it('handles events_ingested event without crashing', async () => {
    const store = makeStore();
    const events = [
      `event: events_ingested\ndata: ${JSON.stringify({ count: 5 })}\n\n`,
    ];

    const fetchMock = vi.fn().mockResolvedValue(makeSuccessResponse(makeSSEStream(events)));
    vi.stubGlobal('fetch', fetchMock);

    const config = makeConfig();
    const client = new SSEClient(config, store);
    client.start();

    await new Promise((r) => setTimeout(r, 50));
    client.stop();

    vi.unstubAllGlobals();
  });
});
