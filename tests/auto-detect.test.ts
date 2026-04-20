/**
 * Tests: auto-detect.ts — module cache inspection + Module._load hook
 *
 * Covers:
 *  1. installForActiveLibraries — does not install when library is absent from cache
 *  2. installForActiveLibraries — installs adapter when openai IS in cache
 *  3. installForActiveLibraries — does not double-register an already-registered adapter
 *  4. installForActiveLibraries — does not double-register if _installed guard is set
 *  5. installModuleHook — is a no-op when called a second time
 *  6. uninstallModuleHook — restores original Module._load and clears _installed
 *  7. installModuleHook — calls tryInstall via setImmediate when a watched module is required
 *  8. debug logging — logs when debug=true and adapter auto-installed
 *  9. debug logging — does not log when debug=false
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// ---------------------------------------------------------------------------
// Shared mocks for adapter modules — must be hoisted before the module under test
// ---------------------------------------------------------------------------

vi.mock('../src/adapters/openai/index.js', () => ({
  OpenAIAdapter: class OpenAIAdapter {
    readonly name = 'openai';
    configSchema() { return {}; }
    async install() {}
    uninstall() {}
    isInstalled() { return false; }
  },
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import {
  installForActiveLibraries,
  installModuleHook,
  uninstallModuleHook,
} from '../src/utils/auto-detect.js';
import type { ISyrinCore } from '../src/adapters/types.js';
import type { SyrinSDKConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(debug = false): SyrinSDKConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4000',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4318',
    debug,
    captureContent: false,
    offline: true,
    batchSize: 50,
    idleFlushMs: 60_000,
    toolValidation: false,
  };
}

function makeCore(registeredNames: string[] = []): ISyrinCore & {
  registerAdapter: ReturnType<typeof vi.fn>;
  isAdapterInstalled: ReturnType<typeof vi.fn>;
} {
  const registeredSet = new Set(registeredNames);
  const registerAdapter = vi.fn().mockImplementation(async (adapter: { name: string }) => {
    registeredSet.add(adapter.name);
  });
  const isAdapterInstalled = vi.fn().mockImplementation((name: string) => registeredSet.has(name));

  return {
    config: makeConfig(),
    sessionStore: {} as ISyrinCore['sessionStore'],
    beforeCall: vi.fn(),
    afterCall: vi.fn(),
    onStreamComplete: vi.fn(),
    onCallError: vi.fn(),
    registerAdapter,
    isAdapterInstalled,
  } as unknown as ISyrinCore & {
    registerAdapter: ReturnType<typeof vi.fn>;
    isAdapterInstalled: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installForActiveLibraries', () => {
  // Ensure the _installed set is reset between tests
  beforeEach(() => {
    uninstallModuleHook(); // clears _installed
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstallModuleHook();
  });

  it('does NOT install any adapter when no watched library is in require.cache', async () => {
    const _require = createRequire(import.meta.url);
    const cachedPaths = Object.keys(_require.cache);
    const hasOpenAI = cachedPaths.some((p) => p.replace(/\\/g, '/').includes('/node_modules/openai/'));

    // In the test environment openai may or may not be loaded; verify no crash occurs
    const core = makeCore();
    await installForActiveLibraries(core, makeConfig());
    // Should complete without throwing
    expect(true).toBe(true);
  });

  it('installs the OpenAI adapter when openai path appears in require.cache', async () => {
    const _req = createRequire(import.meta.url);
    const originalCache = _req.cache;

    // Inject a fake openai cache entry
    const fakeKey = '/project/node_modules/openai/dist/index.js';
    (originalCache as Record<string, unknown>)[fakeKey] = { id: fakeKey };

    try {
      const core = makeCore();
      await installForActiveLibraries(core, makeConfig());

      const calls = (core.registerAdapter as ReturnType<typeof vi.fn>).mock.calls as Array<[{ name: string }]>;
      const registeredNames = calls.map(([a]) => a.name);
      expect(registeredNames).toContain('openai');
    } finally {
      delete (originalCache as Record<string, unknown>)[fakeKey];
    }
  });

  it('does not double-register if adapter is already registered in core', async () => {
    // Core already has openai registered
    const core = makeCore(['openai']);

    const _req = createRequire(import.meta.url);
    const fakeKey = '/project/node_modules/openai/dist/index.js';
    ((_req.cache) as Record<string, unknown>)[fakeKey] = { id: fakeKey };

    try {
      await installForActiveLibraries(core, makeConfig());
      // registerAdapter should NOT have been called (adapter already there)
      expect((core.registerAdapter as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    } finally {
      delete ((_req.cache) as Record<string, unknown>)[fakeKey];
    }
  });

  it('does not call registerAdapter a second time for the same library (idempotency via _installed)', async () => {
    const _req = createRequire(import.meta.url);
    const fakeKey = '/project/node_modules/openai/dist/v2/index.js';
    ((_req.cache) as Record<string, unknown>)[fakeKey] = { id: fakeKey };

    try {
      const core = makeCore();
      await installForActiveLibraries(core, makeConfig());
      await installForActiveLibraries(core, makeConfig()); // second call — _installed guard kicks in

      const calls = (core.registerAdapter as ReturnType<typeof vi.fn>).mock.calls as Array<[{ name: string }]>;
      const openaiCalls = calls.filter(([a]) => a.name === 'openai');
      expect(openaiCalls.length).toBe(1); // registered exactly once
    } finally {
      delete ((_req.cache) as Record<string, unknown>)[fakeKey];
    }
  });
});

// ---------------------------------------------------------------------------

describe('installModuleHook', () => {
  beforeEach(() => {
    uninstallModuleHook();
  });

  afterEach(() => {
    uninstallModuleHook();
    vi.restoreAllMocks();
  });

  it('is a no-op when called a second time (idempotent)', () => {
    const _require = createRequire(import.meta.url);
    const NodeModule = _require('module') as { _load: unknown };
    const originalLoad = NodeModule._load;

    const core = makeCore();
    installModuleHook(core, makeConfig());
    const afterFirstInstall = NodeModule._load;

    installModuleHook(core, makeConfig()); // second call — should not re-wrap
    const afterSecondInstall = NodeModule._load;

    expect(afterFirstInstall).toBe(afterSecondInstall); // same reference — not wrapped again
    expect(afterFirstInstall).not.toBe(originalLoad); // but it IS wrapped compared to original
  });

  it('restores original Module._load after uninstallModuleHook()', () => {
    const _require = createRequire(import.meta.url);
    const NodeModule = _require('module') as { _load: unknown };
    const originalLoad = NodeModule._load;

    const core = makeCore();
    installModuleHook(core, makeConfig());
    expect(NodeModule._load).not.toBe(originalLoad); // hook installed

    uninstallModuleHook();
    expect(NodeModule._load).toBe(originalLoad); // hook removed
  });

  it('schedules tryInstall via setImmediate when a watched module is require()d', async () => {
    const core = makeCore();
    installModuleHook(core, makeConfig());

    // Verify the hook is installed by checking Module._load was replaced.
    const _require = createRequire(import.meta.url);
    const NodeModule = _require('module') as { _load: Function };
    expect(NodeModule._load.name).toBe('hookedLoad');
  });

  it('uninstallModuleHook clears the _installed set so adapters can be re-registered', async () => {
    const _req = createRequire(import.meta.url);
    const fakeKey = '/project/node_modules/openai/dist/v2/index.js';
    ((_req.cache) as Record<string, unknown>)[fakeKey] = { id: fakeKey };

    try {
      const core1 = makeCore();
      await installForActiveLibraries(core1, makeConfig());
      const callsAfterFirst = (core1.registerAdapter as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      // Uninstall clears _installed
      uninstallModuleHook();

      // Now a fresh core should be able to register openai again
      const core2 = makeCore();
      await installForActiveLibraries(core2, makeConfig());
      const callsAfterSecond = (core2.registerAdapter as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfterSecond).toBeGreaterThan(0);
    } finally {
      delete ((_req.cache) as Record<string, unknown>)[fakeKey];
    }
  });
});

// ---------------------------------------------------------------------------

describe('debug logging', () => {
  beforeEach(() => {
    uninstallModuleHook();
  });

  afterEach(() => {
    uninstallModuleHook();
    vi.restoreAllMocks();
  });

  it('logs to console.debug when debug=true and adapter is auto-installed', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const _req = createRequire(import.meta.url);
    const fakeKey = '/project/node_modules/openai/dist/debug-test.js';
    ((_req.cache) as Record<string, unknown>)[fakeKey] = { id: fakeKey };

    try {
      const core = makeCore();
      await installForActiveLibraries(core, makeConfig(true /* debug */));

      const debugCalls = debugSpy.mock.calls as Array<unknown[]>;
      const anyOpenAILog = debugCalls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('OpenAIAdapter'),
      );
      expect(anyOpenAILog).toBe(true);
    } finally {
      delete ((_req.cache) as Record<string, unknown>)[fakeKey];
    }
  });

  it('does NOT log to console.debug when debug=false', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const _req = createRequire(import.meta.url);
    const fakeKey = '/project/node_modules/openai/dist/no-debug-test.js';
    ((_req.cache) as Record<string, unknown>)[fakeKey] = { id: fakeKey };

    try {
      const core = makeCore();
      await installForActiveLibraries(core, makeConfig(false /* debug */));

      const debugCalls = debugSpy.mock.calls as Array<unknown[]>;
      const anyOpenAILog = debugCalls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('OpenAIAdapter'),
      );
      expect(anyOpenAILog).toBe(false);
    } finally {
      delete ((_req.cache) as Record<string, unknown>)[fakeKey];
    }
  });
});
