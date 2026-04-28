/**
 * Tests: CONTEXT_INJECTION telemetry event emission
 *
 * When the backend returns pendingInjections in an ingest response, the emitter
 * should emit a CONTEXT_INJECTION event for each injection.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Emitter } from '@/observability/emitter';
import { SessionStore } from '@/core/session';
import type { SyrinConfig, SyrinEvent, ContextInjection } from '@/types';

afterEach(() => vi.clearAllMocks());

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4402',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4402',
    debug: false,
    captureContent: false,
    offline: false,
    batchIntervalMs: 60000,
    batchSize: 50,
    idleFlushMs: 60000,
    ...overrides,
  };
}

function makeInjection(overrides: Partial<ContextInjection> = {}): ContextInjection {
  return {
    id: 'inj_001',
    injection_type: 'manual',
    content: 'This is injected context.',
    ...overrides,
  };
}

/**
 * Helper: intercept fetch to return a canned ingest response.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockFetch(ingestBody: object): (...args: any[]) => any {
  const mockFetchFn = vi.fn().mockImplementation((url: string) => {
    if (String(url).includes('/ingest')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(ingestBody),
      });
    }
    // Health check
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  });
  return mockFetchFn;
}

describe('CONTEXT_INJECTION event emission', () => {
  it('should emit CONTEXT_INJECTION event when backend returns pendingInjections', async () => {
    const injection = makeInjection();
    const fetchMock = mockFetch({
      ok: true,
      pending_injections: [injection],
    });

    const config = makeConfig();
    const sessionStore = new SessionStore();
    await sessionStore.getOrCreate('ses_001', 'agent-1');

    const emitter = new Emitter(config, sessionStore);

    const capturedEvents: Array<{ event: SyrinEvent; sessionId: string }> = [];
    vi.spyOn(emitter, 'emit').mockImplementation((ev, sid) => {
      capturedEvents.push({ event: ev, sessionId: sid });
    });

    vi.stubGlobal('fetch', fetchMock);

    const fakeEvent = {
      event_id: 'evt_001', event_type: 'LLM_CALL',
      timestamp: new Date().toISOString(), session_id: 'ses_001', agent_id: 'agent-1',
      duration_ms: 0, model: 'gpt-4o', provider: 'openai',
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      stream: false, config_applied: false,
    } as unknown as SyrinEvent;

    (emitter as unknown as { queue: Array<{ event: SyrinEvent; sessionId: string }> }).queue.push({
      event: fakeEvent,
      sessionId: 'ses_001',
    });

    await emitter.flush();
    vi.unstubAllGlobals();

    const injectionEvents = capturedEvents.filter(e => e.event.event_type === 'CONTEXT_INJECTION');
    expect(injectionEvents).toHaveLength(1);

    const injEvent = injectionEvents[0].event as unknown as {
      event_type: string;
      injection_source: string;
      injection_type: string;
      content_hash: string;
      content?: string;
    };
    expect(injEvent.event_type).toBe('CONTEXT_INJECTION');
    expect(injEvent.injection_source).toBe('operator');
    expect(injEvent.injection_type).toBe('message');
    expect(injEvent.content_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(injEvent.content).toBeUndefined(); // captureContent=false
  });

  it('should include content when captureContent=true', async () => {
    const injection = makeInjection({ content: 'Captured content here.' });
    const fetchMock = mockFetch({
      ok: true,
      pending_injections: [injection],
    });

    const config = makeConfig({ captureContent: true });
    const sessionStore = new SessionStore();
    await sessionStore.getOrCreate('ses_cap', 'agent-cap');

    const emitter = new Emitter(config, sessionStore);

    const capturedEvents: Array<{ event: SyrinEvent; sessionId: string }> = [];
    vi.spyOn(emitter, 'emit').mockImplementation((ev, sid) => {
      capturedEvents.push({ event: ev, sessionId: sid });
    });

    vi.stubGlobal('fetch', fetchMock);

    const fakeEvent = {
      event_id: 'evt_cap', event_type: 'LLM_CALL',
      timestamp: new Date().toISOString(), session_id: 'ses_cap', agent_id: 'agent-cap',
      duration_ms: 0, model: 'gpt-4o', provider: 'openai',
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      stream: false, config_applied: false,
    } as unknown as SyrinEvent;

    (emitter as unknown as { queue: Array<{ event: SyrinEvent; sessionId: string }> }).queue.push({
      event: fakeEvent,
      sessionId: 'ses_cap',
    });

    await emitter.flush();
    vi.unstubAllGlobals();

    const injectionEvents = capturedEvents.filter(e => e.event.event_type === 'CONTEXT_INJECTION');
    expect(injectionEvents).toHaveLength(1);

    const injEvent = injectionEvents[0].event as unknown as { content?: string };
    expect(injEvent.content).toBe('Captured content here.');
  });

  it('should omit content when captureContent=false', async () => {
    const injection = makeInjection({ content: 'Private content.' });
    const fetchMock = mockFetch({
      ok: true,
      pending_injections: [injection],
    });

    const config = makeConfig({ captureContent: false });
    const sessionStore = new SessionStore();
    await sessionStore.getOrCreate('ses_priv', 'agent-priv');

    const emitter = new Emitter(config, sessionStore);

    const capturedEvents: Array<{ event: SyrinEvent; sessionId: string }> = [];
    vi.spyOn(emitter, 'emit').mockImplementation((ev, sid) => {
      capturedEvents.push({ event: ev, sessionId: sid });
    });

    vi.stubGlobal('fetch', fetchMock);

    const fakeEvent = {
      event_id: 'evt_priv', event_type: 'LLM_CALL',
      timestamp: new Date().toISOString(), session_id: 'ses_priv', agent_id: 'agent-priv',
      duration_ms: 0, model: 'gpt-4o', provider: 'openai',
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      stream: false, config_applied: false,
    } as unknown as SyrinEvent;

    (emitter as unknown as { queue: Array<{ event: SyrinEvent; sessionId: string }> }).queue.push({
      event: fakeEvent,
      sessionId: 'ses_priv',
    });

    await emitter.flush();
    vi.unstubAllGlobals();

    const injectionEvents = capturedEvents.filter(e => e.event.event_type === 'CONTEXT_INJECTION');
    expect(injectionEvents).toHaveLength(1);

    const injEvent = injectionEvents[0].event as unknown as { content?: string };
    expect(injEvent.content).toBeUndefined();
  });

  it('should emit one CONTEXT_INJECTION event per injection', async () => {
    const injections = [
      makeInjection({ id: 'inj_a', content: 'First injection.' }),
      makeInjection({ id: 'inj_b', content: 'Second injection.' }),
    ];
    const fetchMock = mockFetch({
      ok: true,
      pending_injections: injections,
    });

    const config = makeConfig();
    const sessionStore = new SessionStore();
    await sessionStore.getOrCreate('ses_multi', 'agent-multi');

    const emitter = new Emitter(config, sessionStore);

    const capturedEvents: Array<{ event: SyrinEvent; sessionId: string }> = [];
    vi.spyOn(emitter, 'emit').mockImplementation((ev, sid) => {
      capturedEvents.push({ event: ev, sessionId: sid });
    });

    vi.stubGlobal('fetch', fetchMock);

    (emitter as unknown as { queue: Array<{ event: SyrinEvent; sessionId: string }> }).queue.push({
      event: { event_id: 'evt_m', event_type: 'LLM_CALL', session_id: 'ses_multi' } as unknown as SyrinEvent,
      sessionId: 'ses_multi',
    });

    await emitter.flush();
    vi.unstubAllGlobals();

    const injectionEvents = capturedEvents.filter(e => e.event.event_type === 'CONTEXT_INJECTION');
    expect(injectionEvents).toHaveLength(2);
  });

  it('should not emit CONTEXT_INJECTION when no injections pending', async () => {
    const fetchMock = mockFetch({ ok: true });
    const config = makeConfig();
    const sessionStore = new SessionStore();
    await sessionStore.getOrCreate('ses_none', 'agent-none');

    const emitter = new Emitter(config, sessionStore);

    const capturedEvents: Array<{ event: SyrinEvent; sessionId: string }> = [];
    vi.spyOn(emitter, 'emit').mockImplementation((ev, sid) => {
      capturedEvents.push({ event: ev, sessionId: sid });
    });

    vi.stubGlobal('fetch', fetchMock);

    (emitter as unknown as { queue: Array<{ event: SyrinEvent; sessionId: string }> }).queue.push({
      event: { event_id: 'evt_n', event_type: 'LLM_CALL', session_id: 'ses_none' } as unknown as SyrinEvent,
      sessionId: 'ses_none',
    });

    await emitter.flush();
    vi.unstubAllGlobals();

    const injectionEvents = capturedEvents.filter(e => e.event.event_type === 'CONTEXT_INJECTION');
    expect(injectionEvents).toHaveLength(0);
  });

  it('content_hash should be a 16-char lowercase hex string', async () => {
    const injection = makeInjection({ content: 'Hello world context.' });
    const fetchMock = mockFetch({
      ok: true,
      pending_injections: [injection],
    });

    const config = makeConfig();
    const sessionStore = new SessionStore();
    await sessionStore.getOrCreate('ses_hash', 'agent-hash');

    const emitter = new Emitter(config, sessionStore);

    const capturedEvents: Array<{ event: SyrinEvent; sessionId: string }> = [];
    vi.spyOn(emitter, 'emit').mockImplementation((ev, sid) => {
      capturedEvents.push({ event: ev, sessionId: sid });
    });

    vi.stubGlobal('fetch', fetchMock);

    (emitter as unknown as { queue: Array<{ event: SyrinEvent; sessionId: string }> }).queue.push({
      event: { event_id: 'evt_h', event_type: 'LLM_CALL', session_id: 'ses_hash' } as unknown as SyrinEvent,
      sessionId: 'ses_hash',
    });

    await emitter.flush();
    vi.unstubAllGlobals();

    const injectionEvents = capturedEvents.filter(e => e.event.event_type === 'CONTEXT_INJECTION');
    expect(injectionEvents).toHaveLength(1);
    const injEvent = injectionEvents[0].event as unknown as { content_hash: string };
    expect(injEvent.content_hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
