/**
 * Tests: public API surface contract
 *
 * Ensures that all documented exports exist and the SyrinSDK interface
 * has all expected methods. These tests catch accidental removals or renames.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import * as SDK from '@/index';
import type { SyrinConfig } from '@/types';

// ── MSW server ────────────────────────────────────────────────────────────────

const server = setupServer(
  http.post('http://localhost:4411/api/v1/ingest', () => HttpResponse.json({ ok: true })),
  http.post('http://localhost:4411/api/v1/agents/:id/register', () => HttpResponse.json({ ok: true })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(async () => {
  server.resetHandlers();
  await SDK.shutdown();
});
afterAll(() => server.close());

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4411',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4411',
    debug: false,
    captureContent: false,
    batchSize: 100,
    idleFlushMs: 9999,
    httpTimeoutMs: 500,
    heartbeatTimeoutMs: 500,
    heartbeatIntervalMs: 9999,
    pollTimeoutMs: 500,
    maxQueueSize: 1000,
    configHistoryMaxlen: 50,
    configAuditMaxlen: 100,
    offline: true,
    ...overrides,
  };
}

// ── Module-level function exports ─────────────────────────────────────────────

describe('module-level function exports', () => {
  it('exports init', () => { expect(typeof SDK.init).toBe('function'); });
  it('exports shutdown', () => { expect(typeof SDK.shutdown).toBe('function'); });
  it('exports getInstance', () => { expect(typeof SDK.getInstance).toBe('function'); });
  it('exports getSessionId', () => { expect(typeof SDK.getSessionId).toBe('function'); });
  it('exports withAgent', () => { expect(typeof SDK.withAgent).toBe('function'); });
  it('exports withWorkflow', () => { expect(typeof SDK.withWorkflow).toBe('function'); });
  it('exports withSwarm', () => { expect(typeof SDK.withSwarm).toBe('function'); });
  it('exports withSession', () => { expect(typeof SDK.withSession).toBe('function'); });
  it('exports configure', () => { expect(typeof SDK.configure).toBe('function'); });
  it('exports configSnapshot', () => { expect(typeof SDK.configSnapshot).toBe('function'); });
  it('exports emit', () => { expect(typeof SDK.emit).toBe('function'); });
  it('exports log', () => { expect(typeof SDK.log).toBe('function'); });
  it('exports diagnose', () => { expect(typeof SDK.diagnose).toBe('function'); });
  it('exports healthCheck', () => { expect(typeof SDK.healthCheck).toBe('function'); });
  it('exports createCheckpoint', () => { expect(typeof SDK.createCheckpoint).toBe('function'); });
  it('exports restoreCheckpoint', () => { expect(typeof SDK.restoreCheckpoint).toBe('function'); });
  it('exports deleteSession', () => { expect(typeof SDK.deleteSession).toBe('function'); });
  it('exports clearStaleSessions', () => { expect(typeof SDK.clearStaleSessions).toBe('function'); });
  it('exports refreshSchema', () => { expect(typeof SDK.refreshSchema).toBe('function'); });
  it('exports mountConfigEndpoint', () => { expect(typeof SDK.mountConfigEndpoint).toBe('function'); });
  it('exports getRunContext', () => { expect(typeof SDK.getRunContext).toBe('function'); });
  it('exports onConfigChange', () => { expect(typeof SDK.onConfigChange).toBe('function'); });
  it('exports onAlert', () => { expect(typeof SDK.onAlert).toBe('function'); });
  it('exports tunable', () => { expect(typeof SDK.tunable).toBe('function'); });
  it('exports tune', () => { expect(typeof SDK.tune).toBe('function'); });
  it('exports getTune', () => { expect(typeof SDK.getTune).toBe('function'); });
  it('exports checkpoint', () => { expect(typeof SDK.checkpoint).toBe('function'); });
  it('exports getToolValidation', () => { expect(typeof SDK.getToolValidation).toBe('function'); });
});

// ── Class / constructor exports ───────────────────────────────────────────────

describe('class exports', () => {
  it('exports AgentHandle', () => { expect(typeof SDK.AgentHandle).toBe('function'); });
  it('exports AgentServer', () => { expect(typeof SDK.AgentServer).toBe('function'); });
  it('exports MultiAgentRouter', () => { expect(typeof SDK.MultiAgentRouter).toBe('function'); });
  it('exports SessionFeedback', () => { expect(typeof SDK.SessionFeedback).toBe('function'); });
  it('exports TunableField', () => { expect(typeof SDK.TunableField).toBe('function'); });
  it('exports TunableRegistry', () => { expect(typeof SDK.TunableRegistry).toBe('function'); });
  it('exports GovernanceStopError', () => { expect(typeof SDK.GovernanceStopError).toBe('function'); });
  it('exports SyrinError', () => { expect(typeof SDK.SyrinError).toBe('function'); });
  it('exports SetupError', () => { expect(typeof SDK.SetupError).toBe('function'); });
  it('exports ValidationError', () => { expect(typeof SDK.ValidationError).toBe('function'); });
  it('exports AlreadyRatedError', () => { expect(typeof SDK.AlreadyRatedError).toBe('function'); });
  it('exports SessionNotFoundError', () => { expect(typeof SDK.SessionNotFoundError).toBe('function'); });
  it('exports GovernanceApprovalRequiredError', () => { expect(typeof SDK.GovernanceApprovalRequiredError).toBe('function'); });
  it('exports GovernanceCheckpointRestoredError', () => { expect(typeof SDK.GovernanceCheckpointRestoredError).toBe('function'); });
});

// ── SyrinSDK instance interface ───────────────────────────────────────────────

describe('SyrinSDK instance methods', () => {
  it('sdk has all required methods', async () => {
    const sdk = await SDK.init(makeConfig());

    const methods: Array<keyof typeof sdk> = [
      'configure', 'activeConfig', 'configSnapshot', 'getToolValidation',
      'createCheckpoint', 'restoreCheckpoint', 'listCheckpoints',
      'deleteSession', 'clearStaleSessions',
      'agent', 'defineTopology',
      'emit', 'log', 'checkpoint',
      'diagnose', 'healthCheck', 'getBillingStatus',
      'createServer', 'createAgentRouter',
      'flush', 'refreshSchema', 'shutdown',
      'onContextInjection', 'getPendingInjections',
    ];

    for (const method of methods) {
      expect(typeof sdk[method], `sdk.${method} should be a function`).toBe('function');
    }
  });

  it('sdk has sessions namespace with rate/rateBatch/withId/start', async () => {
    const sdk = await SDK.init(makeConfig());
    expect(typeof sdk.sessions.rate).toBe('function');
    expect(typeof sdk.sessions.rateBatch).toBe('function');
    expect(typeof sdk.sessions.withId).toBe('function');
    expect(typeof sdk.sessions.start).toBe('function');
  });

  it('sdk.config is accessible', async () => {
    const sdk = await SDK.init(makeConfig({ agentId: 'test-agent' }));
    expect(sdk.config).toBeDefined();
    expect(sdk.config.apiKey).toBeDefined();
  });

  it('sdk.sessionId is a string', async () => {
    const sdk = await SDK.init(makeConfig());
    expect(typeof sdk.sessionId).toBe('string');
    expect(sdk.sessionId.length).toBeGreaterThan(0);
  });
});

// ── getInstance / init idempotency ────────────────────────────────────────────

describe('getInstance', () => {
  it('returns null before init', () => {
    expect(SDK.getInstance()).toBeNull();
  });

  it('returns the sdk instance after init', async () => {
    const sdk = await SDK.init(makeConfig());
    expect(SDK.getInstance()).toBe(sdk);
  });
});
