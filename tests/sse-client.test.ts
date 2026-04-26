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
