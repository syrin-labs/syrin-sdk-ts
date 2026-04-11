/**
 * Tests: refreshSchema() — parity with Python SDK's sdk.refresh_schema()
 *
 * Covers:
 *  1. SyrinSDKInstance exposes a refreshSchema() method
 *  2. refreshSchema() calls core.register() (re-sends schema to backend)
 *  3. Module-level refreshSchema() helper delegates to primary instance
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('openai', () => {
  class MockOpenAI { constructor(_?: unknown) {} }
  return { default: MockOpenAI };
});

describe('refreshSchema()', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
    const { shutdown } = await import('@/index');
    await shutdown();
  });

  // 1 & 2. refreshSchema() triggers a POST to /register
  it('sends a second POST to /agents/:id/register when refreshSchema() is called', async () => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const { init } = await import('@/index');
    const sdk = await init({
      apiKey: 'syrin_test',
      agentId: 'refresh-agent',
      backendUrl: 'http://localhost:4000',
      offline: true,
      otelExporter: 'none',
    });

    const callsBefore = fetchSpy.mock.calls.filter(([url]: [string]) =>
      url.includes('/register')
    ).length;

    await sdk.refreshSchema();

    const callsAfter = fetchSpy.mock.calls.filter(([url]: [string]) =>
      url.includes('/register')
    ).length;

    expect(callsAfter).toBe(callsBefore + 1);
  });

  // 3. Module-level helper
  it('module-level refreshSchema() delegates to primary instance', async () => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('@/index');
    await mod.init({
      apiKey: 'syrin_test',
      agentId: 'refresh-mod-agent',
      backendUrl: 'http://localhost:4000',
      offline: true,
      otelExporter: 'none',
    });

    const callsBefore = fetchSpy.mock.calls.filter(([url]: [string]) =>
      url.includes('/register')
    ).length;

    await mod.refreshSchema();

    const callsAfter = fetchSpy.mock.calls.filter(([url]: [string]) =>
      url.includes('/register')
    ).length;

    expect(callsAfter).toBe(callsBefore + 1);
  });
});
