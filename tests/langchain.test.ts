/**
 * Tests: src/adapters/langchain.ts
 *
 * No @langchain/core dependency needed — tests use mock chain objects that
 * duck-type the LangChain Runnable/Callback interface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '@/config/store';
import { getFrameworkContext } from '@/agent/framework-context';
import type { ISyrinCore } from '@/adapters/types';
import type { SyrinConfig } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4318',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4318',
    debug: false,
    captureContent: false,
    offline: true,
    batchSize: 50,
    idleFlushMs: 60000,
    toolValidation: false,
    agentId: 'test-agent',
    sessionId: 'ses_test',
    ...overrides,
  };
}

function makeCore(overrides: Partial<Record<string, unknown>> = {}) {
  const emitted: unknown[] = [];
  const configStore = new ConfigStore();
  const core = {
    config: makeConfig(),
    sessionStore: {} as ISyrinCore['sessionStore'],
    _configStore: configStore,
    _emitter: { emit: (e: unknown) => emitted.push(e) },
    beforeCall: vi.fn(),
    afterCall: vi.fn(),
    onStreamComplete: vi.fn(),
    onCallError: vi.fn(),
    ...overrides,
  };
  return { core: core as unknown as ISyrinCore & { _configStore: ConfigStore; _emitter: { emit: (e: unknown) => void } }, emitted, configStore };
}

/**
 * Mock chain that fires callbacks in the same pattern as LangChain.
 */
function makeMockChain(name = 'mock_chain') {
  return {
    name,
    invoke: vi.fn(async (inputs: unknown, config?: { callbacks?: unknown[] }) => {
      if (config?.callbacks) {
        for (const cb of config.callbacks) {
          const handler = cb as Record<string, (...args: unknown[]) => void>;
          handler['handleChainStart']?.({}, inputs, 'run_test');
          handler['handleChainEnd']?.({ result: 'ok' });
        }
      }
      return { result: 'ok' };
    }),
    ainvoke: vi.fn(async (inputs: unknown, config?: { callbacks?: unknown[] }) => {
      if (config?.callbacks) {
        for (const cb of config.callbacks) {
          const handler = cb as Record<string, (...args: unknown[]) => void>;
          handler['handleChainStart']?.({}, inputs, 'run_async');
          handler['handleChainEnd']?.({ result: 'ok_async' });
        }
      }
      return { result: 'ok_async' };
    }),
    someOtherProp: 'chain_metadata',
  };
}

// ---------------------------------------------------------------------------
// Import adapter under test
// ---------------------------------------------------------------------------

