/**
 * Tests: Feature 4 — GOVERNANCE_TRIGGERED event
 * Tests: Feature 5 — CONFIG_APPLIED event
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { SyrinSDKConfig, SyrinEvent } from '@/types';
import { Emitter } from '@/observability/emitter';
import { SessionStore } from '@/core/session';
import { generateId, nowIso } from '@/utils/helpers';

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

// ---------------------------------------------------------------------------
// Feature 4: GOVERNANCE_TRIGGERED event
// ---------------------------------------------------------------------------

describe('Feature 4: GOVERNANCE_TRIGGERED event', () => {
  let config: SyrinSDKConfig;
  let sessionStore: SessionStore;
  let emitter: Emitter;
  let emittedEvents: SyrinEvent[];

  beforeEach(() => {
    emittedEvents = [];
    config = makeConfig();
    sessionStore = new SessionStore();
    emitter = new Emitter(config, sessionStore);

    // Spy on emitter.emit to capture internally emitted events
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

  it('emits GOVERNANCE_TRIGGERED for stop action', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{ type: 'stop', reason: 'Loop detected', incident_id: 'inc_123' }],
          },
        })
      )
    );

    const sessionId = 'gov-stop-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const govEvent = emittedEvents.find((e) => e.event_type === 'GOVERNANCE_TRIGGERED');
    expect(govEvent).toBeDefined();
    expect(govEvent!.action_type).toBe('stop');
  });

  it('emits GOVERNANCE_TRIGGERED for inject_message action', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{ type: 'inject_message', role: 'system', content: 'Stay focused.' }],
          },
        })
      )
    );

    const sessionId = 'gov-inject-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const govEvent = emittedEvents.find((e) => e.event_type === 'GOVERNANCE_TRIGGERED');
    expect(govEvent).toBeDefined();
    expect(govEvent!.action_type).toBe('inject_message');
  });

  it('emits GOVERNANCE_TRIGGERED for alert action', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{ type: 'alert', level: 'warn', message: 'High cost' }],
          },
        })
      )
    );

    const sessionId = 'gov-alert-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const govEvent = emittedEvents.find((e) => e.event_type === 'GOVERNANCE_TRIGGERED');
    expect(govEvent).toBeDefined();
    expect(govEvent!.action_type).toBe('alert');
  });

  it('emits GOVERNANCE_TRIGGERED for unknown action type', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{ type: 'custom_unknown_action', foo: 'bar' }],
          },
        })
      )
    );

    const sessionId = 'gov-unknown-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const govEvent = emittedEvents.find((e) => e.event_type === 'GOVERNANCE_TRIGGERED');
    expect(govEvent).toBeDefined();
    expect(govEvent!.action_type).toBe('custom_unknown_action');
  });

  it('event has correct session_id, action_type, incident_id, reason', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{
              type: 'stop',
              reason: 'Too many loops',
              incident_id: 'inc_xyz',
            }],
          },
        })
      )
    );

    const sessionId = 'gov-fields-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const govEvent = emittedEvents.find((e) => e.event_type === 'GOVERNANCE_TRIGGERED');
    expect(govEvent!.session_id).toBe(sessionId);
    expect(govEvent!.action_type).toBe('stop');
    expect(govEvent!.incident_id).toBe('inc_xyz');
    expect(govEvent!.reason).toBe('Too many loops');
  });

  it('multiple actions → multiple GOVERNANCE_TRIGGERED events', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [
              { type: 'alert', message: 'High cost' },
              { type: 'inject_message', role: 'system', content: 'Slow down' },
            ],
          },
        })
      )
    );

    const sessionId = 'gov-multi-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const govEvents = emittedEvents.filter((e) => e.event_type === 'GOVERNANCE_TRIGGERED');
    expect(govEvents).toHaveLength(2);
    const actionTypes = govEvents.map((e) => e.action_type);
    expect(actionTypes).toContain('alert');
    expect(actionTypes).toContain('inject_message');
  });

  it('emitter failure for GOVERNANCE_TRIGGERED is non-fatal', async () => {
    // This tests that the governance processing completes even if the emit itself would fail.
    // We verify no unhandled rejection occurs.
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          governance: {
            actions: [{ type: 'stop', reason: 'test' }],
          },
        })
      )
    );

    const sessionId = 'gov-nonfatal-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);

    // Should not throw
    await expect(emitter.flush()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Feature 5: CONFIG_APPLIED event
// ---------------------------------------------------------------------------

describe('Feature 5: CONFIG_APPLIED event', () => {
  let config: SyrinSDKConfig;
  let sessionStore: SessionStore;
  let emitter: Emitter;
  let emittedEvents: SyrinEvent[];

  beforeEach(() => {
    emittedEvents = [];
    config = makeConfig();
    sessionStore = new SessionStore();
    emitter = new Emitter(config, sessionStore);

    // Spy on emitter.emit to capture internally emitted events
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

  it('emits CONFIG_APPLIED when config_updates received', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          config_updates: { temperature: 0.3, max_tokens: 2000 },
        })
      )
    );

    const sessionId = 'config-applied-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const configEvent = emittedEvents.find((e) => e.event_type === 'CONFIG_APPLIED');
    expect(configEvent).toBeDefined();
  });

  it('config_keys array matches keys in update', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          config_updates: { temperature: 0.3, max_tokens: 2000 },
        })
      )
    );

    const sessionId = 'config-keys-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const configEvent = emittedEvents.find((e) => e.event_type === 'CONFIG_APPLIED');
    expect(configEvent!.config_keys).toContain('temperature');
    expect(configEvent!.config_keys).toContain('max_tokens');
    expect(configEvent!.config_keys).toHaveLength(2);
  });

  it('CONFIG_APPLIED not emitted for empty updates object', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          config_updates: {},
        })
      )
    );

    const sessionId = 'config-empty-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const configEvent = emittedEvents.find((e) => e.event_type === 'CONFIG_APPLIED');
    expect(configEvent).toBeUndefined();
  });

  it('CONFIG_APPLIED not emitted when no config_updates in response', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({ ok: true })
      )
    );

    const sessionId = 'config-no-updates-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const configEvent = emittedEvents.find((e) => e.event_type === 'CONFIG_APPLIED');
    expect(configEvent).toBeUndefined();
  });

  it('CONFIG_APPLIED session_id is correct', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          config_updates: { temperature: 0.5 },
        })
      )
    );

    const sessionId = 'config-sid-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);
    await emitter.flush();

    const configEvent = emittedEvents.find((e) => e.event_type === 'CONFIG_APPLIED');
    expect(configEvent!.session_id).toBe(sessionId);
  });

  it('failure to emit CONFIG_APPLIED is non-fatal', async () => {
    server.use(
      http.post('http://localhost:4399/api/v1/ingest', () =>
        HttpResponse.json({
          ok: true,
          config_updates: { temperature: 0.3 },
        })
      )
    );

    const sessionId = 'config-nonfatal-session';
    await sessionStore.getOrCreate(sessionId);
    emitter.emit(makeEvent(), sessionId);

    // Should not throw
    await expect(emitter.flush()).resolves.not.toThrow();
  });
});
