/**
 * Tests: Heartbeat — parity with Python SDK
 *
 * Covers:
 *  1. Heartbeat sends POST /agents/:id/heartbeat every 30 s
 *  2. Heartbeat body is { stopped: false }
 *  3. shutdown() sends { stopped: true } before stopping
 *  4. Heartbeat is skipped when offline: true
 *  5. Heartbeat is skipped when agentId is not set
 *  6. Heartbeat uses correct Authorization header
 *  7. Network failure on heartbeat is non-fatal (does not throw)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Heartbeat } from '@/core/heartbeat';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeHeartbeatManager(opts: {
  agentId?: string;
  backendUrl?: string;
  apiKey?: string;
  offline?: boolean;
  intervalMs?: number;
}) {
  return new Heartbeat({
    agentId: 'agentId' in opts ? opts.agentId : 'test-agent',
    backendUrl: opts.backendUrl ?? 'http://localhost:4000',
    apiKey: opts.apiKey ?? 'syrin_test',
    offline: opts.offline ?? false,
    intervalMs: opts.intervalMs ?? 30_000,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Heartbeat', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // 1. Sends POST to correct URL after interval elapses
  it('sends POST /agents/:id/heartbeat after the interval', async () => {
    const hb = makeHeartbeatManager({ agentId: 'my-agent', intervalMs: 30_000 });
    hb.start();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/v1/agents/my-agent/heartbeat');
  });

  // 2. Body is { stopped: false } for a keep-alive ping
  it('sends { stopped: false } for a regular heartbeat', async () => {
    const hb = makeHeartbeatManager({ intervalMs: 30_000 });
    hb.start();

    await vi.advanceTimersByTimeAsync(30_000);

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string) as { stopped: boolean };
    expect(body.stopped).toBe(false);
  });

  // 3. stop() sends { stopped: true } immediately
  it('sends { stopped: true } when stop() is called', async () => {
    const hb = makeHeartbeatManager({ intervalMs: 30_000 });
    hb.start();
    await hb.stop();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/heartbeat');
    const body = JSON.parse(options.body as string) as { stopped: boolean };
    expect(body.stopped).toBe(true);
  });

  // 4. Skipped when offline
  it('does not send any heartbeat when offline: true', async () => {
    const hb = makeHeartbeatManager({ offline: true, intervalMs: 30_000 });
    hb.start();

    await vi.advanceTimersByTimeAsync(30_000);
    await hb.stop();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 5. Skipped when agentId is not set
  it('does not send heartbeat when agentId is undefined', async () => {
    const hb = makeHeartbeatManager({ agentId: undefined, intervalMs: 30_000 });
    hb.start();

    await vi.advanceTimersByTimeAsync(30_000);
    await hb.stop();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 6. Correct Authorization header
  it('sends the API key as a Bearer token', async () => {
    const hb = makeHeartbeatManager({ apiKey: 'syrin_abc123', intervalMs: 30_000 });
    hb.start();

    await vi.advanceTimersByTimeAsync(30_000);

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer syrin_abc123');
  });

  // 7. Network failure is non-fatal
  it('does not throw when fetch rejects', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));
    const hb = makeHeartbeatManager({ intervalMs: 30_000 });
    hb.start();

    // Advancing timers fires the heartbeat; fetch will reject — should not propagate
    await vi.advanceTimersByTimeAsync(30_000);
    await hb.stop(); // also fires with stopped:true — should not throw
    expect(fetchSpy).toHaveBeenCalled();
  });
});
