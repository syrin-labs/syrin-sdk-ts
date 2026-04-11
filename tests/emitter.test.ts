/**
 * Tests: src/emitter.ts
 *
 * Uses msw to mock HTTP calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { SyrinSDKConfig, SyrinEvent, IngestPayload } from '@/types';
import { Emitter } from '@/observability/emitter';
import { SessionStore } from '@/core/session';
import { generateId, nowIso } from '@/utils/helpers';

// Mock server
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeConfig(overrides: Partial<SyrinSDKConfig> = {}): SyrinSDKConfig {
  return {
    apiKey: 'syrin_test_key',
    backendUrl: 'http://localhost:4399',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4399',
    debug: false,
    captureContent: false,
    offline: false,
    batchIntervalMs: 60000, // Large so it doesn't auto-fire
    batchSize: 50,
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

describe('Emitter: batching and flushing', () => {
  let config: SyrinSDKConfig;
  let sessionStore: SessionStore;
  let emitter: Emitter;

  beforeEach(() => {
    config = makeConfig();
    sessionStore = new SessionStore();
    emitter = new Emitter(config, sessionStore);
  });

  afterEach(async () => {
    await emitter.stop();
    vi.restoreAllMocks();
  });

  it('flush() sends the correct JSON shape to /ingest', async () => {
    let capturedPayload: IngestPayload | null = null;

    server.use(
      http.post('http://localhost:4399/ingest', async ({ request }) => {
        capturedPayload = (await request.json()) as IngestPayload;
        return HttpResponse.json({ ok: true });
      })
    );

    const sessionId = 'test-session-123';
    await sessionStore.getOrCreate(sessionId, 'agent-abc');

    const event = makeEvent();
    emitter.emit(event, sessionId);

    await emitter.flush();

    expect(capturedPayload).not.toBeNull();
    expect((capturedPayload as Record<string, unknown>)['api_key']).toBeUndefined();
    expect(capturedPayload!.session_id).toBe(sessionId);
    expect(capturedPayload!.sdk.language).toBe('typescript');
    expect(typeof capturedPayload!.sdk.version).toBe('string');
    expect(Array.isArray(capturedPayload!.events)).toBe(true);
    expect(capturedPayload!.events).toHaveLength(1);
    expect(capturedPayload!.events[0]!.event_id).toBe(event.event_id);
  });

  it('batches multiple events in a single flush', async () => {
    let capturedPayload: IngestPayload | null = null;

    server.use(
      http.post('http://localhost:4399/ingest', async ({ request }) => {
        capturedPayload = (await request.json()) as IngestPayload;
        return HttpResponse.json({ ok: true });
      })
    );

    const sessionId = 'batch-session';
    await sessionStore.getOrCreate(sessionId);

    for (let i = 0; i < 5; i++) {
      emitter.emit(makeEvent({ event_id: `evt_${i}` }), sessionId);
    }

    await emitter.flush();

    expect(capturedPayload!.events).toHaveLength(5);
  });

  it('applies config_updates from backend response to session', async () => {
    server.use(
      http.post('http://localhost:4399/ingest', () => {
        return HttpResponse.json({
          ok: true,
          config_updates: { temperature: 0.3, max_tokens: 500 },
        });
      })
    );

    const sessionId = 'config-update-session';
    await sessionStore.getOrCreate(sessionId);

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    // Config should be applied to the session
    const session = sessionStore.getSession(sessionId);
    expect(session?.activeConfig['temperature']).toBe(0.3);
    expect(session?.activeConfig['max_tokens']).toBe(500);
  });

  it('requeues events on backend 500 error', async () => {
    let callCount = 0;

    server.use(
      http.post('http://localhost:4399/ingest', () => {
        callCount++;
        if (callCount === 1) {
          return new HttpResponse(null, { status: 500 });
        }
        return HttpResponse.json({ ok: true });
      })
    );

    const sessionId = 'requeue-session';
    await sessionStore.getOrCreate(sessionId);

    emitter.emit(makeEvent(), sessionId);

    // First flush fails — events should be requeued
    await emitter.flush();
    expect(callCount).toBe(1);

    // Second flush should succeed with the requeued events
    await emitter.flush();
    expect(callCount).toBe(2);
  });

  it('does NOT make HTTP calls when offline=true', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const offlineConfig = makeConfig({ offline: true });
    const offlineEmitter = new Emitter(offlineConfig, sessionStore);

    const sessionId = 'offline-session';
    await sessionStore.getOrCreate(sessionId);

    offlineEmitter.emit(makeEvent(), sessionId);
    await offlineEmitter.flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('stop() flushes remaining events before stopping', async () => {
    let capturedPayload: IngestPayload | null = null;

    server.use(
      http.post('http://localhost:4399/ingest', async ({ request }) => {
        capturedPayload = (await request.json()) as IngestPayload;
        return HttpResponse.json({ ok: true });
      })
    );

    const sessionId = 'stop-flush-session';
    await sessionStore.getOrCreate(sessionId);

    emitter.emit(makeEvent(), sessionId);
    emitter.emit(makeEvent(), sessionId);

    // stop() should flush the 2 pending events
    await emitter.stop();

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload!.events).toHaveLength(2);
  });

  it('handles network errors gracefully by requeuing events', async () => {
    server.use(
      http.post('http://localhost:4399/ingest', () => {
        return HttpResponse.error();
      })
    );

    const sessionId = 'network-error-session';
    await sessionStore.getOrCreate(sessionId);

    const event = makeEvent();
    emitter.emit(event, sessionId);

    // Should not throw
    await expect(emitter.flush()).resolves.not.toThrow();
  });

  it('auto-flushes when batch size is reached', async () => {
    let flushCalled = false;

    server.use(
      http.post('http://localhost:4399/ingest', () => {
        flushCalled = true;
        return HttpResponse.json({ ok: true });
      })
    );

    const smallBatchConfig = makeConfig({ batchSize: 3 });
    const smallBatchEmitter = new Emitter(smallBatchConfig, sessionStore);

    const sessionId = 'auto-flush-session';
    await sessionStore.getOrCreate(sessionId);

    // Emit 3 events — should trigger auto-flush
    smallBatchEmitter.emit(makeEvent(), sessionId);
    smallBatchEmitter.emit(makeEvent(), sessionId);
    smallBatchEmitter.emit(makeEvent(), sessionId);

    // Give the auto-flush a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(flushCalled).toBe(true);
    await smallBatchEmitter.stop();
  });

  it('does not flush when queue is empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await emitter.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
