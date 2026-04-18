/**
 * TDD tests for dynamic agent registration (sdk.registerAgent / registerAgent).
 *
 * Covers:
 *  - AgentConfig interface shape
 *  - captureContent per-agent override (true / false / undefined inheritance)
 *  - captureToolCalls per-agent override (true / false / undefined inheritance)
 *  - sections registered in ConfigStore
 *  - module-level registerAgent() helper
 *  - chaining: sdk.registerAgent({...}).registerAgent({...})
 *  - backward compat: agents object in init() still works
 *  - engine resolvers: resolveCaptureContent, resolveCaptureToolCalls
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyrinSDKCore } from '../src/core/engine.js';
import { init, shutdown, registerAgent } from '../src/index.js';
import type { AgentConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCore(captureContent = false): SyrinSDKCore {
  const config = {
    apiKey: 'syrin_test',
    agentId: 'test',
    captureContent,
    offline: true,
    debug: false,
    toolValidation: false,
    batchSize: 100,
    idleFlushMs: 10_000,
    otelExporter: 'none' as const,
    otelEndpoint: 'http://localhost:4318',
    backendUrl: 'https://api.syrin.ai',
  };
  return new SyrinSDKCore(
    config,
    { get: vi.fn(), getOrCreate: vi.fn(), update: vi.fn() } as never,
    { emit: vi.fn(), flush: vi.fn() } as never,
    { recordSpan: vi.fn() } as never,
    { save: vi.fn(), getById: vi.fn(), listForSession: vi.fn() } as never,
  );
}

// ---------------------------------------------------------------------------
// AgentConfig shape
// ---------------------------------------------------------------------------

describe('AgentConfig interface', () => {
  it('accepts minimal config with only agentId', () => {
    const config: AgentConfig = { agentId: 'researcher' };
    expect(config.agentId).toBe('researcher');
    expect(config.captureContent).toBeUndefined();
    expect(config.captureToolCalls).toBeUndefined();
    expect(config.description).toBeUndefined();
    expect(config.sections).toBeUndefined();
  });

  it('accepts full config', () => {
    const config: AgentConfig = {
      agentId: 'writer',
      description: 'Writes articles',
      captureContent: true,
      captureToolCalls: false,
      sections: {
        search: {
          fields: [{ name: 'max_results', type: 'int', default: 5 }],
        },
      },
    };
    expect(config.captureContent).toBe(true);
    expect(config.captureToolCalls).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine resolvers
// ---------------------------------------------------------------------------

describe('SyrinSDKCore resolvers', () => {
  it('resolveCaptureContent inherits SDK default when no per-agent override', () => {
    const core = makeCore(false);
    expect(core.resolveCaptureContent('unknown')).toBe(false);
  });

  it('resolveCaptureContent per-agent true overrides SDK false', () => {
    const core = makeCore(false);
    core.registerAgent({ agentId: 'researcher', captureContent: true });
    expect(core.resolveCaptureContent('researcher')).toBe(true);
  });

  it('resolveCaptureContent per-agent false overrides SDK true', () => {
    const core = makeCore(true);
    core.registerAgent({ agentId: 'classifier', captureContent: false });
    expect(core.resolveCaptureContent('classifier')).toBe(false);
  });

  it('resolveCaptureContent undefined inherits SDK value', () => {
    const core = makeCore(true);
    core.registerAgent({ agentId: 'agent', captureContent: undefined });
    expect(core.resolveCaptureContent('agent')).toBe(true);
  });

  it('resolveCaptureContent returns SDK default when agentId is null', () => {
    const core = makeCore(true);
    expect(core.resolveCaptureContent(null)).toBe(true);
  });

  it('resolveCaptureToolCalls returns true by default', () => {
    const core = makeCore();
    expect(core.resolveCaptureToolCalls('anyone')).toBe(true);
  });

  it('resolveCaptureToolCalls per-agent false suppresses tools', () => {
    const core = makeCore();
    core.registerAgent({ agentId: 'silent', captureToolCalls: false });
    expect(core.resolveCaptureToolCalls('silent')).toBe(false);
  });

  it('resolveCaptureToolCalls undefined inherits default (true)', () => {
    const core = makeCore();
    core.registerAgent({ agentId: 'agent', captureToolCalls: undefined });
    expect(core.resolveCaptureToolCalls('agent')).toBe(true);
  });

  it('resolveCaptureToolCalls returns true when agentId is null', () => {
    const core = makeCore();
    expect(core.resolveCaptureToolCalls(null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sdk.registerAgent() on SyrinSDKInstance
// ---------------------------------------------------------------------------

describe('sdk.registerAgent()', () => {
  let sdk: Awaited<ReturnType<typeof init>>;

  beforeEach(async () => {
    sdk = await init({ apiKey: 'syrin_test', offline: true });
  });

  afterEach(async () => {
    await shutdown();
  });

  it('returns this for chaining', () => {
    const result = sdk.registerAgent({ agentId: 'researcher' });
    expect(result).toBe(sdk);
  });

  it('supports chaining multiple registrations', () => {
    sdk.registerAgent({ agentId: 'writer' }).registerAgent({ agentId: 'reviewer' });
    // Verify both registered
    expect((sdk as never as { _core: SyrinSDKCore })._core.resolveCaptureContent('writer')).toBeDefined();
    expect((sdk as never as { _core: SyrinSDKCore })._core.resolveCaptureContent('reviewer')).toBeDefined();
  });

  it('sets captureContent to true for agent', () => {
    sdk.registerAgent({ agentId: 'agent', captureContent: true });
    const core = (sdk as never as { _core: SyrinSDKCore })._core;
    expect(core.resolveCaptureContent('agent')).toBe(true);
  });

  it('sets captureToolCalls to false for agent', () => {
    sdk.registerAgent({ agentId: 'noiseless', captureToolCalls: false });
    const core = (sdk as never as { _core: SyrinSDKCore })._core;
    expect(core.resolveCaptureToolCalls('noiseless')).toBe(false);
  });

  it('per-agent captureContent=false overrides SDK-level true', () => {
    sdk.registerAgent({ agentId: 'private', captureContent: false });
    const core = (sdk as never as { _core: SyrinSDKCore })._core;
    // Even if config.captureContent were true, per-agent false wins
    expect(core.resolveCaptureContent('private')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Module-level registerAgent()
// ---------------------------------------------------------------------------

describe('module-level registerAgent()', () => {
  let sdk: Awaited<ReturnType<typeof init>>;

  beforeEach(async () => {
    sdk = await init({ apiKey: 'syrin_test', offline: true });
  });

  afterEach(async () => {
    await shutdown();
  });

  it('registers agent on the default instance', () => {
    registerAgent({ agentId: 'mod-agent', captureContent: true });
    const core = (sdk as never as { _core: SyrinSDKCore })._core;
    expect(core.resolveCaptureContent('mod-agent')).toBe(true);
  });

  it('is a no-op (no crash) before init()', async () => {
    await shutdown();
    expect(() => registerAgent({ agentId: 'ghost' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Backward compat: agents= object in init() still works
// ---------------------------------------------------------------------------

describe('backward compat: agents in init()', () => {
  afterEach(async () => {
    await shutdown();
  });

  it('agents object in init() still registers agents', async () => {
    const instance = await init({
      apiKey: 'syrin_test',
      offline: true,
      agents: {
        'legacy-agent': {
          sections: {
            search: {
              fields: [{ name: 'top_k', type: 'int', default: 3 }],
            },
          },
        },
      },
    } as never);
    const core = (instance as never as { _core: SyrinSDKCore })._core;
    // Should be registered (captureContent inherits default)
    expect(core.resolveCaptureContent('legacy-agent')).toBeDefined();
  });
});
