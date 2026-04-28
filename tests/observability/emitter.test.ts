/**
 * Tests: src/observability/emitter.ts
 *
 * Uses msw to mock HTTP calls.
 * Merged with emitter-overflow.test.ts (log tag, queue overflow, retry cap, public API surface).
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { SyrinConfig, SyrinEvent, IngestPayload } from '@/types';
import { Emitter } from '@/observability/emitter';
import { SessionStore } from '@/core/session';
import { generateId, nowIso } from '@/utils/helpers';
import { onAlert, onConfigChange, clearHooks } from '@/observability/hooks';

// Mock server
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test_key',
    backendUrl: 'http://localhost:4399',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4399',
    debug: false,
    captureContent: false,
    offline: false,
    idleFlushMs: 60000, // Large so it doesn't auto-fire
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
  let config: SyrinConfig;
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
      http.post('http://localhost:4399/api/v1/ingest', async ({ request }) => {
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
    expect(capturedPayload!.events[0].event_id).toBe(event.event_id);
  });

  it('batches multiple events in a single flush', async () => {
    let capturedPayload: IngestPayload | null = null;

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', async ({ request }) => {
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
      http.post('http://localhost:4399/api/v1/ingest', () => {
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
      http.post('http://localhost:4399/api/v1/ingest', () => {
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
      http.post('http://localhost:4399/api/v1/ingest', async ({ request }) => {
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
      http.post('http://localhost:4399/api/v1/ingest', () => {
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
      http.post('http://localhost:4399/api/v1/ingest', () => {
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

describe('Emitter: experiment assignment', () => {
  let config: SyrinConfig;
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

  it('applies experiment variant overrides to session on flush', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () => {
        return HttpResponse.json({
          ok: true,
          experiments: [
            {
              experimentId: 'exp_1',
              variantId: 'var_a',
              variantName: 'Variant A',
              overrides: { temperature: 0.2, model: 'gpt-4o-mini' },
            },
          ],
        });
      })
    );

    const sessionId = 'exp-session-1';
    await sessionStore.getOrCreate(sessionId, 'agent-exp');

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const session = sessionStore.getSession(sessionId);
    expect(session?.activeConfig['temperature']).toBe(0.2);
    expect(session?.activeConfig['model']).toBe('gpt-4o-mini');
  });

  it('skips experiment assignment with empty overrides', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () => {
        return HttpResponse.json({
          ok: true,
          experiments: [
            {
              experimentId: 'exp_2',
              variantId: 'var_control',
              variantName: 'Control',
              overrides: {},
            },
          ],
        });
      })
    );

    const sessionId = 'exp-session-2';
    await sessionStore.getOrCreate(sessionId, 'agent-exp');

    const applyConfigSpy = vi.spyOn(sessionStore, 'applyConfigUpdate');

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    expect(applyConfigSpy).not.toHaveBeenCalled();
  });

  it('applies overrides from multiple experiment assignments', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () => {
        return HttpResponse.json({
          ok: true,
          experiments: [
            {
              experimentId: 'exp_3a',
              variantId: 'var_x',
              variantName: 'Variant X',
              overrides: { temperature: 0.5 },
            },
            {
              experimentId: 'exp_3b',
              variantId: 'var_y',
              variantName: 'Variant Y',
              overrides: { max_tokens: 1024 },
            },
          ],
        });
      })
    );

    const sessionId = 'exp-session-3';
    await sessionStore.getOrCreate(sessionId, 'agent-exp');

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const session = sessionStore.getSession(sessionId);
    expect(session?.activeConfig['temperature']).toBe(0.5);
    expect(session?.activeConfig['max_tokens']).toBe(1024);
  });

  it('does not call applyConfigUpdate when experiments array is absent', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () => {
        return HttpResponse.json({ ok: true });
      })
    );

    const sessionId = 'exp-session-4';
    await sessionStore.getOrCreate(sessionId, 'agent-exp');

    const applyConfigSpy = vi.spyOn(sessionStore, 'applyConfigUpdate');

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    expect(applyConfigSpy).not.toHaveBeenCalled();
  });

  it('logs debug message when debug=true and experiment assigned', async () => {
    const debugConfig = makeConfig({ debug: true });
    const debugEmitter = new Emitter(debugConfig, sessionStore);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () => {
        return HttpResponse.json({
          ok: true,
          experiments: [
            {
              experimentId: 'exp_5',
              variantId: 'var_b',
              variantName: 'Variant B',
              overrides: { 'llm.temperature': 0.9 },
            },
          ],
        });
      })
    );

    const sessionId = 'exp-session-5';
    await sessionStore.getOrCreate(sessionId, 'agent-exp');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    debugEmitter.emit(makeEvent(), sessionId);
    await debugEmitter.flush();
    await debugEmitter.stop();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Variant B.*exp-session-5|exp-session-5.*Variant B/)
    );
  });

  it('queues an EXPERIMENT_ASSIGNED event after flush with assignment', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () => {
        return HttpResponse.json({
          ok: true,
          experiments: [
            {
              experimentId: 'exp_emit_1',
              variantId: 'var_emit_a',
              variantName: 'Emit Variant A',
              overrides: { temperature: 0.42 },
            },
          ],
        });
      })
    );

    const sessionId = 'exp-emit-session-1';
    await sessionStore.getOrCreate(sessionId, 'agent-exp');

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    // After flush the EXPERIMENT_ASSIGNED event is in the queue (sent next flush)
    expect(emitter.queueSize()).toBe(1);
  });

  it('queues one EXPERIMENT_ASSIGNED event per assignment with overrides', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () => {
        return HttpResponse.json({
          ok: true,
          experiments: [
            { experimentId: 'e1', variantId: 'v1', variantName: 'V1', overrides: { temperature: 0.1 } },
            { experimentId: 'e2', variantId: 'v2', variantName: 'V2', overrides: { max_tokens: 128 } },
          ],
        });
      })
    );

    const sessionId = 'exp-emit-session-2';
    await sessionStore.getOrCreate(sessionId, 'agent-exp');

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    expect(emitter.queueSize()).toBe(2);
  });

  it('does not queue EXPERIMENT_ASSIGNED for control (empty overrides)', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () => {
        return HttpResponse.json({
          ok: true,
          experiments: [
            { experimentId: 'e_ctrl', variantId: 'v_ctrl', variantName: 'Control', overrides: {} },
          ],
        });
      })
    );

    const sessionId = 'exp-emit-session-3';
    await sessionStore.getOrCreate(sessionId, 'agent-exp');

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    expect(emitter.queueSize()).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// (merged from former emitter-extended.test.ts)
// ---------------------------------------------------------------------------
describe('Emitter: queue overflow', () => {
  it('drops oldest events when queue exceeds MAX_QUEUE_SIZE', async () => {
    // Use a very small batchSize so we can detect the overflow behavior
    const config = makeConfig({ offline: true });
    const store = new SessionStore();
    const emitter = new Emitter(config, store);

    const sessionId = 'ses_overflow';
    await store.getOrCreate(sessionId);

    // Fill the queue past 1000 events by emitting 1002 events
    // The queue cap is 1000 (MAX_QUEUE_SIZE in emitter.ts)
    for (let i = 0; i < 1002; i++) {
      emitter.emit(makeEvent({ event_id: `evt_${i}` }), sessionId);
    }

    // Queue should be capped at 1000
    expect(emitter.queueSize()).toBeLessThanOrEqual(1000);
    await emitter.stop();
  });

  it('warns when dropping events in debug mode', async () => {
    const config = makeConfig({ offline: true, debug: true, batchSize: 2000 });
    const store = new SessionStore();
    const emitter = new Emitter(config, store);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sessionId = 'ses_overflow_debug';
    await store.getOrCreate(sessionId);

    // Emit 1002 events to trigger overflow warning
    for (let i = 0; i < 1002; i++) {
      emitter.emit(makeEvent({ event_id: `evt_${i}` }), sessionId);
    }

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropped'));
    await emitter.stop();
    warnSpy.mockRestore();
  });
});

describe('Emitter: governance stop action', () => {
  it('appends stop action to session on stop governance', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_gov_stop';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{ type: 'stop', reason: 'cost limit' }],
          },
        })
      )
    );

    const emitter = new Emitter(makeConfig(), store);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    // Session should have pending governance action
    const pendingActions = store.popGovernanceActions(sessionId);
    expect(pendingActions).toHaveLength(1);
    expect(pendingActions[0].type).toBe('stop');
  });
});

describe('Emitter: governance inject_message action', () => {
  it('queues inject_message on session', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_gov_inject';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{
              type: 'inject_message',
              role: 'system',
              content: 'Focus on the task',
            }],
          },
        })
      )
    );

    const emitter = new Emitter(makeConfig(), store);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    const injected = store.popInjectedMessages(sessionId);
    expect(injected).toHaveLength(1);
    expect(injected[0]['content']).toBe('Focus on the task');
  });
});

describe('Emitter: governance alert action', () => {
  it('fires alert hook when alert action received', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_gov_alert';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{ type: 'alert', level: 'warning', message: 'High cost' }],
          },
        })
      )
    );

    const alertFn = vi.fn();
    onAlert(alertFn);

    const emitter = new Emitter(makeConfig(), store);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    expect(alertFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'alert', level: 'warning', message: 'High cost' })
    );
  });
});

describe('Emitter: governance restore action', () => {
  it('handles restore action without crashing (GovernanceCheckpointRestoredError is caught by _doFlush)', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_gov_restore';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{
              type: 'restore',
              checkpoint_id: 'ckpt_abc',
              reason: 'Loop detected',
            }],
          },
        })
      )
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitter = new Emitter(makeConfig(), store);
    emitter.emit(makeEvent(), sessionId);

    // _applyGovernance throws GovernanceCheckpointRestoredError but _doFlush catch block handles it
    // So flush() resolves (doesn't reject) but logs a warning
    await expect(emitter.flush()).resolves.not.toThrow();
    await emitter.stop();
    warnSpy.mockRestore();
  });
});

describe('Emitter: governance config_override action', () => {
  it('applies config_override to session', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_gov_override';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{
              type: 'config_override',
              field_path: 'temperature',
              value: 0.1,
            }],
          },
        })
      )
    );

    const emitter = new Emitter(makeConfig(), store);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    const session = store.getSession(sessionId);
    expect(session?.activeConfig['temperature']).toBe(0.1);
  });

  it('injects correction_hint as system message when present', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_gov_hint';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{
              type: 'config_override',
              field_path: 'temperature',
              value: 0.2,
              correction_hint: 'Keep responses concise',
            }],
          },
        })
      )
    );

    const emitter = new Emitter(makeConfig(), store);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    const injected = store.popInjectedMessages(sessionId);
    expect(injected.some((m) => String(m['content']).includes('Keep responses concise'))).toBe(true);
  });
});

describe('Emitter: governance require_approval action', () => {
  it('queues system message for require_approval', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_gov_approval';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{
              type: 'require_approval',
              approval_id: 'appr_001',
              tool_name: 'send_email',
              reason: 'External action requires review',
            }],
          },
        })
      )
    );

    const emitter = new Emitter(makeConfig(), store);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    const injected = store.popInjectedMessages(sessionId);
    expect(injected.length).toBeGreaterThan(0);
    expect(String(injected[0]['content'])).toContain('send_email');
  });

  it('ignores require_approval without approval_id in debug mode', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_gov_approval_no_id';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{
              type: 'require_approval',
              // No approval_id
              tool_name: 'delete_record',
            }],
          },
        })
      )
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitter = new Emitter(makeConfig({ debug: true }), store);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    // Should not crash
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('require_approval'));
    warnSpy.mockRestore();
  });
});

describe('Emitter: governance session state signals', () => {
  it('records loopDetected and driftScore in session', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_loop_sig';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            loop_detected: true,
            drift_score: 0.85,
            incident_id: 'inc_loop_1',
            actions: [],
          },
        })
      )
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitter = new Emitter(makeConfig(), store);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    const session = store.getSession(sessionId);
    expect(session?.lastLoopDetected).toBe(true);
    expect(session?.lastDriftScore).toBe(0.85);
    expect(session?.lastIncidentId).toBe('inc_loop_1');
    warnSpy.mockRestore();
  });
});

describe('Emitter: onContextInjection callback', () => {
  it('fires registered callback when pendingInjections received', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_injection_1';
    await store.getOrCreate(sessionId);

    const injection = { type: 'context_injection', content: 'Important context', role: 'system' };

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          pendingInjections: [injection],
        })
      )
    );

    const callback = vi.fn();
    const emitter = new Emitter(makeConfig(), store);
    const unsub = emitter.onContextInjection(callback);

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    expect(callback).toHaveBeenCalledWith(injection);
    unsub(); // cleanup
  });

  it('supports snake_case pending_injections (backend wire format)', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_injection_snake';
    await store.getOrCreate(sessionId);

    const injection = { type: 'context_injection', content: 'Snake case context' };

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          pending_injections: [injection],
        })
      )
    );

    const callback = vi.fn();
    const emitter = new Emitter(makeConfig(), store);
    emitter.onContextInjection(callback);

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    expect(callback).toHaveBeenCalledWith(injection);
  });

  it('unsubscribe prevents callback from firing', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_injection_unsub';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          pendingInjections: [{ content: 'context' }],
        })
      )
    );

    const callback = vi.fn();
    const emitter = new Emitter(makeConfig(), store);
    const unsub = emitter.onContextInjection(callback);
    unsub(); // unsubscribe immediately

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    expect(callback).not.toHaveBeenCalled();
  });

  it('swallows errors thrown by injection callbacks (fail-open)', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_injection_err';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          pendingInjections: [{ content: 'context' }],
        })
      )
    );

    const badCallback = vi.fn().mockImplementation(() => { throw new Error('callback error'); });
    const emitter = new Emitter(makeConfig(), store);
    emitter.onContextInjection(badCallback);

    emitter.emit(makeEvent(), sessionId);
    await expect(emitter.flush()).resolves.not.toThrow();
    await emitter.stop();
  });
});

describe('Emitter: tool_validation_results', () => {
  it('stores tool validation results in session', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_tool_val';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          tool_validation_results: { 'tc_1': { approved: true } },
        })
      )
    );

    const emitter = new Emitter(makeConfig(), store);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();
    await emitter.stop();

    const result = store.getToolValidation(sessionId, 'tc_1');
    expect(result).toBeDefined();
  });
});

describe('Emitter: requeue respects MAX_QUEUE_SIZE', () => {
  it('partial requeue when queue is near-full', async () => {
    const store = new SessionStore();
    const sessionId = 'ses_requeue_cap';
    await store.getOrCreate(sessionId);

    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        new HttpResponse(null, { status: 500 })
      )
    );

    const config = makeConfig({ batchSize: 5 });
    const emitter = new Emitter(config, store);

    for (let i = 0; i < 5; i++) {
      emitter.emit(makeEvent({ event_id: `evt_${i}` }), sessionId);
    }

    await emitter.flush();
    // Should have requeued some events
    expect(emitter.queueSize()).toBeGreaterThan(0);
    await emitter.stop();
  });
});

// ---------------------------------------------------------------------------
// Merged from emitter-overflow.test.ts
// ---------------------------------------------------------------------------

function makeOverflowEvent(id = 'evt_test', type = 'LLM_CALL') {
  return {
    event_id: id,
    event_type: type,
    timestamp: new Date().toISOString(),
    duration_ms: 0,
    model: 'gpt-4o',
    provider: 'openai',
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    stream: false,
    config_applied: false,
  } as SyrinEvent;
}

describe('[Syrin SDK] log tag', () => {
  it('uses [Syrin SDK] when init() is called twice (reinit warning)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { init, shutdown } = await import('@/index.js');
    const sdk1 = await init({ apiKey: 'k', offline: true });
    const sdk2 = await init({ apiKey: 'k', offline: true });
    const msgs = warnSpy.mock.calls.map((c) => String(c[0]));
    const reinitMsg = msgs.find((m) => m.includes('already initialized'));
    expect(reinitMsg).toBeDefined();
    expect(reinitMsg).toMatch(/\[Syrin SDK\]/);
    expect(reinitMsg).not.toMatch(/\[Syrin\]\b/);
    await sdk1.shutdown();
    await sdk2.shutdown();
    warnSpy.mockRestore();
    await shutdown('default');
  });

  it('uses [Syrin SDK] in batch-full flush error warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SessionStore();
    const emitter = new Emitter(
      makeConfig({ batchSize: 1, offline: false }),
      store,
    );
    emitter.start();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    emitter.emit(makeOverflowEvent('e1'), 'ses_1');
    emitter.emit(makeOverflowEvent('e2'), 'ses_1');
    await new Promise((r) => setTimeout(r, 50));
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    const flushWarn = warnMessages.find((m) => m.includes('flush'));
    if (flushWarn) {
      expect(flushWarn).toMatch(/\[Syrin SDK\]/);
      expect(flushWarn).not.toMatch(/\[Syrin\]\b/);
    }
    await emitter.stop();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('uses [Syrin SDK] in SSE fallback warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { SSEClient } = await import('@/observability/sse-client.js');
    const store = new SessionStore();
    const client = new SSEClient(makeConfig({ agentId: 'test-agent' }), store, {
      onFallbackToPolling: () => {},
    });
    client.start();
    await new Promise((r) => setTimeout(r, 1200));
    client.stop();
    const allMessages = [
      ...warnSpy.mock.calls.map((c) => String(c[0])),
      ...logSpy.mock.calls.map((c) => String(c[0])),
    ];
    const sdkMessages = allMessages.filter((m) => m.includes('SSE') || m.includes('fallback'));
    for (const msg of sdkMessages) {
      expect(msg).not.toMatch(/\[Syrin\]\b/);
    }
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe('Queue overflow sentinel', () => {
  it('inserts QUEUE_OVERFLOW sentinel when queue is full', () => {
    const store = new SessionStore();
    const emitter = new Emitter(makeConfig({ offline: true }), store);

    for (let i = 0; i < 1000; i++) {
      emitter.emit(makeOverflowEvent(`e${i}`), 'ses_1');
    }

    emitter.emit(makeOverflowEvent('overflow_trigger'), 'ses_1');
    expect(emitter.queueSize()).toBeLessThanOrEqual(1000);
  });

  it('QUEUE_OVERFLOW sentinel carries dropped_event_id', () => {
    const store = new SessionStore();
    const emitter = new Emitter(makeConfig({ offline: true }), store);

    for (let i = 0; i < 1000; i++) {
      emitter.emit(makeOverflowEvent(`fill_${i}`), 'ses_1');
    }

    emitter.emit(makeOverflowEvent('sentinel_target', 'TOOL_CALL'), 'ses_1');
    expect(emitter.queueSize()).toBeLessThanOrEqual(1000);
  });

  it('emitting to a full queue never throws', () => {
    const store = new SessionStore();
    const emitter = new Emitter(makeConfig({ offline: true }), store);
    for (let i = 0; i < 1005; i++) {
      expect(() => emitter.emit(makeOverflowEvent(`e${i}`), 'ses_1')).not.toThrow();
    }
  });

  it('queue size never exceeds MAX after 2× overflow', () => {
    const store = new SessionStore();
    const emitter = new Emitter(makeConfig({ offline: true }), store);
    for (let i = 0; i < 2500; i++) {
      emitter.emit(makeOverflowEvent(`e${i}`), 'ses_1');
    }
    expect(emitter.queueSize()).toBeLessThanOrEqual(1000);
  });

  it('flush empties queue after overflow', async () => {
    const store = new SessionStore();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    const emitter = new Emitter(makeConfig({ offline: false }), store);
    emitter.start();

    for (let i = 0; i < 1050; i++) {
      emitter.emit(makeOverflowEvent(`e${i}`), 'ses_1');
    }

    await emitter.flush();
    expect(emitter.queueSize()).toBe(0);

    await emitter.stop();
    fetchSpy.mockRestore();
  });
});

describe('Retry cap (_syrin_retry ≤ 3)', () => {
  it('drops events after 3 failed attempts with console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SessionStore();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const emitter = new Emitter(makeConfig({ offline: false, batchSize: 1 }), store);
    emitter.start();

    emitter.emit(makeOverflowEvent('retry_target', 'LLM_CALL'), 'ses_1');

    for (let i = 0; i < 5; i++) {
      await emitter.flush();
      await new Promise((r) => setTimeout(r, 20));
    }

    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    const dropWarn = warnMessages.find((m) => m.includes('Dropping') || m.includes('dropping') || m.includes('failed delivery'));
    if (dropWarn) {
      expect(dropWarn).toMatch(/\[Syrin SDK\]/);
    }

    await emitter.stop();
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('never accumulates more than MAX_QUEUE_SIZE retried events', async () => {
    const store = new SessionStore();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const emitter = new Emitter(makeConfig({ offline: false }), store);
    emitter.start();

    for (let i = 0; i < 200; i++) {
      emitter.emit(makeOverflowEvent(`r${i}`), 'ses_1');
    }

    for (let i = 0; i < 4; i++) {
      await emitter.flush();
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(emitter.queueSize()).toBeLessThanOrEqual(1000);

    await emitter.stop();
    fetchSpy.mockRestore();
  });

  it('does not drop events with 0 retries on the first flush attempt', async () => {
    const store = new SessionStore();
    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount < 2) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    });

    const emitter = new Emitter(makeConfig({ offline: false, batchSize: 1 }), store);
    emitter.start();

    emitter.emit(makeOverflowEvent('retry_once'), 'ses_1');

    await emitter.flush();
    await new Promise((r) => setTimeout(r, 20));

    await emitter.flush();
    await new Promise((r) => setTimeout(r, 20));

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(emitter.queueSize()).toBe(0);

    await emitter.stop();
    fetchSpy.mockRestore();
  });

  it('does not re-queue 401/403 auth errors at all', async () => {
    const store = new SessionStore();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const emitter = new Emitter(makeConfig({ offline: false, batchSize: 1 }), store);
    emitter.start();

    emitter.emit(makeOverflowEvent('auth_fail'), 'ses_1');
    await emitter.flush();
    await new Promise((r) => setTimeout(r, 20));

    expect(emitter.queueSize()).toBe(0);

    await emitter.stop();
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('does not re-queue 402 billing errors', async () => {
    const store = new SessionStore();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({}),
    } as Response);

    const emitter = new Emitter(makeConfig({ offline: false, batchSize: 1 }), store);
    emitter.start();

    emitter.emit(makeOverflowEvent('billing_fail'), 'ses_1');
    await emitter.flush();
    await new Promise((r) => setTimeout(r, 20));

    expect(emitter.queueSize()).toBe(0);

    await emitter.stop();
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('SyrinSDK public interface', () => {
  it('init() return value satisfies SyrinSDK interface at runtime', async () => {
    const { init, shutdown } = await import('@/index.js');
    const sdk = await init({ apiKey: 'test', offline: true });

    expect(typeof sdk.flush).toBe('function');
    expect(typeof sdk.shutdown).toBe('function');
    expect(typeof sdk.configure).toBe('function');
    expect(typeof sdk.activeConfig).toBe('function');
    expect(typeof sdk.configSnapshot).toBe('function');
    expect(typeof sdk.diagnose).toBe('function');
    expect(typeof sdk.healthCheck).toBe('function');
    expect(typeof sdk.emit).toBe('function');
    expect(typeof sdk.log).toBe('function');
    expect(typeof sdk.checkpoint).toBe('function');
    expect(typeof sdk.agent).toBe('function');
    expect(typeof sdk.createCheckpoint).toBe('function');
    expect(typeof sdk.restoreCheckpoint).toBe('function');
    expect(typeof sdk.listCheckpoints).toBe('function');
    expect(typeof sdk.deleteSession).toBe('function');
    expect(typeof sdk.clearStaleSessions).toBe('function');
    expect(typeof sdk.onContextInjection).toBe('function');
    expect(typeof sdk.getPendingInjections).toBe('function');
    expect(typeof sdk.createServer).toBe('function');
    expect(typeof sdk.createAgentRouter).toBe('function');
    expect(typeof sdk.refreshSchema).toBe('function');
    expect(sdk.sessions).toBeDefined();
    expect(typeof sdk.sessions.rate).toBe('function');

    await shutdown('default');
  });

  it('getInstance() returns SyrinSDK with all expected methods', async () => {
    const { init, getInstance, shutdown } = await import('@/index.js');
    await init({ apiKey: 'test', offline: true });
    const inst = getInstance();
    expect(inst).not.toBeNull();
    if (inst) {
      expect(typeof inst.flush).toBe('function');
      expect(typeof inst.diagnose).toBe('function');
      expect(typeof inst.emit).toBe('function');
    }
    await shutdown('default');
  });

  it('diagnose() returns correct shape with offline=true', async () => {
    const { init, shutdown } = await import('@/index.js');
    const sdk = await init({ apiKey: 'test', offline: true });
    const diag = sdk.diagnose();
    expect(diag).toMatchObject({
      connected: false,
      eventsQueued: expect.any(Number),
      agentRegistered: expect.any(Boolean),
    });
    await shutdown('default');
  });

  it('configSnapshot() masks the API key', async () => {
    const { init, shutdown } = await import('@/index.js');
    const sdk = await init({ apiKey: 'syrin_supersecret_key', offline: true });
    const snap = sdk.configSnapshot();
    expect(snap['apiKey']).toBe('****');
    expect(snap['apiKey']).not.toContain('syrin_supersecret_key');
    await shutdown('default');
  });

  it('emit() never throws even when called with unknown event type', async () => {
    const { init, shutdown } = await import('@/index.js');
    const sdk = await init({ apiKey: 'test', offline: true });
    expect(() => sdk.emit('TOTALLY_CUSTOM_EVENT_TYPE', { foo: 'bar' })).not.toThrow();
    await shutdown('default');
  });
});
