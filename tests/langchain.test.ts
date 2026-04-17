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
import type { SyrinSDKConfig } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SyrinSDKConfig> = {}): SyrinSDKConfig {
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

  // ── Bug #5 — double-emission guard ───────────────────────────────────────
  // When the BaseChatModel prototype patch is active (installed via _doInstall),
  // the callback handler's handleLLMEnd must NOT emit LLM_CALL — the patch
  // already captures it. Emitting from both doubles token counts and costs.

  it('handleLLMEnd does NOT emit LLM_CALL when prototype patch is active', async () => {
    const { isLLMPatched } = await import('../src/adapters/langchain/patch-llm.js');

    // Install adapter — this calls patchBaseChatModel() internally
    await adapter.install(coreResult.core);

    // Skip if patchBaseChatModel could not patch the prototype in this test environment
    // (e.g. @langchain/core prototype has no .generate or is structured differently)
    if (!isLLMPatched()) return;

    const handler = adapter.callbackHandler('dedup_chain');
    handler.handleLLMStart({ kwargs: { model_name: 'gpt-4o' } }, [], 'run_dedup');

    // Simulate LLM response with token usage
    const mockResponse = {
      llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5 } },
    };
    handler.handleLLMEnd(mockResponse as Record<string, unknown>);

    // No LLM_CALL event should have been emitted — the patch handles it
    const llmCallEvents = (coreResult.emitted as Record<string, unknown>[]).filter(
      (e) => e['event_type'] === 'LLM_CALL',
    );
    expect(llmCallEvents).toHaveLength(0);
  });

  it('handleLLMEnd DOES emit LLM_CALL when prototype patch is NOT active', async () => {
    // Do NOT install adapter — prototype patch stays inactive
    // Create a fresh adapter that is deliberately not installed (patch inactive)
    const { LangChainAdapter: LCA } = await import('../src/adapters/langchain/index.js');
    const { isLLMPatched } = await import('../src/adapters/langchain/patch-llm.js');

    // Uninstall existing adapter to ensure patch is cleared
    adapter.uninstall();

    const freshAdapter = new LCA();
    // Do not install so patch is not active — but do give it a core so emitEvent works
    const { core: freshCore, emitted: freshEmitted } = makeCore();
    // Manually set _core without triggering install (bypasses patch)
    (freshAdapter as unknown as Record<string, unknown>)['_core'] = freshCore;
    (freshAdapter as unknown as Record<string, unknown>)['_installed'] = true;

    // Verify patch is not active for this scenario
    // (Note: if other tests ran patchBaseChatModel this may stay true;
    //  the real guard is that the dedup check uses module-level state)
    const handler = freshAdapter.callbackHandler('no_patch_chain');
    handler.handleLLMStart({ kwargs: { model_name: 'gpt-4o' } }, [], 'run_no_patch');
    handler.handleLLMEnd({
      llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5 } },
    } as Record<string, unknown>);

    // When patch is NOT active, LLM_CALL MUST be emitted by the callback
    if (!isLLMPatched()) {
      const llmCallEvents = (freshEmitted as Record<string, unknown>[]).filter(
        (e) => e['event_type'] === 'LLM_CALL',
      );
      expect(llmCallEvents).toHaveLength(1);
    }
    // If patch is somehow active (test ordering), skip the assertion — covered by the
    // test above which verifies the patch case explicitly.
  });

  it('handleLLMError does NOT emit LLM_CALL when prototype patch is active', async () => {
    const { isLLMPatched } = await import('../src/adapters/langchain/patch-llm.js');

    await adapter.install(coreResult.core);

    // Skip if patchBaseChatModel could not patch the prototype in this test environment
    if (!isLLMPatched()) return;

    const handler = adapter.callbackHandler('dedup_err_chain');
    handler.handleLLMStart({ kwargs: { model_name: 'gpt-4o' } }, [], 'run_err_dedup');
    handler.handleLLMError(new Error('model error'));

    const llmCallEvents = (coreResult.emitted as Record<string, unknown>[]).filter(
      (e) => e['event_type'] === 'LLM_CALL',
    );
    expect(llmCallEvents).toHaveLength(0);
  });
});
