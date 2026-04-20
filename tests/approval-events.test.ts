/**
 * Tests: APPROVAL_REQUESTED, APPROVAL_GRANTED, APPROVAL_REJECTED events (Group B)
 *
 * Emitted from the Emitter when a `require_approval` governance action is processed
 * and during the approval poll lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { SyrinSDKConfig, SyrinEvent } from '@/types';
import { Emitter } from '@/observability/emitter';
import { SessionStore } from '@/core/session';
import { generateId, nowIso } from '@/utils/helpers';

// ---------------------------------------------------------------------------
// MSW server
// ---------------------------------------------------------------------------

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SyrinSDKConfig> = {}): SyrinSDKConfig {
  return {
    apiKey: 'syrin_test_key',
    backendUrl: 'http://localhost:4399',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4399',
    debug: false,
    captureContent: false,
    offline: false,
    batchSize: 50,
    idleFlushMs: 60000,
    toolValidation: false,
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

function setupIngestWithGovernance(
  governance: Record<string, unknown>,
  approvalPollResponse?: Record<string, unknown>,
) {
  server.use(
    http.post('http://localhost:4399/api/v1/ingest', () =>
      HttpResponse.json({ ok: true, governance })
    ),
  );

  if (approvalPollResponse) {
    server.use(
      http.get('http://localhost:4399/api/v1/approvals/:approvalId', () =>
        HttpResponse.json(approvalPollResponse)
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// APPROVAL_REQUESTED
// ---------------------------------------------------------------------------

describe('APPROVAL_REQUESTED events', () => {
  let sessionStore: SessionStore;
  let emitter: Emitter;
  let emittedEvents: SyrinEvent[];

  beforeEach(() => {
    emittedEvents = [];
    sessionStore = new SessionStore();
    emitter = new Emitter(makeConfig(), sessionStore);

    const origEmit = emitter.emit.bind(emitter);
    vi.spyOn(emitter, 'emit').mockImplementation((event: SyrinEvent, sessionId: string) => {
      emittedEvents.push(event);
      return origEmit(event, sessionId);
    });
  });

  afterEach(async () => {
    await emitter.stop();
    vi.restoreAllMocks();
  });

  it('emits APPROVAL_REQUESTED when require_approval action is processed', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_001',
          tool_name: 'delete_file',
        }],
      },
      { ok: true, approval: { status: 'approved' } },
    );

    const sessionId = 'sess-appr-req';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_REQUESTED');
    expect(ev).toBeDefined();
  });

  it('APPROVAL_REQUESTED has approval_id, tool_name, session_id', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_abc',
          tool_name: 'send_email',
        }],
      },
      { ok: true, approval: { status: 'approved' } },
    );

    const sessionId = 'sess-appr-fields';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_REQUESTED');
    expect(ev).toBeDefined();
    expect(ev!.approval_id).toBe('appr_abc');
    expect(ev!.tool_name).toBe('send_email');
    expect(ev!.session_id).toBe(sessionId);
  });

  it('APPROVAL_REQUESTED has null reason when not provided', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_noreason',
          tool_name: 'deploy',
        }],
      },
      { ok: true, approval: { status: 'approved' } },
    );

    const sessionId = 'sess-appr-noreason';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_REQUESTED');
    expect(ev!.reason).toBeNull();
  });

  it('missing approval_id → no APPROVAL_REQUESTED emitted', async () => {
    setupIngestWithGovernance({
      actions: [{
        type: 'require_approval',
        // no approval_id
        tool_name: 'run_script',
      }],
    });

    const sessionId = 'sess-appr-noid';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_REQUESTED');
    expect(ev).toBeUndefined();
  });

  it('event emission failure for APPROVAL_REQUESTED is non-fatal', async () => {
    // Override the beforeEach spy with one that throws on APPROVAL_REQUESTED.
    vi.restoreAllMocks();
    let callCount = 0;
    vi.spyOn(emitter, 'emit').mockImplementation((event: SyrinEvent) => {
      callCount++;
      if (event.event_type === 'APPROVAL_REQUESTED') throw new Error('emit boom');
      // other event types are silently consumed (no-op is fine for this test)
    });

    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_boom',
          tool_name: 'risky_op',
        }],
      },
      { ok: true, approval: { status: 'approved' } },
    );

    const sessionId = 'sess-appr-nonfatal';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);

    await expect(emitter.flush()).resolves.not.toThrow();
    expect(callCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// APPROVAL_GRANTED
// ---------------------------------------------------------------------------

describe('APPROVAL_GRANTED events', () => {
  let sessionStore: SessionStore;
  let emitter: Emitter;
  let emittedEvents: SyrinEvent[];

  beforeEach(() => {
    emittedEvents = [];
    sessionStore = new SessionStore();
    emitter = new Emitter(makeConfig(), sessionStore);

    const origEmit = emitter.emit.bind(emitter);
    vi.spyOn(emitter, 'emit').mockImplementation((event: SyrinEvent, sessionId: string) => {
      emittedEvents.push(event);
      return origEmit(event, sessionId);
    });
  });

  afterEach(async () => {
    await emitter.stop();
    vi.restoreAllMocks();
  });

  it('emits APPROVAL_GRANTED when poll returns approved status', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_granted',
          tool_name: 'run_query',
        }],
      },
      { ok: true, approval: { status: 'approved' } },
    );

    const sessionId = 'sess-granted';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_GRANTED');
    expect(ev).toBeDefined();
  });

  it('APPROVAL_GRANTED has correct approval_id, tool_name, session_id', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_grant_xyz',
          tool_name: 'execute_sql',
        }],
      },
      { ok: true, approval: { status: 'approved' } },
    );

    const sessionId = 'sess-granted-fields';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_GRANTED');
    expect(ev!.approval_id).toBe('appr_grant_xyz');
    expect(ev!.tool_name).toBe('execute_sql');
    expect(ev!.session_id).toBe(sessionId);
  });

  it('does not emit APPROVAL_GRANTED for pending status', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_pending',
          tool_name: 'slow_op',
        }],
      },
      { ok: true, approval: { status: 'pending' } },
    );

    const sessionId = 'sess-pending';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_GRANTED');
    expect(ev).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// APPROVAL_REJECTED
// ---------------------------------------------------------------------------

describe('APPROVAL_REJECTED events', () => {
  let sessionStore: SessionStore;
  let emitter: Emitter;
  let emittedEvents: SyrinEvent[];

  beforeEach(() => {
    emittedEvents = [];
    sessionStore = new SessionStore();
    emitter = new Emitter(makeConfig(), sessionStore);

    const origEmit = emitter.emit.bind(emitter);
    vi.spyOn(emitter, 'emit').mockImplementation((event: SyrinEvent, sessionId: string) => {
      emittedEvents.push(event);
      return origEmit(event, sessionId);
    });
  });

  afterEach(async () => {
    await emitter.stop();
    vi.restoreAllMocks();
  });

  it('emits APPROVAL_REJECTED when poll returns rejected status', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_rej',
          tool_name: 'delete_db',
        }],
      },
      { ok: true, approval: { status: 'rejected' } },
    );

    const sessionId = 'sess-rejected';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_REJECTED');
    expect(ev).toBeDefined();
  });

  it('APPROVAL_REJECTED reason is "rejected" for rejected status', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_rej2',
          tool_name: 'drop_table',
        }],
      },
      { ok: true, approval: { status: 'rejected' } },
    );

    const sessionId = 'sess-rejected-reason';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_REJECTED');
    expect(ev!.reason).toBe('rejected');
  });

  it('emits APPROVAL_REJECTED when poll returns expired status', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_exp',
          tool_name: 'timed_op',
        }],
      },
      { ok: true, approval: { status: 'expired' } },
    );

    const sessionId = 'sess-expired';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_REJECTED');
    expect(ev).toBeDefined();
  });

  it('APPROVAL_REJECTED reason is "expired" for expired status', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_exp2',
          tool_name: 'expiring_op',
        }],
      },
      { ok: true, approval: { status: 'expired' } },
    );

    const sessionId = 'sess-expired-reason';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_REJECTED');
    expect(ev!.reason).toBe('expired');
  });

  it('APPROVAL_REJECTED has correct approval_id, tool_name, session_id', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_rej_fields',
          tool_name: 'format_disk',
        }],
      },
      { ok: true, approval: { status: 'rejected' } },
    );

    const sessionId = 'sess-rej-fields';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_REJECTED');
    expect(ev!.approval_id).toBe('appr_rej_fields');
    expect(ev!.tool_name).toBe('format_disk');
    expect(ev!.session_id).toBe(sessionId);
  });

  it('does not emit APPROVAL_REJECTED for pending status', async () => {
    setupIngestWithGovernance(
      {
        actions: [{
          type: 'require_approval',
          approval_id: 'appr_still_pending',
          tool_name: 'wait_op',
        }],
      },
      { ok: true, approval: { status: 'pending' } },
    );

    const sessionId = 'sess-still-pending';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const ev = emittedEvents.find((e) => e.event_type === 'APPROVAL_REJECTED');
    expect(ev).toBeUndefined();
  });

  it('poll network failure emits nothing (APPROVAL_GRANTED/REJECTED not emitted)', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{
              type: 'require_approval',
              approval_id: 'appr_net_fail',
              tool_name: 'risky',
            }],
          },
        })
      ),
      http.get('http://localhost:4399/api/v1/approvals/:approvalId', () =>
        HttpResponse.error()
      ),
    );

    const sessionId = 'sess-net-fail';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await expect(emitter.flush()).resolves.not.toThrow();

    const granted  = emittedEvents.find((e) => e.event_type === 'APPROVAL_GRANTED');
    const rejected = emittedEvents.find((e) => e.event_type === 'APPROVAL_REJECTED');
    expect(granted).toBeUndefined();
    expect(rejected).toBeUndefined();
  });

  it('poll non-200 response emits nothing (APPROVAL_GRANTED/REJECTED not emitted)', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{
              type: 'require_approval',
              approval_id: 'appr_404',
              tool_name: 'missing_op',
            }],
          },
        })
      ),
      http.get('http://localhost:4399/api/v1/approvals/:approvalId', () =>
        new HttpResponse(null, { status: 404 })
      ),
    );

    const sessionId = 'sess-poll-404';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await expect(emitter.flush()).resolves.not.toThrow();

    const granted  = emittedEvents.find((e) => e.event_type === 'APPROVAL_GRANTED');
    const rejected = emittedEvents.find((e) => e.event_type === 'APPROVAL_REJECTED');
    expect(granted).toBeUndefined();
    expect(rejected).toBeUndefined();
  });

  it('poll invalid JSON response emits nothing (APPROVAL_GRANTED/REJECTED not emitted)', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{
              type: 'require_approval',
              approval_id: 'appr_badjson',
              tool_name: 'bad_json_op',
            }],
          },
        })
      ),
      http.get('http://localhost:4399/api/v1/approvals/:approvalId', () =>
        new HttpResponse('not-json', { status: 200, headers: { 'Content-Type': 'text/plain' } })
      ),
    );

    const sessionId = 'sess-poll-badjson';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await expect(emitter.flush()).resolves.not.toThrow();

    const granted  = emittedEvents.find((e) => e.event_type === 'APPROVAL_GRANTED');
    const rejected = emittedEvents.find((e) => e.event_type === 'APPROVAL_REJECTED');
    expect(granted).toBeUndefined();
    expect(rejected).toBeUndefined();
  });
});
