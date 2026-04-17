/**
 * TDD Tests — Bug #1: ConfigSync must propagate remote config to all three stores.
 *
 * Root cause: ConfigSync._applyConfig() only called CallInterceptor.setConfig().
 * ConfigStore and SessionStore were never updated, so:
 *   - LangChain adapter._buildConfig() always returned startup/null values
 *   - engine.beforeCall() read stale SessionStore values after polling
 *
 * These tests verify the fix: ConfigSync must update ConfigStore and SessionStore
 * in addition to CallInterceptor so all downstream consumers see the new values.
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ConfigSync } from '@/core/config-sync.js';
import { ConfigStore } from '@/config/store.js';
import { SessionStore } from '@/core/session.js';

// ---------------------------------------------------------------------------
// Mock HTTP server
// ---------------------------------------------------------------------------

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE_URL = 'http://localhost:5100';
const AGENT_ID = 'agent-config-sync-test';
const API_KEY   = 'syrin_test_key';

const DEFAULT_OPTS = {
  agentId:    AGENT_ID,
  backendUrl: BASE_URL,
  apiKey:     API_KEY,
  offline:    false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubOverrides(overrides: Record<string, unknown>) {
  server.use(
    http.get(`${BASE_URL}/agents/${AGENT_ID}/overrides`, () =>
      HttpResponse.json({ ok: true, overrides }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConfigSync — ConfigStore propagation', () => {
  it('initialize() applies remote overrides to ConfigStore sections', async () => {
    stubOverrides({ 'llm.temperature': 0.42, 'llm.model': 'gpt-4o-mini' });

    const configStore = new ConfigStore();
    const sync = new ConfigSync({ ...DEFAULT_OPTS, configStore });

    await sync.initialize();

    // ConfigStore.getSection('llm') must reflect the remote values
    const llm = configStore.getSection('llm');
    expect(llm['temperature']).toBe(0.42);
    expect(llm['model']).toBe('gpt-4o-mini');
  });

  it('initialize() applies remote overrides to SessionStore activeConfig', async () => {
    stubOverrides({ 'llm.temperature': 0.7, 'llm.max_tokens': 512 });

    const sessionStore = new SessionStore();
    const sessionId    = 'ses_cfg_sync_test';
    await sessionStore.getOrCreate(sessionId);

    const sync = new ConfigSync({
      ...DEFAULT_OPTS,
      sessionStore,
      sessionId,
    });

    await sync.initialize();

    const effective = sessionStore.getEffectiveConfig(sessionId);
    expect(effective['temperature']).toBe(0.7);
    expect(effective['max_tokens']).toBe(512);
  });

  it('polling updates ConfigStore when remote config changes', async () => {
    // Start with one value, then change it mid-poll
    stubOverrides({ 'llm.temperature': 0.1 });

    const configStore = new ConfigStore();
    const sync = new ConfigSync({ ...DEFAULT_OPTS, configStore });

    await sync.initialize();
    expect(configStore.getSection('llm')['temperature']).toBe(0.1);

    // Now the remote config changes
    server.resetHandlers();
    stubOverrides({ 'llm.temperature': 0.9, 'llm.model': 'gpt-4-turbo' });

    // Trigger one explicit poll cycle via the private method (tested via startPolling + wait)
    // We expose polling via a very short interval
    sync.startPolling(50);
    await new Promise((r) => setTimeout(r, 120));
    sync.stopPolling();

    const llm = configStore.getSection('llm');
    expect(llm['temperature']).toBe(0.9);
    expect(llm['model']).toBe('gpt-4-turbo');
  });

  it('polling updates SessionStore when remote config changes', async () => {
    const sessionStore = new SessionStore();
    const sessionId    = 'ses_poll_test';
    await sessionStore.getOrCreate(sessionId);

    stubOverrides({ 'llm.temperature': 0.2 });

    const sync = new ConfigSync({ ...DEFAULT_OPTS, sessionStore, sessionId });
    await sync.initialize();
    expect(sessionStore.getEffectiveConfig(sessionId)['temperature']).toBe(0.2);

    server.resetHandlers();
    stubOverrides({ 'llm.temperature': 0.8 });

    sync.startPolling(50);
    await new Promise((r) => setTimeout(r, 120));
    sync.stopPolling();

    expect(sessionStore.getEffectiveConfig(sessionId)['temperature']).toBe(0.8);
  });

  it('initialize() is no-op when offline=true (stores untouched)', async () => {
    const configStore = new ConfigStore();
    const sync = new ConfigSync({ ...DEFAULT_OPTS, offline: true, configStore });

    await sync.initialize();

    // ConfigStore should have defaults (null), not remote values
    expect(configStore.getSection('llm')['temperature']).toBeNull();
  });

  it('initialize() is no-op when agentId is undefined', async () => {
    const configStore = new ConfigStore();
    const sync = new ConfigSync({
      ...DEFAULT_OPTS,
      agentId:     undefined,
      configStore,
    });

    await sync.initialize();
    expect(configStore.getSection('llm')['temperature']).toBeNull();
  });

  it('initialize() is graceful when fetch fails (stores untouched)', async () => {
    const configStore = new ConfigStore();
    const sync = new ConfigSync({
      ...DEFAULT_OPTS,
      backendUrl: 'http://localhost:19999',  // nothing listening here
      configStore,
    });

    // Must not throw
    await expect(sync.initialize()).resolves.toBeUndefined();
    expect(configStore.getSection('llm')['temperature']).toBeNull();
  });
});

describe('ConfigSync — options backward-compatibility', () => {
  it('works with only base options (no configStore / sessionStore) — no crash', async () => {
    stubOverrides({ 'llm.temperature': 0.5 });
    const sync = new ConfigSync(DEFAULT_OPTS);
    await expect(sync.initialize()).resolves.toBeUndefined();
  });
});
