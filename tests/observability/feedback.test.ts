/**
 * Tests: v1.1.0 feedback features
 *
 * Covers:
 *   - SessionFeedback class (positive, negative, onCompletion)
 *   - sdk.sessions.rate()
 *   - sdk.sessions.rateBatch()
 *   - sdk.sessions.withId()
 *   - Success Criteria (SESSION_CRITERIA event + session state)
 *   - Context Injection (pendingInjections parsing + callbacks)
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { SessionFeedback } from '@/feedback';
import { AlreadyRatedError, SessionNotFoundError, ValidationError } from '@/errors';
import { SessionStore } from '@/core/session';
import { Emitter } from '@/observability/emitter';
import type { SyrinConfig, SyrinEvent } from '@/types';
import { generateId, nowIso } from '@/utils/helpers';

// ---------------------------------------------------------------------------
// MSW server
// ---------------------------------------------------------------------------
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const BACKEND = 'http://localhost:4398';
const API_KEY = 'syrin_test_key';

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: API_KEY,
    backendUrl: BACKEND,
    otelExporter: 'none',
    otelEndpoint: `${BACKEND}`,
    debug: false,
    captureContent: false,
    offline: false,
    batchSize: 50,
    idleFlushMs: 60_000,
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
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0.001,
    stream: false,
    config_applied: false,
    ...overrides,
  };
}

function mockFeedback(
  sessionId: string,
  status: number,
  body: unknown = { ok: true },
) {
  server.use(
    http.post(
      `${BACKEND}/api/v1/sessions/${encodeURIComponent(sessionId)}/feedback`,
      () => new HttpResponse(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// SessionFeedback.positive()
// ---------------------------------------------------------------------------
describe('SessionFeedback.positive()', () => {
  it('sends POST to /sessions/:id/feedback with rating=positive', async () => {
    const sessionId = 'sess_pos_001';
    let captured: Record<string, unknown> | null = null;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    const fb = new SessionFeedback(sessionId, makeConfig());
    await fb.positive();

    expect(captured).not.toBeNull();
    expect(captured!['rating']).toBe('positive');
  });

  it('includes reason in body when provided', async () => {
    const sessionId = 'sess_pos_002';
    let captured: Record<string, unknown> | null = null;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    const fb = new SessionFeedback(sessionId, makeConfig());
    await fb.positive({ reason: 'Great output' });

    expect(captured!['reason']).toBe('Great output');
  });

  it('omits reason from body when not provided', async () => {
    const sessionId = 'sess_pos_003';
    let captured: Record<string, unknown> | null = null;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    const fb = new SessionFeedback(sessionId, makeConfig());
    await fb.positive();

    expect(Object.prototype.hasOwnProperty.call(captured, 'reason')).toBe(false);
  });

  it('includes voter_id in body when provided', async () => {
    const sessionId = 'sess_pos_004';
    let captured: Record<string, unknown> | null = null;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    const fb = new SessionFeedback(sessionId, makeConfig());
    await fb.positive({ voterId: 'user_42' });

    expect(captured!['voter_id']).toBe('user_42');
  });
});

// ---------------------------------------------------------------------------
// SessionFeedback.negative()
// ---------------------------------------------------------------------------
describe('SessionFeedback.negative()', () => {
  it('sends POST with rating=negative', async () => {
    const sessionId = 'sess_neg_001';
    let captured: Record<string, unknown> | null = null;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    const fb = new SessionFeedback(sessionId, makeConfig());
    await fb.negative();

    expect(captured!['rating']).toBe('negative');
  });

  it('includes reason when provided', async () => {
    const sessionId = 'sess_neg_002';
    let captured: Record<string, unknown> | null = null;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    const fb = new SessionFeedback(sessionId, makeConfig());
    await fb.negative({ reason: 'Wrong output' });

    expect(captured!['reason']).toBe('Wrong output');
  });
});

// ---------------------------------------------------------------------------
// SessionFeedback.onCompletion()
// ---------------------------------------------------------------------------
describe('SessionFeedback.onCompletion()', () => {
  it('calls positive() when successFn returns true', async () => {
    const sessionId = 'sess_ocomp_001';
    let captured: Record<string, unknown> | null = null;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    const fb = new SessionFeedback(sessionId, makeConfig());
    await fb.onCompletion('success result', (r) => r === 'success result');

    expect(captured!['rating']).toBe('positive');
  });

  it('calls negative() when successFn returns false', async () => {
    const sessionId = 'sess_ocomp_002';
    let captured: Record<string, unknown> | null = null;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    const fb = new SessionFeedback(sessionId, makeConfig());
    await fb.onCompletion('failure result', (r) => r === 'success result');

    expect(captured!['rating']).toBe('negative');
  });

  it('passes result to successFn', async () => {
    const sessionId = 'sess_ocomp_003';
    let receivedResult: unknown = undefined;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, () =>
        HttpResponse.json({ ok: true }),
      ),
    );

    const fb = new SessionFeedback(sessionId, makeConfig());
    const result = { score: 0.95, label: 'good' };
    await fb.onCompletion(result, (r) => {
      receivedResult = r;
      return true;
    });

    expect(receivedResult).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// sdk.sessions.rate()  — tested via sendFeedback + SessionFeedback (same logic)
// ---------------------------------------------------------------------------
describe('sdk.sessions.rate()', () => {
  // Import SyrinSDKInstance directly for unit testing without full init()
  async function buildSDK(config: SyrinConfig) {
    const { SyrinSDKInstance } = await import('@/index');
    const { SessionStore: SS } = await import('@/core/session');
    const { Emitter: Em } = await import('@/observability/emitter');
    const { OTelBridge } = await import('@/observability/otel');
    const { CheckpointClient } = await import('@/core/checkpoint');
    const { SyrinCore } = await import('@/core/engine');
    const { Heartbeat } = await import('@/core/heartbeat');

    const store = new SS();
    const emitter = new Em(config, store);
    const otel = new OTelBridge(config);
    const cp = new CheckpointClient(config);
    const core = new SyrinCore(config, store, emitter, otel, cp);
    const hb = new Heartbeat({ agentId: config.agentId, backendUrl: config.backendUrl, apiKey: config.apiKey, offline: true, intervalMs: 9999999 });
    return new SyrinSDKInstance(config, store, emitter, otel, core, hb);
  }

  it('sends correct HTTP request for positive rating', async () => {
    const sessionId = 'sess_rate_001';
    let captured: Record<string, unknown> | null = null;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    const sdk = await buildSDK(makeConfig());
    await sdk.sessions.rate(sessionId, 'positive');

    expect(captured!['rating']).toBe('positive');
  });

  it('sends correct HTTP request for negative rating with reason', async () => {
    const sessionId = 'sess_rate_002';
    let captured: Record<string, unknown> | null = null;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    const sdk = await buildSDK(makeConfig());
    await sdk.sessions.rate(sessionId, 'negative', { reason: 'Off topic' });

    expect(captured!['rating']).toBe('negative');
    expect(captured!['reason']).toBe('Off topic');
  });

  it('throws AlreadyRatedError on 409 response', async () => {
    const sessionId = 'sess_rate_409';
    mockFeedback(sessionId, 409, { error: 'Already rated' });

    const sdk = await buildSDK(makeConfig());
    await expect(sdk.sessions.rate(sessionId, 'positive')).rejects.toThrow(AlreadyRatedError);
  });

  it('AlreadyRatedError has correct sessionId property', async () => {
    const sessionId = 'sess_rate_409b';
    mockFeedback(sessionId, 409, { error: 'Already rated' });

    const sdk = await buildSDK(makeConfig());
    let caughtError: AlreadyRatedError | undefined;
    try {
      await sdk.sessions.rate(sessionId, 'positive');
    } catch (e) {
      caughtError = e as AlreadyRatedError;
    }

    expect(caughtError).toBeInstanceOf(AlreadyRatedError);
    expect(caughtError!.sessionId).toBe(sessionId);
    expect(caughtError!.httpStatus).toBe(409);
  });

  it('throws SessionNotFoundError on 404 response', async () => {
    const sessionId = 'sess_rate_404';
    mockFeedback(sessionId, 404, { error: 'Not found' });

    const sdk = await buildSDK(makeConfig());
    await expect(sdk.sessions.rate(sessionId, 'positive')).rejects.toThrow(SessionNotFoundError);
  });

  it('throws ValidationError for invalid rating value', async () => {
    // No server handler needed — should throw before HTTP
    const sdk = await buildSDK(makeConfig());
    // Cast to bypass TypeScript to test runtime validation
    await expect(
      sdk.sessions.rate('sess_rate_val', 'invalid_rating' as 'positive', {}),
    ).rejects.toThrow(ValidationError);
  });

  it('includes voter_id when provided', async () => {
    const sessionId = 'sess_rate_voter';
    let captured: Record<string, unknown> | null = null;

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );

    const sdk = await buildSDK(makeConfig());
    await sdk.sessions.rate(sessionId, 'positive', { voterId: 'reviewer_99' });

    expect(captured!['voter_id']).toBe('reviewer_99');
  });
});

// ---------------------------------------------------------------------------
// sdk.sessions.rateBatch()
// ---------------------------------------------------------------------------
describe('sdk.sessions.rateBatch()', () => {
  async function buildSDK(config: SyrinConfig) {
    const { SyrinSDKInstance } = await import('@/index');
    const { SessionStore: SS } = await import('@/core/session');
    const { Emitter: Em } = await import('@/observability/emitter');
    const { OTelBridge } = await import('@/observability/otel');
    const { CheckpointClient } = await import('@/core/checkpoint');
    const { SyrinCore } = await import('@/core/engine');
    const { Heartbeat } = await import('@/core/heartbeat');

    const store = new SS();
    const emitter = new Em(config, store);
    const otel = new OTelBridge(config);
    const cp = new CheckpointClient(config);
    const core = new SyrinCore(config, store, emitter, otel, cp);
    const hb = new Heartbeat({ agentId: config.agentId, backendUrl: config.backendUrl, apiKey: config.apiKey, offline: true, intervalMs: 9999999 });
    return new SyrinSDKInstance(config, store, emitter, otel, core, hb);
  }

  it('sends individual requests for each item', async () => {
    const hitIds = new Set<string>();

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/:id/feedback`, ({ params }) => {
        hitIds.add(params['id'] as string);
        return HttpResponse.json({ ok: true });
      }),
    );

    const sdk = await buildSDK(makeConfig());
    await sdk.sessions.rateBatch([
      { sessionId: 'batch_a', rating: 'positive' },
      { sessionId: 'batch_b', rating: 'negative' },
      { sessionId: 'batch_c', rating: 'positive' },
    ]);

    expect(hitIds.has('batch_a')).toBe(true);
    expect(hitIds.has('batch_b')).toBe(true);
    expect(hitIds.has('batch_c')).toBe(true);
  });

  it('does nothing for empty array', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sdk = await buildSDK(makeConfig());
    await sdk.sessions.rateBatch([]);
    // fetch should not have been called for feedback
    const feedbackCalls = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).includes('/feedback'),
    );
    expect(feedbackCalls).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it('collects all errors and rethrows', async () => {
    server.use(
      http.post(`${BACKEND}/api/v1/sessions/:id/feedback`, ({ params }) => {
        if (params['id'] === 'err_a' || params['id'] === 'err_b') {
          return new HttpResponse(null, { status: 409 });
        }
        return HttpResponse.json({ ok: true });
      }),
    );

    const sdk = await buildSDK(makeConfig());
    await expect(
      sdk.sessions.rateBatch([
        { sessionId: 'err_a', rating: 'positive' },
        { sessionId: 'err_b', rating: 'negative' },
      ]),
    ).rejects.toThrow(/rateBatch encountered errors/);
  });
});

// ---------------------------------------------------------------------------
// sdk.sessions.withId()
// ---------------------------------------------------------------------------
describe('sdk.sessions.withId()', () => {
  async function buildSDK(config: SyrinConfig) {
    const { SyrinSDKInstance } = await import('@/index');
    const { SessionStore: SS } = await import('@/core/session');
    const { Emitter: Em } = await import('@/observability/emitter');
    const { OTelBridge } = await import('@/observability/otel');
    const { CheckpointClient } = await import('@/core/checkpoint');
    const { SyrinCore } = await import('@/core/engine');
    const { Heartbeat } = await import('@/core/heartbeat');

    const store = new SS();
    const emitter = new Em(config, store);
    const otel = new OTelBridge(config);
    const cp = new CheckpointClient(config);
    const core = new SyrinCore(config, store, emitter, otel, cp);
    const hb = new Heartbeat({ agentId: config.agentId, backendUrl: config.backendUrl, apiKey: config.apiKey, offline: true, intervalMs: 9999999 });
    return new SyrinSDKInstance(config, store, emitter, otel, core, hb);
  }

  it('rate() sends request for correct session ID', async () => {
    const sessionId = 'sess_with_001';
    let capturedUrl = '';

    server.use(
      http.post(`${BACKEND}/api/v1/sessions/${sessionId}/feedback`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ ok: true });
      }),
    );

    const sdk = await buildSDK(makeConfig());
    await sdk.sessions.withId(sessionId).rate('positive');

    expect(capturedUrl).toContain(sessionId);
  });

  it('returns chainable builder', async () => {
    const sdk = await buildSDK(makeConfig());
    const builder = sdk.sessions.withId('any_session');

    expect(builder).toBeDefined();
    expect(typeof builder.rate).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Success Criteria
// ---------------------------------------------------------------------------
describe('Success Criteria', () => {
  async function buildSDK(config: SyrinConfig) {
    const { SyrinSDKInstance } = await import('@/index');
    const { SessionStore: SS } = await import('@/core/session');
    const { Emitter: Em } = await import('@/observability/emitter');
    const { OTelBridge } = await import('@/observability/otel');
    const { CheckpointClient } = await import('@/core/checkpoint');
    const { SyrinCore } = await import('@/core/engine');
    const { Heartbeat } = await import('@/core/heartbeat');

    const store = new SS();
    const emitter = new Em(config, store);
    const otel = new OTelBridge(config);
    const cp = new CheckpointClient(config);
    const core = new SyrinCore(config, store, emitter, otel, cp);
    const hb = new Heartbeat({ agentId: config.agentId, backendUrl: config.backendUrl, apiKey: config.apiKey, offline: true, intervalMs: 9999999 });
    return { sdk: new SyrinSDKInstance(config, store, emitter, otel, core, hb), store, emitter };
  }

  it('emits SESSION_CRITERIA event when successCriteria provided', async () => {
    const { sdk, emitter } = await buildSDK(makeConfig());
    const emitSpy = vi.spyOn(emitter, 'emit');

    await sdk.sessions.start({
      sessionId: 'sess_crit_001',
      successCriteria: ['accuracy > 0.9', 'latency < 2s'],
    });

    const criteriaCall = emitSpy.mock.calls.find(
      ([event]) => (event as { event_type: string }).event_type === 'SESSION_CRITERIA',
    );
    expect(criteriaCall).toBeDefined();
    const [event] = criteriaCall!;
    expect((event as Record<string, unknown>)['criteria']).toEqual(['accuracy > 0.9', 'latency < 2s']);
  });

  it('does not emit SESSION_CRITERIA when not provided', async () => {
    const { sdk, emitter } = await buildSDK(makeConfig());
    const emitSpy = vi.spyOn(emitter, 'emit');

    await sdk.sessions.start({ sessionId: 'sess_crit_002' });

    const criteriaCall = emitSpy.mock.calls.find(
      ([event]) => (event as { event_type: string }).event_type === 'SESSION_CRITERIA',
    );
    expect(criteriaCall).toBeUndefined();
  });

  it('stores criteria in session state', async () => {
    const { sdk, store } = await buildSDK(makeConfig());

    await sdk.sessions.start({
      sessionId: 'sess_crit_003',
      successCriteria: ['step_count < 5'],
    });

    const session = store.getSession('sess_crit_003');
    expect(session?.successCriteria).toEqual(['step_count < 5']);
  });
});

// ---------------------------------------------------------------------------
// Context Injection
// ---------------------------------------------------------------------------
describe('Context Injection', () => {
  let config: SyrinConfig;
  let store: SessionStore;
  let emitter: Emitter;

  beforeEach(() => {
    config = makeConfig();
    store = new SessionStore();
    emitter = new Emitter(config, store);
  });

  afterEach(async () => {
    await emitter.stop();
    vi.restoreAllMocks();
  });

  it('parses pendingInjections from ingest response', async () => {
    const sessionId = 'sess_inj_001';
    await store.getOrCreate(sessionId, 'agent-inj');

    server.use(
      http.post(`${BACKEND}/api/v1/ingest`, () =>
        HttpResponse.json({
          ok: true,
          pendingInjections: [
            { id: 'inj_1', injection_type: 'fact', content: 'The sky is blue' },
          ],
        }),
      ),
    );

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const injections = store.popInjections(sessionId);
    expect(injections).toHaveLength(1);
    expect(injections[0].id).toBe('inj_1');
    expect(injections[0].content).toBe('The sky is blue');
  });

  it('stores injections in session state', async () => {
    const sessionId = 'sess_inj_002';
    await store.getOrCreate(sessionId, 'agent-inj');

    server.use(
      http.post(`${BACKEND}/api/v1/ingest`, () =>
        HttpResponse.json({
          ok: true,
          pendingInjections: [
            { id: 'inj_a', injection_type: 'constraint', content: 'Max 200 words' },
            { id: 'inj_b', injection_type: 'manual', content: 'Be concise' },
          ],
        }),
      ),
    );

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const session = store.getSession(sessionId);
    expect(session!.pendingInjections).toHaveLength(2);
  });

  it('getPendingInjections returns and clears injections', async () => {
    const sessionId = 'sess_inj_003';
    await store.getOrCreate(sessionId, 'agent-inj');

    server.use(
      http.post(`${BACKEND}/api/v1/ingest`, () =>
        HttpResponse.json({
          ok: true,
          pendingInjections: [
            { id: 'inj_x', injection_type: 'world_state', content: 'Time is 12:00' },
          ],
        }),
      ),
    );

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    // First call returns injections
    const first = store.popInjections(sessionId);
    expect(first).toHaveLength(1);

    // Second call returns empty (cleared)
    const second = store.popInjections(sessionId);
    expect(second).toHaveLength(0);
  });

  it('getPendingInjections returns empty array when none pending', async () => {
    const sessionId = 'sess_inj_004';
    await store.getOrCreate(sessionId, 'agent-inj');

    const injections = store.popInjections(sessionId);
    expect(injections).toEqual([]);
  });

  it('onContextInjection callback is called when injection arrives', async () => {
    const sessionId = 'sess_inj_005';
    await store.getOrCreate(sessionId, 'agent-inj');

    server.use(
      http.post(`${BACKEND}/api/v1/ingest`, () =>
        HttpResponse.json({
          ok: true,
          pendingInjections: [
            { id: 'inj_cb', injection_type: 'governance_correction', content: 'Rephrase response' },
          ],
        }),
      ),
    );

    const received: unknown[] = [];
    emitter.onContextInjection((inj) => received.push(inj));

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    expect(received).toHaveLength(1);
    expect((received[0] as { id: string }).id).toBe('inj_cb');
  });

  it('onContextInjection unsubscribe removes callback', async () => {
    const sessionId = 'sess_inj_006';
    await store.getOrCreate(sessionId, 'agent-inj');

    server.use(
      http.post(`${BACKEND}/api/v1/ingest`, () =>
        HttpResponse.json({
          ok: true,
          pendingInjections: [
            { id: 'inj_unsub', injection_type: 'custom', content: 'Test' },
          ],
        }),
      ),
    );

    const received: unknown[] = [];
    const unsub = emitter.onContextInjection((inj) => received.push(inj));

    // Unsubscribe before the flush
    unsub();

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error class sanity checks
// ---------------------------------------------------------------------------
describe('Error classes', () => {
  it('AlreadyRatedError has correct name and httpStatus', () => {
    const err = new AlreadyRatedError('sess_err_001');
    expect(err.name).toBe('AlreadyRatedError');
    expect(err.httpStatus).toBe(409);
    expect(err.sessionId).toBe('sess_err_001');
    expect(err instanceof AlreadyRatedError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it('SessionNotFoundError has correct name and httpStatus', () => {
    const err = new SessionNotFoundError('sess_err_002');
    expect(err.name).toBe('SessionNotFoundError');
    expect(err.httpStatus).toBe(404);
    expect(err.sessionId).toBe('sess_err_002');
  });

  it('ValidationError has correct name and httpStatus', () => {
    const err = new ValidationError('bad input');
    expect(err.name).toBe('ValidationError');
    expect(err.httpStatus).toBe(422);
    expect(err.message).toBe('bad input');
  });
});
