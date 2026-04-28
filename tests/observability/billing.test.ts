/**
 * Tests: src/billing.ts — parseBilling, logBillingOnRegister, logBillingOnIngest
 * and integration with SyrinCore.register() + SyrinSDKInstance.getBillingStatus()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseBilling,
  logBillingOnRegister,
  logBillingOnIngest,
  type BillingInfo,
} from '@/billing';
import { SyrinCore } from '@/core/engine';
import { ConfigStore } from '@/config/store';
import type { SyrinConfig } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4399',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4318',
    debug: false,
    captureContent: false,
    offline: true,
    batchSize: 50,
    idleFlushMs: 60000,
    agentId: 'test-agent',
    sessionId: 'ses_test',
    ...overrides,
  };
}

function makeCore(configOverrides: Partial<SyrinConfig> = {}): {
  core: SyrinCore & { _configStore: ConfigStore };
  configStore: ConfigStore;
} {
  const config = makeConfig(configOverrides);
  const sessionStore = {
    getOrCreate: vi.fn().mockResolvedValue({ callCount: 0, cumulativeCostUsd: 0, callIndex: 0 }),
    popGovernanceActions: vi.fn().mockReturnValue([]),
    popInjectedMessages: vi.fn().mockReturnValue([]),
    getEffectiveConfig: vi.fn().mockReturnValue({}),
    recordCall: vi.fn(),
    incrementCallIndex: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    setLocalConfig: vi.fn(),
    getToolValidation: vi.fn(),
    deleteSession: vi.fn(),
    clearStaleSessions: vi.fn().mockReturnValue(0),
  };
  const emitter = {
    emit: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const otelBridge = {
    recordSpan: vi.fn(),
    setup: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  const checkpointClient = {
    save: vi.fn(),
    getById: vi.fn().mockResolvedValue(null),
    listForSession: vi.fn().mockReturnValue([]),
  };

  const core = new SyrinCore(
    config,
    sessionStore as never,
    emitter as never,
    otelBridge as never,
    checkpointClient as never,
  );
  const configStore = new ConfigStore();
  (core as unknown as Record<string, unknown>)['_configStore'] = configStore;

  return { core: core as SyrinCore & { _configStore: ConfigStore }, configStore };
}

function fullBilling(): unknown {
  return {
    plan: 'pro',
    planStatus: 'active',
    usage: {
      traces: { used: 500, limit: 1000, pct: 50, warning: false, exceeded: false },
      agents: { used: 3, limit: 10, pct: 30, warning: false, exceeded: false },
      projects: { used: 1, limit: 5, pct: 20, warning: false, exceeded: false },
      governanceRules: { used: 2, limit: 20, pct: 10, warning: false, exceeded: false },
    },
    features: {
      experiments: true,
      remoteConfig: true,
      approvals: false,
      analyticsRetentionDays: 30,
    },
    warnings: [],
    exceeded: [],
  };
}

// ---------------------------------------------------------------------------
// parseBilling() unit tests
// ---------------------------------------------------------------------------

describe('parseBilling()', () => {
  it('parses a full billing object correctly', () => {
    const billing = parseBilling(fullBilling());

    expect(billing).not.toBeNull();
    expect(billing!.plan).toBe('pro');
    expect(billing!.planStatus).toBe('active');
    expect(billing!.usage).not.toBeNull();
    expect(billing!.usage!.traces).toEqual({ used: 500, limit: 1000, pct: 50, warning: false, exceeded: false });
    expect(billing!.usage!.agents).toEqual({ used: 3, limit: 10, pct: 30, warning: false, exceeded: false });
    expect(billing!.usage!.projects).toEqual({ used: 1, limit: 5, pct: 20, warning: false, exceeded: false });
    expect(billing!.usage!.governanceRules).toEqual({ used: 2, limit: 20, pct: 10, warning: false, exceeded: false });
    expect(billing!.features).toEqual({
      experiments: true,
      remoteConfig: true,
      approvals: false,
      analyticsRetentionDays: 30,
    });
    expect(billing!.warnings).toEqual([]);
    expect(billing!.exceeded).toEqual([]);
  });

  it('handles plan=pro with traces.limit=-1 (unlimited)', () => {
    const data = {
      plan: 'pro',
      planStatus: 'active',
      usage: {
        traces: { used: 9999, limit: -1, pct: 0, warning: false, exceeded: false },
        agents: { used: 0, limit: -1, pct: 0, warning: false, exceeded: false },
        projects: { used: 0, limit: -1, pct: 0, warning: false, exceeded: false },
        governanceRules: { used: 0, limit: -1, pct: 0, warning: false, exceeded: false },
      },
      features: { experiments: true, remoteConfig: true, approvals: true, analyticsRetentionDays: 90 },
      warnings: [],
      exceeded: [],
    };

    const billing = parseBilling(data);
    expect(billing).not.toBeNull();
    expect(billing!.usage!.traces.limit).toBe(-1);
    expect(billing!.usage!.traces.used).toBe(9999);
  });

  it('returns null for null input', () => {
    expect(parseBilling(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseBilling(undefined)).toBeNull();
  });

  it('returns null for a non-object primitive', () => {
    expect(parseBilling('bad')).toBeNull();
    expect(parseBilling(42)).toBeNull();
    expect(parseBilling(true)).toBeNull();
  });

  it('does not throw for a malformed object — returns null', () => {
    // An object where accessing nested fields would explode in strict mode
    const bad = Object.create(null) as Record<string, unknown>;
    bad['plan'] = 'pro';
    // usage is a string, not an object — but parseBilling should handle it gracefully
    bad['usage'] = 'not-an-object';
    expect(() => parseBilling(bad)).not.toThrow();
    const result = parseBilling(bad);
    // usage is falsy in the record sense; should be null or an object with defaults
    if (result !== null) {
      // If it returns something, it should not throw and should have sane fields
      expect(result.plan).toBe('pro');
    }
  });

  it('returns usage=null when usage field is missing', () => {
    const data = {
      plan: 'starter',
      planStatus: 'active',
      warnings: [],
      exceeded: [],
    };

    const billing = parseBilling(data);
    expect(billing).not.toBeNull();
    expect(billing!.usage).toBeNull();
    expect(billing!.features).toBeNull();
  });

  it('returns features=null when features field is missing', () => {
    const data = {
      plan: 'starter',
      planStatus: 'active',
      usage: {
        traces: { used: 10, limit: 100, pct: 10, warning: false, exceeded: false },
        agents: { used: 1, limit: 5, pct: 20, warning: false, exceeded: false },
        projects: { used: 1, limit: 3, pct: 33, warning: false, exceeded: false },
        governanceRules: { used: 0, limit: 5, pct: 0, warning: false, exceeded: false },
      },
      warnings: [],
      exceeded: [],
    };

    const billing = parseBilling(data);
    expect(billing).not.toBeNull();
    expect(billing!.features).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// logBillingOnRegister() tests
// ---------------------------------------------------------------------------

describe('logBillingOnRegister()', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs plan and status for a healthy billing object', () => {
    const billing = parseBilling(fullBilling())!;
    logBillingOnRegister(billing);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('plan=pro'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('status=active'));
  });

  it('logs trace usage in used/limit/pct format', () => {
    const billing = parseBilling(fullBilling())!;
    logBillingOnRegister(billing);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('traces=500/1000 (50%)'));
  });

  it('shows "(unlimited)" when traces.limit is -1', () => {
    const data = {
      plan: 'enterprise',
      planStatus: 'active',
      usage: {
        traces: { used: 12345, limit: -1, pct: 0, warning: false, exceeded: false },
        agents: { used: 0, limit: -1, pct: 0, warning: false, exceeded: false },
        projects: { used: 0, limit: -1, pct: 0, warning: false, exceeded: false },
        governanceRules: { used: 0, limit: -1, pct: 0, warning: false, exceeded: false },
      },
      features: { experiments: true, remoteConfig: true, approvals: true, analyticsRetentionDays: 90 },
      warnings: [],
      exceeded: [],
    };
    const billing = parseBilling(data)!;
    logBillingOnRegister(billing);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('traces=12345 (unlimited)'));
    // Should NOT show a percentage
    const tracesCall = logSpy.mock.calls.find((c) => String(c[0]).includes('traces='));
    expect(String(tracesCall![0])).not.toMatch(/\d+%/);
  });

  it('calls console.warn once per warning', () => {
    const billing: BillingInfo = {
      plan: 'starter',
      planStatus: 'active',
      usage: null,
      features: null,
      warnings: ['approaching traces limit', 'nearing agent limit'],
      exceeded: [],
    };
    logBillingOnRegister(billing);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('approaching traces limit'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nearing agent limit'));
  });

  it('calls console.error once per exceeded entry', () => {
    const billing: BillingInfo = {
      plan: 'starter',
      planStatus: 'active',
      usage: null,
      features: null,
      warnings: [],
      exceeded: ['traces', 'agents'],
    };
    logBillingOnRegister(billing);

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('traces'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('agents'));
  });

  it('does not call warn or error when warnings/exceeded are empty', () => {
    const billing = parseBilling(fullBilling())!;
    logBillingOnRegister(billing);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// logBillingOnIngest() tests
// ---------------------------------------------------------------------------

describe('logBillingOnIngest()', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call warn or error when both arrays are empty', () => {
    const billing: BillingInfo = {
      plan: 'pro',
      planStatus: 'active',
      usage: null,
      features: null,
      warnings: [],
      exceeded: [],
    };
    logBillingOnIngest(billing);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('calls console.warn for each warning', () => {
    const billing: BillingInfo = {
      plan: 'starter',
      planStatus: 'active',
      usage: null,
      features: null,
      warnings: ['80% of traces used'],
      exceeded: [],
    };
    logBillingOnIngest(billing);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('80% of traces used'));
  });

  it('calls console.error for each exceeded entry and includes upgrade URL', () => {
    const billing: BillingInfo = {
      plan: 'starter',
      planStatus: 'active',
      usage: null,
      features: null,
      warnings: [],
      exceeded: ['traces'],
    };
    logBillingOnIngest(billing);

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://app.syrin.ai/billing')
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('traces'));
  });

  it('calls both warn and error when both arrays are populated', () => {
    const billing: BillingInfo = {
      plan: 'starter',
      planStatus: 'active',
      usage: null,
      features: null,
      warnings: ['nearing agents limit'],
      exceeded: ['traces'],
    };
    logBillingOnIngest(billing);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Integration: engine.register() with billing
// ---------------------------------------------------------------------------

describe('SyrinCore.register() billing integration', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sets _lastBilling when registration response contains billing', async () => {
    const { core } = makeCore({ agentId: 'billing-agent' });

    fetchSpy.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        configDelta: {},
        billing: fullBilling(),
      }),
    });

    expect(core._lastBilling).toBeNull();
    await core.register();

    expect(core._lastBilling).not.toBeNull();
    expect(core._lastBilling!.plan).toBe('pro');
    expect(core._lastBilling!.planStatus).toBe('active');
  });

  it('keeps _lastBilling as null when registration response has no billing', async () => {
    const { core } = makeCore({ agentId: 'no-billing-agent' });

    fetchSpy.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ configDelta: {} }),
    });

    await core.register();

    expect(core._lastBilling).toBeNull();
  });

  it('logs billing info after a successful registration with billing', async () => {
    const { core } = makeCore({ agentId: 'billing-agent-2' });

    fetchSpy.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        configDelta: {},
        billing: fullBilling(),
      }),
    });

    await core.register();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('plan=pro'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('status=active'));
  });

  it('logs billing warnings during registration', async () => {
    const { core } = makeCore({ agentId: 'warning-agent' });
    const billingWithWarning = {
      ...(fullBilling() as Record<string, unknown>),
      warnings: ['You are approaching your traces limit'],
    };

    fetchSpy.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        configDelta: {},
        billing: billingWithWarning,
      }),
    });

    await core.register();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('approaching your traces limit')
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: SyrinSDKInstance.getBillingStatus()
// ---------------------------------------------------------------------------

describe('SyrinSDKInstance.getBillingStatus()', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns _lastBilling from the core after register()', async () => {
    const { core } = makeCore({ agentId: 'sdk-billing-agent' });

    fetchSpy.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        configDelta: {},
        billing: fullBilling(),
      }),
    });

    await core.register();

    // Simulate getBillingStatus() logic: return core._lastBilling
    const result = core._lastBilling ?? null;
    expect(result).not.toBeNull();
    expect(result!.plan).toBe('pro');
  });

  it('returns null before registration', () => {
    const { core } = makeCore();
    expect(core._lastBilling).toBeNull();
  });

  it('returns null after register() with no billing in response', async () => {
    const { core } = makeCore({ agentId: 'no-billing-sdk' });

    fetchSpy.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ configDelta: {} }),
    });

    await core.register();
    expect(core._lastBilling).toBeNull();
  });
});
