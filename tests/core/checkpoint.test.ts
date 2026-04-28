/**
 * Tests: src/core/checkpoint.ts — CheckpointClient save/restore/list + CheckpointManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { CheckpointClient, CheckpointManager } from '@/core/checkpoint';
import type { SyrinConfig } from '@/types';

const server = setupServer();

beforeEach(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterEach(() => server.close());

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4400',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4400',
    debug: false,
    captureContent: false,
    offline: false,
    batchIntervalMs: 60000,
    batchSize: 50,
    ...overrides,
  };
}

const MESSAGES = [
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi there' },
];

describe('CheckpointClient.save', () => {
  it('creates a checkpoint with required fields', async () => {
    server.use(
      http.post('http://localhost:4400/api/v1/checkpoints', () =>
        HttpResponse.json({ ok: true })
      )
    );

    const client = new CheckpointClient(makeConfig());
    const cp = await client.save('ses_1', MESSAGES);

    expect(cp.checkpointId).toMatch(/^ckpt_/);
    expect(cp.sessionId).toBe('ses_1');
    expect(cp.messages).toEqual(MESSAGES);
    expect(cp.createdAt).toBeDefined();
    expect(cp.callCount).toBe(0);
    expect(cp.cumulativeCostUsd).toBe(0);
  });

  it('stores label and metadata', async () => {
    server.use(
      http.post('http://localhost:4400/api/v1/checkpoints', () =>
        HttpResponse.json({ ok: true })
      )
    );

    const client = new CheckpointClient(makeConfig());
    const cp = await client.save('ses_2', MESSAGES, {
      label: 'pre-recovery',
      metadata: { source: 'test' },
    });

    expect(cp.label).toBe('pre-recovery');
    expect(cp.metadata).toEqual({ source: 'test' });
  });

  it('stores callCount and cumulativeCostUsd', async () => {
    server.use(
      http.post('http://localhost:4400/api/v1/checkpoints', () =>
        HttpResponse.json({ ok: true })
      )
    );

    const client = new CheckpointClient(makeConfig());
    const cp = await client.save('ses_3', MESSAGES, {
      callCount: 5,
      cumulativeCostUsd: 0.25,
    });

    expect(cp.callCount).toBe(5);
    expect(cp.cumulativeCostUsd).toBe(0.25);
  });

  it('adds to local cache even when backend unavailable', async () => {
    // No server handler — backend unreachable
    const client = new CheckpointClient(makeConfig());
    const cp = await client.save('ses_4', MESSAGES);

    // Should still be retrievable from local cache
    const retrieved = await client.getById(cp.checkpointId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.checkpointId).toBe(cp.checkpointId);
  });

  it('does NOT make HTTP call when offline=true', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new CheckpointClient(makeConfig({ offline: true }));
    await client.save('ses_5', MESSAGES);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('POSTs correct payload to backend', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.post('http://localhost:4400/api/v1/checkpoints', async ({ request }) => {
        captured = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      })
    );

    const client = new CheckpointClient(makeConfig());
    const cp = await client.save('ses_6', MESSAGES, { label: 'test-label' });

    expect(captured).not.toBeNull();
    expect(captured!['checkpoint_id']).toBe(cp.checkpointId);
    expect(captured!['session_id']).toBe('ses_6');
    expect(captured!['label']).toBe('test-label');
  });
});

describe('CheckpointClient.getById', () => {
  it('returns from local cache without hitting backend', async () => {
    server.use(
      http.post('http://localhost:4400/api/v1/checkpoints', () =>
        HttpResponse.json({ ok: true })
      )
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new CheckpointClient(makeConfig());
    const cp = await client.save('ses_7', MESSAGES);

    const callsBefore = fetchSpy.mock.calls.length;
    const retrieved = await client.getById(cp.checkpointId);
    expect(retrieved?.checkpointId).toBe(cp.checkpointId);
    // No additional fetch calls (used local cache)
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
    fetchSpy.mockRestore();
  });

  it('fetches from backend when not in local cache', async () => {
    const checkpointId = 'ckpt_remote_1';
    server.use(
      http.get(`http://localhost:4400/api/v1/checkpoints/${checkpointId}`, () =>
        HttpResponse.json({
          ok: true,
          checkpoint: {
            checkpoint_id: checkpointId,
            session_id: 'ses_remote',
            messages: MESSAGES,
            active_config: { temperature: 0.5 },
            call_count: 3,
            cumulative_cost_usd: 0.1,
            created_at: new Date().toISOString(),
            label: null,
            metadata: {},
          },
        })
      )
    );

    const client = new CheckpointClient(makeConfig());
    const retrieved = await client.getById(checkpointId);
    expect(retrieved?.checkpointId).toBe(checkpointId);
    expect(retrieved?.sessionId).toBe('ses_remote');
    expect(retrieved?.callCount).toBe(3);
  });

  it('returns undefined when backend returns 404', async () => {
    server.use(
      http.get('http://localhost:4400/api/v1/checkpoints/ckpt_missing', () =>
        new HttpResponse(null, { status: 404 })
      )
    );

    const client = new CheckpointClient(makeConfig());
    const result = await client.getById('ckpt_missing');
    expect(result).toBeUndefined();
  });

  it('returns undefined when offline and not in cache', async () => {
    const client = new CheckpointClient(makeConfig({ offline: true }));
    const result = await client.getById('ckpt_not_here');
    expect(result).toBeUndefined();
  });

  it('warms local cache after backend fetch', async () => {
    const checkpointId = 'ckpt_warm_1';
    server.use(
      http.get(`http://localhost:4400/api/v1/checkpoints/${checkpointId}`, () =>
        HttpResponse.json({
          ok: true,
          checkpoint: {
            checkpoint_id: checkpointId,
            session_id: 'ses_warm',
            messages: MESSAGES,
            active_config: {},
            call_count: 0,
            cumulative_cost_usd: 0,
            created_at: new Date().toISOString(),
            label: 'warm-label',
            metadata: {},
          },
        })
      )
    );

    const client = new CheckpointClient(makeConfig());
    // First call — fetches from backend
    const first = await client.getById(checkpointId);
    expect(first?.label).toBe('warm-label');

    // Second call — should come from local cache (no extra backend call needed)
    const second = await client.getById(checkpointId);
    expect(second?.checkpointId).toBe(checkpointId);
  });
});

describe('CheckpointClient.listForSession / getLatest', () => {
  it('listForSession returns all checkpoints for a session', async () => {
    server.use(
      http.post('http://localhost:4400/api/v1/checkpoints', () =>
        HttpResponse.json({ ok: true })
      )
    );

    const client = new CheckpointClient(makeConfig());
    await client.save('ses_list_1', [{ role: 'user', content: 'a' }]);
    await client.save('ses_list_1', [{ role: 'user', content: 'b' }]);
    await client.save('ses_list_2', [{ role: 'user', content: 'c' }]);

    const list = client.listForSession('ses_list_1');
    expect(list).toHaveLength(2);
    expect(list[0].sessionId).toBe('ses_list_1');
  });

  it('returns empty array for unknown session', () => {
    const client = new CheckpointClient(makeConfig());
    const list = client.listForSession('ses_unknown');
    expect(list).toEqual([]);
  });

  it('getLatest returns the most recent checkpoint', async () => {
    server.use(
      http.post('http://localhost:4400/api/v1/checkpoints', () =>
        HttpResponse.json({ ok: true })
      )
    );

    const client = new CheckpointClient(makeConfig());
    await client.save('ses_latest', [{ role: 'user', content: 'first' }]);
    const second = await client.save('ses_latest', [{ role: 'user', content: 'second' }]);

    const latest = client.getLatest('ses_latest');
    expect(latest?.checkpointId).toBe(second.checkpointId);
  });

  it('getLatest returns undefined for unknown session', () => {
    const client = new CheckpointClient(makeConfig());
    expect(client.getLatest('ses_unknown')).toBeUndefined();
  });
});

describe('CheckpointManager (backward-compat alias)', () => {
  it('create returns a checkpoint with correct fields', () => {
    const mgr = new CheckpointManager();
    const cp = mgr.create('ses_1', MESSAGES, { temperature: 0.5 }, 3, 0.1, { label: 'test' });

    expect(cp.checkpointId).toMatch(/^ckpt_/);
    expect(cp.sessionId).toBe('ses_1');
    expect(cp.messages).toEqual(MESSAGES);
    expect(cp.activeConfig).toEqual({ temperature: 0.5 });
    expect(cp.callCount).toBe(3);
    expect(cp.cumulativeCostUsd).toBe(0.1);
    expect(cp.label).toBe('test');
  });

  it('getById returns stored checkpoint', () => {
    const mgr = new CheckpointManager();
    const cp = mgr.create('ses_2', MESSAGES);
    const found = mgr.getById(cp.checkpointId);
    expect(found?.checkpointId).toBe(cp.checkpointId);
  });

  it('getById returns undefined for unknown', () => {
    const mgr = new CheckpointManager();
    expect(mgr.getById('ckpt_not_here')).toBeUndefined();
  });

  it('getLatest returns most recent', () => {
    const mgr = new CheckpointManager();
    mgr.create('ses_3', []);
    const cp2 = mgr.create('ses_3', MESSAGES);
    expect(mgr.getLatest('ses_3')?.checkpointId).toBe(cp2.checkpointId);
  });

  it('listForSession returns all for session', () => {
    const mgr = new CheckpointManager();
    mgr.create('ses_4', []);
    mgr.create('ses_4', MESSAGES);
    expect(mgr.listForSession('ses_4')).toHaveLength(2);
  });

  it('delete removes a checkpoint', () => {
    const mgr = new CheckpointManager();
    const cp = mgr.create('ses_5', MESSAGES);
    const deleted = mgr.delete(cp.checkpointId);
    expect(deleted).toBe(true);
    expect(mgr.getById(cp.checkpointId)).toBeUndefined();
  });

  it('delete returns false for unknown id', () => {
    const mgr = new CheckpointManager();
    expect(mgr.delete('ckpt_not_here')).toBe(false);
  });

  it('clearSession removes all checkpoints for session', () => {
    const mgr = new CheckpointManager();
    mgr.create('ses_6', []);
    mgr.create('ses_6', MESSAGES);
    const count = mgr.clearSession('ses_6');
    expect(count).toBe(2);
    expect(mgr.listForSession('ses_6')).toEqual([]);
  });

  it('messages array is copied (new array reference)', () => {
    const mgr = new CheckpointManager();
    const msgs = [{ role: 'user', content: 'original' }];
    const cp = mgr.create('ses_7', msgs);
    // The stored array should be a different reference
    expect(cp.messages).not.toBe(msgs);
  });
});
