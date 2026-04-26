/**
 * Tests: session_type flows from SessionStore → Emitter → ingest payload
 *
 * Covers:
 *  1. session_type is included in the ingest payload when set via setSessionType
 *  2. session_type is omitted from the payload when not set
 *  3. All valid SessionType values are forwarded correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Emitter } from '@/observability/emitter';
import { SessionStore } from '@/core/session';
import type { SyrinConfig, SyrinEvent, IngestPayload } from '@/types';
import { generateId, nowIso } from '@/utils/helpers';

// ── MSW mock server ──────────────────────────────────────────────────────────

const mockServer = setupServer();

beforeAll(() => mockServer.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test_key',
    backendUrl: 'http://localhost:4500',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4500',
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Emitter: session_type in ingest payload', () => {
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

  it('includes session_type in the ingest payload when set on session', async () => {
    let capturedPayload: IngestPayload & { session_type?: string } | null = null;

    mockServer.use(
      http.post('http://localhost:4500/api/v1/ingest', async ({ request }) => {
        capturedPayload = (await request.json()) as IngestPayload & { session_type?: string };
        return HttpResponse.json({ ok: true });
      })
    );

    const sessionId = 'ses_type_test_1';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.setSessionType(sessionId, 'chat_test');

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload!['session_type']).toBe('chat_test');
  });

  it('omits session_type from the ingest payload when not set', async () => {
    let capturedPayload: IngestPayload & { session_type?: string } | null = null;

    mockServer.use(
      http.post('http://localhost:4500/api/v1/ingest', async ({ request }) => {
        capturedPayload = (await request.json()) as IngestPayload & { session_type?: string };
        return HttpResponse.json({ ok: true });
      })
    );

    const sessionId = 'ses_type_test_2';
    await sessionStore.getOrCreate(sessionId);
    // No setSessionType call

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload!['session_type']).toBeUndefined();
  });

  it('forwards workflow_test session_type correctly', async () => {
    let capturedPayload: IngestPayload & { session_type?: string } | null = null;

    mockServer.use(
      http.post('http://localhost:4500/api/v1/ingest', async ({ request }) => {
        capturedPayload = (await request.json()) as IngestPayload & { session_type?: string };
        return HttpResponse.json({ ok: true });
      })
    );

    const sessionId = 'ses_wf_type';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.setSessionType(sessionId, 'workflow_test');

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    expect(capturedPayload!['session_type']).toBe('workflow_test');
  });

  it('forwards simulation session_type correctly', async () => {
    let capturedPayload: IngestPayload & { session_type?: string } | null = null;

    mockServer.use(
      http.post('http://localhost:4500/api/v1/ingest', async ({ request }) => {
        capturedPayload = (await request.json()) as IngestPayload & { session_type?: string };
        return HttpResponse.json({ ok: true });
      })
    );

    const sessionId = 'ses_sim_type';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.setSessionType(sessionId, 'simulation');

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    expect(capturedPayload!['session_type']).toBe('simulation');
  });

  it('forwards production session_type correctly', async () => {
    let capturedPayload: IngestPayload & { session_type?: string } | null = null;

    mockServer.use(
      http.post('http://localhost:4500/api/v1/ingest', async ({ request }) => {
        capturedPayload = (await request.json()) as IngestPayload & { session_type?: string };
        return HttpResponse.json({ ok: true });
      })
    );

    const sessionId = 'ses_prod_type';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.setSessionType(sessionId, 'production');

    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    expect(capturedPayload!['session_type']).toBe('production');
  });
});
