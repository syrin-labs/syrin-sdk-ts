/**
 * Tests: module-level withAgent / withWorkflow / withSwarm from src/index.ts
 *
 * These wrappers emit AGENT_RUN_STARTED/ENDED, WORKFLOW_STARTED/ENDED,
 * SWARM_STARTED/ENDED lifecycle events in addition to setting AsyncLocalStorage context.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { init, withAgent, withWorkflow, withSwarm, getRunContext, shutdown } from '@/index';
import type { SyrinConfig, IngestPayload } from '@/types';

// ── MSW server to capture emitted events ─────────────────────────────────────

const capturedBodies: IngestPayload[] = [];

const server = setupServer(
  http.get('http://localhost:4410/api/v1/health', () => HttpResponse.json({ ok: true })),
  http.post('http://localhost:4410/api/v1/ingest', async ({ request }) => {
    capturedBodies.push(await request.json() as IngestPayload);
    return HttpResponse.json({ ok: true });
  }),
  http.post('http://localhost:4410/api/v1/agents/:id/register', () =>
    HttpResponse.json({ ok: true }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(async () => {
  server.resetHandlers();
  capturedBodies.length = 0;
  await shutdown();
});
afterAll(() => server.close());

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test_key',
    backendUrl: 'http://localhost:4410',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4410',
    debug: false,
    captureContent: false,
    batchSize: 1,
    idleFlushMs: 9999,
    httpTimeoutMs: 500,
    heartbeatTimeoutMs: 500,
    heartbeatIntervalMs: 9999,
    pollTimeoutMs: 500,
    maxQueueSize: 1000,
    configHistoryMaxlen: 50,
    configAuditMaxlen: 100,
    offline: false,
    ...overrides,
  };
}

// ── withAgent ─────────────────────────────────────────────────────────────────

describe('withAgent (index-level)', () => {
  it('sets agentId in run context inside the callback', async () => {
    await init(makeConfig());
    let ctx: ReturnType<typeof getRunContext>;
    await withAgent('researcher', async (runCtx) => {
      ctx = getRunContext();
      expect(runCtx.agentId).toBe('researcher');
    });
    expect(ctx?.agentId).toBe('researcher');
  });

  it('clears run context after callback completes', async () => {
    await init(makeConfig());
    await withAgent('writer', async () => { /* noop */ });
    expect(getRunContext()).toBeUndefined();
  });

  it('clears run context on error', async () => {
    await init(makeConfig());
    await expect(withAgent('faulty', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(getRunContext()).toBeUndefined();
  });

  it('returns value from callback', async () => {
    await init(makeConfig());
    const result = await withAgent('agent', async () => 42);
    expect(result).toBe(42);
  });

  it('uses provided runId', async () => {
    await init(makeConfig());
    let captured: ReturnType<typeof getRunContext>;
    await withAgent('a', async () => { captured = getRunContext(); }, { runId: 'run-custom' });
    expect(captured?.runId).toBe('run-custom');
  });
});

// ── withWorkflow ──────────────────────────────────────────────────────────────

describe('withWorkflow (index-level)', () => {
  it('sets workflowId in run context', async () => {
    await init(makeConfig());
    let ctx: ReturnType<typeof getRunContext>;
    await withWorkflow('pipeline', async () => { ctx = getRunContext(); });
    expect(ctx?.workflowId).toBe('pipeline');
  });

  it('auto-generates workflowId when undefined', async () => {
    await init(makeConfig());
    let ctx: ReturnType<typeof getRunContext>;
    await withWorkflow(undefined, async () => { ctx = getRunContext(); });
    expect(ctx?.workflowId).toMatch(/^wf_/);
  });

  it('clears context after completion', async () => {
    await init(makeConfig());
    await withWorkflow('wf', async () => { /* noop */ });
    expect(getRunContext()).toBeUndefined();
  });

  it('propagates workflowId into nested withAgent', async () => {
    await init(makeConfig());
    let inner: ReturnType<typeof getRunContext>;
    await withWorkflow('outer-wf', async () => {
      await withAgent('inner', async () => { inner = getRunContext(); });
    });
    expect(inner?.workflowId).toBe('outer-wf');
    expect(inner?.agentId).toBe('inner');
  });
});

// ── withSwarm ─────────────────────────────────────────────────────────────────

describe('withSwarm (index-level)', () => {
  it('sets swarmId in run context', async () => {
    await init(makeConfig());
    let ctx: ReturnType<typeof getRunContext>;
    await withSwarm('my-swarm', async () => { ctx = getRunContext(); });
    expect(ctx?.swarmId).toBe('my-swarm');
  });

  it('auto-generates swarmId when undefined', async () => {
    await init(makeConfig());
    let ctx: ReturnType<typeof getRunContext>;
    await withSwarm(undefined, async () => { ctx = getRunContext(); });
    expect(ctx?.swarmId).toMatch(/^swarm_/);
  });

  it('clears context after completion', async () => {
    await init(makeConfig());
    await withSwarm('s1', async () => { /* noop */ });
    expect(getRunContext()).toBeUndefined();
  });

  it('propagates swarmId into nested withAgent', async () => {
    await init(makeConfig());
    let inner: ReturnType<typeof getRunContext>;
    await withSwarm('my-swarm', async () => {
      await withAgent('member', async () => { inner = getRunContext(); });
    });
    expect(inner?.swarmId).toBe('my-swarm');
    expect(inner?.agentId).toBe('member');
  });
});

// ── Lifecycle event emission ──────────────────────────────────────────────────

describe('lifecycle event emission', () => {
  beforeEach(() => { capturedBodies.length = 0; });

  it('withAgent emits AGENT_RUN_STARTED and AGENT_RUN_ENDED', async () => {
    const sdk = await init(makeConfig({ batchSize: 100, idleFlushMs: 99999 }));
    await withAgent('reporter', async () => { /* noop */ });
    await sdk.flush();
    const allEvents = capturedBodies.flatMap(b => b.events);
    const types = allEvents.map(e => e.event_type);
    expect(types).toContain('AGENT_RUN_STARTED');
    expect(types).toContain('AGENT_RUN_ENDED');
  });

  it('withWorkflow emits WORKFLOW_STARTED and WORKFLOW_ENDED', async () => {
    const sdk = await init(makeConfig({ batchSize: 100, idleFlushMs: 99999 }));
    await withWorkflow('my-wf', async () => { /* noop */ });
    await sdk.flush();
    const allEvents = capturedBodies.flatMap(b => b.events);
    const types = allEvents.map(e => e.event_type);
    expect(types).toContain('WORKFLOW_STARTED');
    expect(types).toContain('WORKFLOW_ENDED');
  });

  it('withSwarm emits SWARM_STARTED and SWARM_ENDED', async () => {
    const sdk = await init(makeConfig({ batchSize: 100, idleFlushMs: 99999 }));
    await withSwarm('my-swarm', async () => { /* noop */ });
    await sdk.flush();
    const allEvents = capturedBodies.flatMap(b => b.events);
    const types = allEvents.map(e => e.event_type);
    expect(types).toContain('SWARM_STARTED');
    expect(types).toContain('SWARM_ENDED');
  });
});
