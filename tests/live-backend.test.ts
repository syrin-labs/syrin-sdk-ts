/**
 * Live integration tests for the TypeScript Syrin SDK against a real backend.
 *
 * These tests are SKIPPED automatically when:
 *   - SYRIN_TEST_BACKEND_URL is not set, OR
 *   - SYRIN_TEST_API_KEY is not set
 *
 * To run them against a live backend:
 *   SYRIN_TEST_BACKEND_URL=http://localhost:4000 \
 *   SYRIN_TEST_API_KEY=syrin_your_key \
 *   npm test -- tests/live-backend.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateId, nowIso } from '@/utils/helpers';

const BACKEND_URL = process.env.SYRIN_TEST_BACKEND_URL ?? '';
const API_KEY = process.env.SYRIN_TEST_API_KEY ?? '';
const SKIP = !BACKEND_URL || !API_KEY;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}` };
}

async function resetSdkState(): Promise<void> {
  // Attempt to shut down any lingering default instance
  try {
    const { shutdown } = await import('../src/index.js');
    await shutdown('default').catch(() => {/* non-fatal */});
  } catch {
    /* non-fatal */
  }
}

function makeSyntheticLlmEvent() {
  return {
    event_id: generateId('evt_'),
    event_type: 'LLM_CALL',
    timestamp: nowIso(),
    duration_ms: 80,
    model: 'gpt-4o',
    provider: 'openai',
    input_tokens: 20,
    output_tokens: 10,
    cost_usd: 0.0001,
    stream: false,
    config_applied: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('Live SDK integration — TypeScript', () => {
  beforeEach(async () => {
    await resetSdkState();
  });

  afterEach(async () => {
    await resetSdkState();
  });

  // ── 1. Agent registration ──────────────────────────────────────────────

  it('registers agent and backend confirms via /overrides', async () => {
    const { init, shutdown } = await import('../src/index.js');

    await init({
      apiKey: API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'ts-live-test',
      offline: false,
      batchIntervalMs: 9_999_999,
      otelExporter: 'none',
    });

    // Backend should now know about this agent
    const resp = await fetch(
      `${BACKEND_URL}/api/v1/agents/ts-live-test/overrides`,
      { headers: authHeaders() },
    );
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.ok === true || 'overrides' in data || 'agent_id' in data).toBe(true);

    await shutdown();
  });

  // ── 2. Emitter flush ──────────────────────────────────────────────────

  it('emits an LLM_CALL event and backend processes it without error', async () => {
    const { init, shutdown } = await import('../src/index.js');
    const sdk = await init({
      apiKey: API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'ts-emit-test',
      offline: false,
      batchIntervalMs: 9_999_999,
      otelExporter: 'none',
    });

    // Access internal emitter via the SDK instance
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const emitter = (sdk as unknown as Record<string, unknown>)['_emitter'] as { emit: (...args: unknown[]) => void; flush: () => Promise<void> };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const sessionStore = (sdk as unknown as Record<string, unknown>)['_sessionStore'] as { getOrCreate?: (id: string, agentId?: string) => Promise<unknown> } | undefined;
    const sessionId = generateId('ses_');
    void sessionStore?.getOrCreate(sessionId, 'ts-emit-test');

    emitter.emit(makeSyntheticLlmEvent() as Parameters<typeof emitter.emit>[0], sessionId);

    // Should not throw
    await expect(emitter.flush()).resolves.toBeUndefined();

    await shutdown();
  });

  // ── 3. Ingest response wire format ────────────────────────────────────

  it('ingest response has the correct documented shape', async () => {
    const payload = {
      api_key: API_KEY,
      session_id: generateId('ses_'),
      agent_id: 'ts-shape-test',
      sdk: { language: 'typescript', version: '1.0.0' },
      events: [
        {
          event_id: generateId('evt_'),
          event_type: 'LLM_CALL',
          timestamp: nowIso(),
          duration_ms: 120,
          model: 'gpt-4o',
          provider: 'openai',
          input_tokens: 15,
          output_tokens: 8,
          cost_usd: 0.0001,
          stream: false,
        },
      ],
    };

    const resp = await fetch(`${BACKEND_URL}/api/v1/ingest`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(resp.status).toBe(200);
    const data = (await resp.json()) as Record<string, unknown>;

    expect(data.ok).toBe(true);
    expect(data).toHaveProperty('config_updates');
    expect(data).toHaveProperty('governance');

    const gov = data.governance as Record<string, unknown>;
    expect(gov).toHaveProperty('actions');
    expect(Array.isArray(gov.actions)).toBe(true);
  });

  // ── 4. Heartbeat ──────────────────────────────────────────────────────

  it('heartbeat sends to backend without error', async () => {
    const { Heartbeat } = await import('../src/core/heartbeat.js');

    const hb = new Heartbeat({
      agentId: 'ts-hb-test',
      backendUrl: BACKEND_URL,
      apiKey: API_KEY,
      offline: false,
      intervalMs: 9_999_999,
    });

    hb.start();
    // stop() sends the stopped=true heartbeat internally
    await expect(hb.stop()).resolves.toBeUndefined();
  });

  // ── 5. Shutdown sends stopped heartbeat ───────────────────────────────

  it('shutdown() completes without throwing', async () => {
    const { init, shutdown } = await import('../src/index.js');

    await init({
      apiKey: API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'ts-shutdown-test',
      offline: false,
      batchIntervalMs: 9_999_999,
      otelExporter: 'none',
    });

    await expect(shutdown()).resolves.toBeUndefined();
  });

  // ── 6. Backend health sanity check ────────────────────────────────────

  it('backend /health endpoint returns 200', async () => {
    const resp = await fetch(`${BACKEND_URL}/api/v1/health`);
    expect(resp.status).toBe(200);
  });

  // ── 7. Multiple event types accepted by backend ───────────────────────

  it('backend accepts all common SDK event types without 400', async () => {
    const eventTypes = [
      'LLM_CALL',
      'SESSION_STARTED',
      'SESSION_ENDED',
      'CHAIN_EXECUTION',
      'AGENT_RUN',
      'TOOL_CALL',
      'CUSTOM',
    ];

    const payload = {
      api_key: API_KEY,
      session_id: generateId('ses_'),
      agent_id: 'ts-event-types-test',
      sdk: { language: 'typescript', version: '1.0.0' },
      events: eventTypes.map((event_type) => ({
        event_id: generateId('evt_'),
        event_type,
        timestamp: nowIso(),
      })),
    };

    const resp = await fetch(`${BACKEND_URL}/api/v1/ingest`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(resp.status).not.toBe(400);
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });
});