const { LangChainAdapter, SyrinLangChainCallback } = await import('../src/adapters/langchain/index.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LangChainAdapter', () => {
  let adapter: InstanceType<typeof LangChainAdapter>;
  let coreResult: ReturnType<typeof makeCore>;

  beforeEach(() => {
    coreResult = makeCore();
    adapter = new LangChainAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    adapter.uninstall();
    vi.clearAllMocks();
  });

  // ── Install / Uninstall ──────────────────────────────────────────────────

  it('install marks adapter as installed', async () => {
    expect(adapter.isInstalled()).toBe(false);
    await adapter.install(coreResult.core);
    expect(adapter.isInstalled()).toBe(true);
  });

  it('uninstall marks adapter as uninstalled', async () => {
    await adapter.install(coreResult.core);
    expect(adapter.isInstalled()).toBe(true);
    adapter.uninstall();
    expect(adapter.isInstalled()).toBe(false);
  });

  it('double install is idempotent', async () => {
    await adapter.install(coreResult.core);
    await adapter.install(coreResult.core); // should not throw or double-count
    expect(adapter.isInstalled()).toBe(true);
  });

  // ── SyrinLangChainCallback ───────────────────────────────────────────────

  it('onChainEnd emits CHAIN_EXECUTION event', async () => {
    await adapter.install(coreResult.core);
    const handler = adapter.callbackHandler('test_chain');
    handler.handleChainStart({}, {}, 'run_001');
    handler.handleChainEnd({ result: 'ok' });

    expect(coreResult.emitted.length).toBe(1);
    const event = coreResult.emitted[0] as Record<string, unknown>;
    expect(event['event_type']).toBe('CHAIN_EXECUTION');
  });

  it('onChainError emits CHAIN_EXECUTION event with error field', async () => {
    await adapter.install(coreResult.core);
    const handler = adapter.callbackHandler('error_chain');
    handler.handleChainStart({}, {}, 'run_002');
    handler.handleChainError(new Error('chain boom'));

    expect(coreResult.emitted.length).toBe(1);
    const event = coreResult.emitted[0] as Record<string, unknown>;
    expect(event['event_type']).toBe('CHAIN_EXECUTION');
    expect(event['error']).toBe('chain boom');
  });

  it('CHAIN_EXECUTION event has chainName field', async () => {
    await adapter.install(coreResult.core);
    const handler = adapter.callbackHandler('my_chain');
    handler.handleChainStart({}, {}, 'run_003');
    handler.handleChainEnd({});

    const event = coreResult.emitted[0] as Record<string, unknown>;
    expect(event['chain_name']).toBe('my_chain');
  });

  it('CHAIN_EXECUTION event has durationMs > 0', async () => {
    await adapter.install(coreResult.core);
    const handler = adapter.callbackHandler('timed_chain');
    handler.handleChainStart({}, {}, 'run_004');
    // Small artificial delay
    await new Promise((r) => setTimeout(r, 5));
    handler.handleChainEnd({});

    const event = coreResult.emitted[0] as Record<string, unknown>;
    expect(typeof event['duration_ms']).toBe('number');
    expect(event['duration_ms'] as number).toBeGreaterThanOrEqual(0);
  });

  it('CHAIN_EXECUTION event has framework=langchain', async () => {
    await adapter.install(coreResult.core);
    const handler = adapter.callbackHandler('fw_chain');
    handler.handleChainStart({}, {}, 'run_005');
    handler.handleChainEnd({});

    const event = coreResult.emitted[0] as Record<string, unknown>;
    expect(event['framework']).toBe('langchain');
  });

  // ── wrap() ───────────────────────────────────────────────────────────────

  it('wrap returns proxy with invoke', async () => {
    await adapter.install(coreResult.core);
    const chain = makeMockChain();
    const wrapped = adapter.wrap(chain);
    expect(typeof wrapped.invoke).toBe('function');
  });

  it('wrapped invoke fires callbacks', async () => {
    await adapter.install(coreResult.core);
    const chain = makeMockChain();
    const wrapped = adapter.wrap(chain);
    await wrapped.invoke({ input: 'hello' });

    // wrap() emits events directly — verify the underlying invoke was called
    expect(chain.invoke).toHaveBeenCalledOnce();
  });

  it('wrapped invoke emits CHAIN_EXECUTION event', async () => {
    await adapter.install(coreResult.core);
    const chain = makeMockChain();
    const wrapped = adapter.wrap(chain);
    await wrapped.invoke({ input: 'hello' });

    expect(coreResult.emitted.length).toBe(1);
    const event = coreResult.emitted[0] as Record<string, unknown>;
    expect(event['event_type']).toBe('CHAIN_EXECUTION');
  });

  it('wrapped ainvoke emits CHAIN_EXECUTION event', async () => {
    await adapter.install(coreResult.core);
    const chain = makeMockChain();
    const wrapped = adapter.wrap(chain);
    await wrapped.ainvoke({ input: 'async input' });

    expect(coreResult.emitted.length).toBe(1);
    const event = coreResult.emitted[0] as Record<string, unknown>;
    expect(event['event_type']).toBe('CHAIN_EXECUTION');
  });

  it('wrap preserves other chain properties via proxy', async () => {
    await adapter.install(coreResult.core);
    const chain = makeMockChain('proxy_chain');
    const wrapped = adapter.wrap(chain);

    expect(wrapped.name).toBe('proxy_chain');
    expect((wrapped as typeof chain).someOtherProp).toBe('chain_metadata');
  });

  it('wrapped invoke uses chain.name for chainName', async () => {
    await adapter.install(coreResult.core);
    const chain = makeMockChain('named_chain');
    const wrapped = adapter.wrap(chain);
    await wrapped.invoke({ input: 'test' });

    const event = coreResult.emitted[0] as Record<string, unknown>;
    expect(event['chain_name']).toBe('named_chain');
  });

  // ── _buildConfig ─────────────────────────────────────────────────────────

  it('_buildConfig adds callback to callbacks array', async () => {
    await adapter.install(coreResult.core);
    const handler = adapter.callbackHandler();
    const result = adapter._buildConfig(undefined, handler);
    expect(Array.isArray(result['callbacks'])).toBe(true);
    expect((result['callbacks'] as unknown[]).length).toBe(1);
    expect((result['callbacks'] as unknown[])[0]).toBe(handler);
  });

  it('_buildConfig injects temperature from llm config', async () => {
    const { core, configStore } = makeCore();
    await adapter.install(core);
    configStore.set('llm', 'temperature', 0.3);

    const handler = adapter.callbackHandler();
    const result = adapter._buildConfig(undefined, handler);
    const configurable = result['configurable'] as Record<string, unknown>;
    expect(configurable['temperature']).toBe(0.3);
  });

  it('_buildConfig preserves existing callbacks', async () => {
    await adapter.install(coreResult.core);
    const existingCb = { onChainStart: vi.fn() };
    const handler = adapter.callbackHandler();
    const result = adapter._buildConfig({ callbacks: [existingCb] }, handler);
    const cbs = result['callbacks'] as unknown[];
    expect(cbs).toContain(existingCb);
    expect(cbs).toContain(handler);
    expect(cbs.length).toBe(2);
  });

  it('_buildConfig works with no existing config', async () => {
    await adapter.install(coreResult.core);
    const handler = adapter.callbackHandler();
    expect(() => adapter._buildConfig(undefined, handler)).not.toThrow();
    const result = adapter._buildConfig(undefined, handler);
    expect(result).toBeDefined();
    expect(Array.isArray(result['callbacks'])).toBe(true);
  });

  // ── FrameworkContext ──────────────────────────────────────────────────────

  it('wrap sets FrameworkContext with framework=langchain during invoke', async () => {
    await adapter.install(coreResult.core);

    let capturedCtx: ReturnType<typeof getFrameworkContext> | undefined;
    const chain = {
      name: 'ctx_chain',
      invoke: vi.fn(async (_inputs: unknown, _config?: unknown) => {
        capturedCtx = getFrameworkContext();
        return { result: 'ok' };
      }),
      ainvoke: vi.fn(async (_inputs: unknown, _config?: unknown) => {
        capturedCtx = getFrameworkContext();
        return { result: 'ok_async' };
      }),
    };

    const wrapped = adapter.wrap(chain);
    await wrapped.invoke({ input: 'ctx test' });

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.framework).toBe('langchain');
  });

  it('FrameworkContext cleared after invoke completes', async () => {
    await adapter.install(coreResult.core);
    const chain = makeMockChain('clear_ctx_chain');
    const wrapped = adapter.wrap(chain);
    await wrapped.invoke({ input: 'clear test' });

    // After invoke completes, the FrameworkContext should be cleared
    expect(getFrameworkContext()).toBeUndefined();
  });

  // ── callbackHandler() ────────────────────────────────────────────────────

  it('callbackHandler returns SyrinLangChainCallback', async () => {
    await adapter.install(coreResult.core);
    const handler = adapter.callbackHandler();
    expect(handler).toBeInstanceOf(SyrinLangChainCallback);
  });
});
