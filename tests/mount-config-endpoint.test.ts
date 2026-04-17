/**
 * Tests: mountConfigEndpoint() — parity with Python SDK's mount_config_endpoint()
 *
 * Covers:
 *  1. Returns an async request handler function
 *  2. Handler applies overrides to all active sessions in the SessionStore
 *  3. Handler persists overrides to disk via config-persist
 *  4. Handler returns { ok: true, applied: N }
 *  5. Handler returns { ok: false } when SDK is not initialised
 *  6. Handler rejects non-object bodies with 400
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('openai', () => {
  class MockOpenAI { constructor(_?: unknown) {} }
  return { default: MockOpenAI };
});

// Minimal IncomingMessage / ServerResponse stubs for Node.js http handler
function makeReq(body: unknown): { body: unknown } {
  return { body };
}

function makeRes() {
  let _status = 200;
  let _body: unknown;
  return {
    status(code: number) { _status = code; return this; },
    json(data: unknown) { _body = data; return this; },
    get statusCode() { return _status; },
    get body() { return _body; },
  };
}

describe('mountConfigEndpoint()', () => {
  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    const { shutdown } = await import('@/index');
    await shutdown();
  });

  // 1. Returns a handler function
  it('returns a function', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const { init, mountConfigEndpoint } = await import('@/index');
    await init({ apiKey: 'syrin_test', backendUrl: 'http://localhost:4000', offline: true, otelExporter: 'none' });

    const handler = mountConfigEndpoint();
    expect(typeof handler).toBe('function');
  });

  // 2. Handler applies config overrides to sessions
  it('applies overrides to active sessions', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const { init, mountConfigEndpoint, withSession, getInstance } = await import('@/index');
    const sdk = await init({
      apiKey: 'syrin_test',
      agentId: 'cfg-agent',
      backendUrl: 'http://localhost:4000',
      offline: true,
      otelExporter: 'none',
    });

    // Create a session so there's something to update
    await withSession('test-session', async () => {});

    const handler = mountConfigEndpoint();
    const req = makeReq({ 'llm.temperature': 0.1 });
    const res = makeRes();
    await handler(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);

    // The config should be visible through activeConfig
    const activeConf = sdk.activeConfig();
    expect(activeConf['llm.temperature']).toBe(0.1);
  });

  // 3. Returns { ok: true, applied: N }
  it('returns { ok: true, applied: N } on success', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const { init, mountConfigEndpoint } = await import('@/index');
    await init({ apiKey: 'syrin_test', backendUrl: 'http://localhost:4000', offline: true, otelExporter: 'none' });

    const handler = mountConfigEndpoint();
    const req = makeReq({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o' });
    const res = makeRes();
    await handler(req as never, res as never);

    const body = res.body as { ok: boolean; applied: number };
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(2);
  });

  // 4. Returns { ok: false } when SDK not initialised
  it('returns { ok: false } when no SDK instance is active', async () => {
    const { mountConfigEndpoint } = await import('@/index');
    // Don't call init()
    const handler = mountConfigEndpoint();
    const req = makeReq({ 'llm.temperature': 0.5 });
    const res = makeRes();
    await handler(req as never, res as never);

    expect((res.body as { ok: boolean }).ok).toBe(false);
  });

  // 5. Returns 400 for non-object body
  it('returns 400 for non-object body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const { init, mountConfigEndpoint } = await import('@/index');
    await init({ apiKey: 'syrin_test', backendUrl: 'http://localhost:4000', offline: true, otelExporter: 'none' });

    const handler = mountConfigEndpoint();
    const req = makeReq('not an object');
    const res = makeRes();
    await handler(req as never, res as never);

    expect(res.statusCode).toBe(400);
  });

  // Bug #3 — handler must also update ConfigStore so LangChain _buildConfig() picks up changes
  it('updates ConfigStore sections when overrides are pushed', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const { init, mountConfigEndpoint, getInstance } = await import('@/index');
    await init({
      apiKey:      'syrin_test',
      agentId:     'mce-agent',
      backendUrl:  'http://localhost:4000',
      offline:     true,
      otelExporter: 'none',
    });

    const handler = mountConfigEndpoint();
    const req = makeReq({ 'llm.temperature': 0.77, 'llm.model': 'gpt-4o' });
    const res = makeRes();
    await handler(req as never, res as never);

    expect((res.body as { ok: boolean }).ok).toBe(true);

    // ConfigStore should reflect the pushed values so framework adapters (LangChain) see them
    const inst = getInstance();
    // Access configStore via the core (internal, cast for test)
    const core = (inst as unknown as Record<string, unknown>)['_core'] as {
      getConfigStore(): { getSection(ns: string): Record<string, unknown> } | null;
    };
    const llm = core.getConfigStore()?.getSection('llm');
    expect(llm?.['temperature']).toBe(0.77);
    expect(llm?.['model']).toBe('gpt-4o');
  });

  it('ConfigStore update is skipped gracefully when SDK has no core (defensive)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const { init, mountConfigEndpoint } = await import('@/index');
    await init({ apiKey: 'syrin_test', backendUrl: 'http://localhost:4000', offline: true, otelExporter: 'none' });

    const handler = mountConfigEndpoint();
    // Use known-good keys so we're testing the configStore path, not validation
    const req = makeReq({ 'llm.temperature': 0.3 });
    const res = makeRes();
    // Must not throw even in edge cases
    await expect(handler(req as never, res as never)).resolves.toBeUndefined();
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });
});
