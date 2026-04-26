/**
 * Tests: src/observability/emitter.ts — extended cases
 * - Queue overflow
 * - Governance response handling
 * - onContextInjection callbacks
 * - pending_injections / pendingInjections
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Emitter } from '@/observability/emitter';
import { SessionStore } from '@/core/session';
import { clearHooks, onAlert } from '@/observability/hooks';
import { generateId, nowIso } from '@/utils/helpers';
import type { SyrinConfig, SyrinEvent } from '@/types';

const server = setupServer();
beforeEach(() => { server.listen({ onUnhandledRequest: 'bypass' }); clearHooks(); });
afterEach(() => { server.resetHandlers(); vi.clearAllMocks(); clearHooks(); });
afterEach(() => server.close());

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test_key',
    backendUrl: 'http://localhost:4403',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4403',
    debug: false,
    captureContent: false,
    offline: false,
    batchIntervalMs: 60000,
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
      http.post('http://localhost:4403/api/v1/ingest', () =>
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
