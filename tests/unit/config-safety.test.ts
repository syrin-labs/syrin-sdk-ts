/**
 * Tests: P0-3 — Config object sensitive field protection
 *
 * Ensures that `apiKey` cannot leak through JSON serialisation, object spreading,
 * or property enumeration of the SDK instance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyrinSDKInstance } from '@/index';
import { SessionStore } from '@/core/session';
import { Emitter } from '@/observability/emitter';
import { OTelBridge } from '@/observability/otel';
import { SyrinCore } from '@/core/engine';
import { Heartbeat } from '@/core/heartbeat';
import { createConfig } from '@/config/config';
import type { SyrinConfig } from '@/types';

// Minimal offline config so no network calls are made
function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return createConfig({
    apiKey: 'syrin_realkey',
    backendUrl: 'http://localhost:4401',
    offline: true,
    ...overrides,
  });
}

// Build a minimal SyrinSDKInstance without network I/O
function buildInstance(config: SyrinConfig): SyrinSDKInstance {
  const sessionStore = new SessionStore();
  // Stub emitter so nothing is emitted
  const emitter = {
    emit: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    queueSize: vi.fn().mockReturnValue(0),
    onContextInjection: vi.fn().mockReturnValue(() => {}),
  } as unknown as Emitter;

  const otelBridge = {
    setup: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as OTelBridge;

  const checkpointClient = {
    save: vi.fn(),
    getById: vi.fn(),
    listForSession: vi.fn().mockReturnValue([]),
  };

  const core = {
    _registered: false,
    _lastBilling: null,
    _explicitTopology: undefined,
    checkpointClient,
    uninstallAll: vi.fn(),
    register: vi.fn().mockResolvedValue(undefined),
    isReady: true,
  } as unknown as SyrinCore;

  const heartbeat = {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as Heartbeat;

  return new SyrinSDKInstance(config, sessionStore, emitter, otelBridge, core, heartbeat);
}

describe('P0-3: Config sensitive field protection', () => {
  let sdk: SyrinSDKInstance;
  const REAL_KEY = 'syrin_realkey';

  beforeEach(() => {
    const config = makeConfig({ apiKey: REAL_KEY });
    sdk = buildInstance(config);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('JSON.stringify(sdk) does NOT contain the raw apiKey value', () => {
    const serialised = JSON.stringify(sdk);
    expect(serialised).not.toContain(REAL_KEY);
  });

  it('spreading {...sdk} does NOT expose the raw apiKey', () => {
    const spread = { ...sdk } as Record<string, unknown>;
    const spreadStr = JSON.stringify(spread);
    expect(spreadStr).not.toContain(REAL_KEY);
  });

  it('Object.keys(sdk) does not expose _config as enumerable', () => {
    const keys = Object.keys(sdk);
    // _config should NOT appear as an enumerable own property
    expect(keys).not.toContain('_config');
  });

  it('sdk.config still provides the real apiKey for internal use', () => {
    // The getter must still work — SDK needs the key for actual API calls
    expect(sdk.config.apiKey).toBe(REAL_KEY);
  });

  it('sdk.configSnapshot() returns apiKey masked as ****', () => {
    const snapshot = sdk.configSnapshot();
    expect(snapshot['apiKey']).toBe('****');
    expect(snapshot['apiKey']).not.toBe(REAL_KEY);
  });

  it('sdk.configSnapshot() does not contain the raw apiKey anywhere', () => {
    const snapshot = sdk.configSnapshot();
    const snapshotStr = JSON.stringify(snapshot);
    expect(snapshotStr).not.toContain(REAL_KEY);
  });

  it('serialising sdk.config via JSON.stringify masks the apiKey', () => {
    // Direct JSON.stringify of the config object must also be safe
    const configStr = JSON.stringify(sdk.config);
    expect(configStr).not.toContain(REAL_KEY);
  });
});
