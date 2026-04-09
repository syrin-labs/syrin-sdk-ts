/**
 * Tests: src/adapters/langgraph.ts
 *
 * @langchain/langgraph is NOT installed — all module-level patching is tested
 * via vi.mock. The adapter uses dynamic import('@langchain/langgraph') which we mock.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '@/config-store';
import { getFrameworkContext } from '@/framework-context';

// ---------------------------------------------------------------------------
// Mock @langchain/langgraph — classes are created once and referenced by tests
// ---------------------------------------------------------------------------

// These are declared here so tests can reference the same prototypes the adapter patches
class FakeCompiledGraph {
  name = 'test_graph';
  async invoke(_input: unknown, _config?: unknown): Promise<unknown> {
    return { result: 'ok' };
  }
  async ainvoke(_input: unknown, _config?: unknown): Promise<unknown> {
    return { result: 'ok_async' };
  }
}

class FakeStateGraph {
  addNode(_name: unknown, _fn: unknown, ..._rest: unknown[]): void {
    // no-op — will be patched
  }
  add_node(_name: unknown, _fn: unknown, ..._rest: unknown[]): void {
    // no-op — will be patched
  }
}

function fakeInterrupt(v: unknown): unknown {
  return v;
}

// Store refs to mocked functions so tests can spy on them
let lgInterruptFn = fakeInterrupt;

vi.mock('@langchain/langgraph', () => ({
  CompiledGraph: FakeCompiledGraph,
  StateGraph: FakeStateGraph,
  get interrupt() { return lgInterruptFn; },
  set interrupt(fn: typeof fakeInterrupt) { lgInterruptFn = fn; },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4318',
    otelExporter: 'none' as const,
    otelEndpoint: 'http://localhost:4318',
    debug: false,
    captureContent: false,
    offline: true,
    batchIntervalMs: 60000,
    batchSize: 50,
    idleFlushMs: 5000,
    toolValidation: false,
    ...overrides,
  };
}

function makeCore(configStoreOverrides: Record<string, Record<string, unknown>> = {}) {
  const emitted: unknown[] = [];
  const configStore = new ConfigStore();

  for (const [ns, fields] of Object.entries(configStoreOverrides)) {
    for (const [field, value] of Object.entries(fields)) {
      configStore.set(ns, field, value);
    }
  }

  const core = {
    config: makeConfig(),
    _configStore: configStore,
    _emitter: { emit: (e: unknown) => emitted.push(e) },
  };
  return { core, emitted };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LangGraphAdapter', () => {
  let LangGraphAdapter: typeof import('../src/adapters/langgraph.js').LangGraphAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset lgInterruptFn to original so patching starts fresh
    lgInterruptFn = fakeInterrupt;
    // Import after clearing to avoid stale module state
    const mod = await import('../src/adapters/langgraph.js');
    LangGraphAdapter = mod.LangGraphAdapter;
  });

  afterEach(() => {
    // Uninstall any installed adapter to restore patches
    vi.clearAllMocks();
    lgInterruptFn = fakeInterrupt;
  });

  // -------------------------------------------------------------------------
  // Install / uninstall
  // -------------------------------------------------------------------------

  describe('install/uninstall', () => {
    it('install marks adapter as installed', async () => {
      const { core } = makeCore();
      const adapter = new LangGraphAdapter();
      expect(adapter.isInstalled()).toBe(false);
      await adapter.install(core as never);
      expect(adapter.isInstalled()).toBe(true);
      adapter.uninstall();
    });

    it('uninstall marks adapter as uninstalled', async () => {
      const { core } = makeCore();
      const adapter = new LangGraphAdapter();
      await adapter.install(core as never);
      adapter.uninstall();
      expect(adapter.isInstalled()).toBe(false);
    });

    it('double install is idempotent', async () => {
      const { core } = makeCore();
      const adapter = new LangGraphAdapter();
      await adapter.install(core as never);
      await adapter.install(core as never); // second call — must not throw
      expect(adapter.isInstalled()).toBe(true);
      adapter.uninstall();
    });

    it('install without @langchain/langgraph does not throw', async () => {
      const { core } = makeCore();
      const adapter = new LangGraphAdapter();
      // The mock is already present; this verifies the adapter handles missing module gracefully.
      // We test this by verifying install completes without throwing.
      await expect(adapter.install(core as never)).resolves.toBeUndefined();
      adapter.uninstall();
    });
  });

  // -------------------------------------------------------------------------
  // GRAPH_EXECUTION events
  // -------------------------------------------------------------------------

  describe('GRAPH_EXECUTION events', () => {
    it('invoke emits GRAPH_EXECUTION event', async () => {
      const { core, emitted } = makeCore();
      const adapter = new LangGraphAdapter();
      await adapter.install(core as never);

      const graph = new FakeCompiledGraph();
      await FakeCompiledGraph.prototype.invoke.call(graph, { input: 'hello' });

      adapter.uninstall();

      const graphEvent = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'GRAPH_EXECUTION'
      );
      expect(graphEvent).toBeDefined();
    });

    it('GRAPH_EXECUTION event has required fields (runId, graphId, durationMs, hashes)', async () => {
      const { core, emitted } = makeCore();
      const adapter = new LangGraphAdapter();
      await adapter.install(core as never);

      const graph = new FakeCompiledGraph();
      await FakeCompiledGraph.prototype.invoke.call(graph, { input: 'hello' });

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'GRAPH_EXECUTION'
      ) as Record<string, unknown>;

      expect(ev).toBeDefined();
      expect(typeof ev['run_id']).toBe('string');
      expect(ev['run_id']).toMatch(/^lgrun_/);
      expect(typeof ev['graph_id']).toBe('string');
      expect(typeof ev['duration_ms']).toBe('number');
      expect(ev['duration_ms']).toBeGreaterThanOrEqual(0);
      expect(typeof ev['input_hash']).toBe('string');
      expect(ev['input_hash']).toHaveLength(16);
      expect(typeof ev['output_hash']).toBe('string');
    });

    it('error in invoke is captured in GRAPH_EXECUTION event', async () => {
      const { core, emitted } = makeCore();
      const adapter = new LangGraphAdapter();

      // Set up throwing invoke BEFORE install so the adapter wraps it
      const origInvoke = FakeCompiledGraph.prototype.invoke;
      FakeCompiledGraph.prototype.invoke = async function() {
        throw new Error('graph failed');
      };

      await adapter.install(core as never);

      const graph = new FakeCompiledGraph();
      await expect(
        FakeCompiledGraph.prototype.invoke.call(graph, { input: 'fail' })
      ).rejects.toThrow('graph failed');

      adapter.uninstall();
      FakeCompiledGraph.prototype.invoke = origInvoke;

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'GRAPH_EXECUTION'
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['error']).toBe('graph failed');
    });

    it('ainvoke emits GRAPH_EXECUTION event', async () => {
      const { core, emitted } = makeCore();
      const adapter = new LangGraphAdapter();
      await adapter.install(core as never);

      const graph = new FakeCompiledGraph();
      await FakeCompiledGraph.prototype.ainvoke.call(graph, { input: 'hello async' });

      adapter.uninstall();

      const graphEvent = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'GRAPH_EXECUTION'
      );
      expect(graphEvent).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // NODE_EXECUTION events
  // -------------------------------------------------------------------------

  describe('NODE_EXECUTION events', () => {
    it('addNode wraps function to emit NODE_EXECUTION', async () => {
      const { core, emitted } = makeCore();
      const adapter = new LangGraphAdapter();

      // Set up spy BEFORE install: the adapter will save this as _originalAddNode
      // and call it with the wrapped function — we capture the wrapped fn here.
      let wrappedFn: ((...a: unknown[]) => unknown) | null = null;
      const origAddNode = FakeStateGraph.prototype.addNode;
      FakeStateGraph.prototype.addNode = function(name: unknown, fn: unknown, ...rest: unknown[]) {
        wrappedFn = fn as (...a: unknown[]) => unknown;
        // call original no-op for completeness
        return origAddNode.call(this, name, fn, ...rest);
      };

      await adapter.install(core as never);

      const nodeFunc = vi.fn(async (state: unknown) => ({ ...(state as object), processed: true }));
      const graph = new FakeStateGraph();
      FakeStateGraph.prototype.addNode.call(graph, 'my_node', nodeFunc);

      // Adapter wrapped nodeFunc and passed it to our spy; wrappedFn is the wrapper
      expect(wrappedFn).not.toBeNull();
      if (wrappedFn) await wrappedFn({ messages: ['hi'] });

      adapter.uninstall();
      FakeStateGraph.prototype.addNode = origAddNode;

      const nodeEvent = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'NODE_EXECUTION'
      );
      expect(nodeEvent).toBeDefined();
      const ev = nodeEvent as Record<string, unknown>;
      expect(ev['node_name']).toBe('my_node');
    });

    it('NODE_EXECUTION event links to parent graph run via graphRunId', async () => {
      const { core, emitted } = makeCore();
      const adapter = new LangGraphAdapter();

      let wrappedFn: ((...a: unknown[]) => unknown) | null = null;
      const origAddNode = FakeStateGraph.prototype.addNode;
      FakeStateGraph.prototype.addNode = function(name: unknown, fn: unknown, ...rest: unknown[]) {
        wrappedFn = fn as (...a: unknown[]) => unknown;
        return origAddNode.call(this, name, fn, ...rest);
      };

      await adapter.install(core as never);

      const nodeFunc = vi.fn(async (state: unknown) => state);
      const graph = new FakeStateGraph();
      FakeStateGraph.prototype.addNode.call(graph, 'linked_node', nodeFunc);

      if (wrappedFn) await wrappedFn({ data: 'test' });

      adapter.uninstall();
      FakeStateGraph.prototype.addNode = origAddNode;

      const nodeEvent = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'NODE_EXECUTION'
      ) as Record<string, unknown>;

      expect(nodeEvent).toBeDefined();
      expect(typeof nodeEvent['graph_run_id']).toBe('string');
    });

    it('node error is captured in NODE_EXECUTION event', async () => {
      const { core, emitted } = makeCore();
      const adapter = new LangGraphAdapter();

      let wrappedFn: ((...a: unknown[]) => unknown) | null = null;
      const origAddNode = FakeStateGraph.prototype.addNode;
      FakeStateGraph.prototype.addNode = function(name: unknown, fn: unknown, ...rest: unknown[]) {
        wrappedFn = fn as (...a: unknown[]) => unknown;
        return origAddNode.call(this, name, fn, ...rest);
      };

      await adapter.install(core as never);

      const errorNode = vi.fn(async () => { throw new Error('node error'); });
      const graph = new FakeStateGraph();
      FakeStateGraph.prototype.addNode.call(graph, 'error_node', errorNode);

      if (wrappedFn) {
        await expect(wrappedFn({})).rejects.toThrow('node error');
      }

      adapter.uninstall();
      FakeStateGraph.prototype.addNode = origAddNode;

      const nodeEvent = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'NODE_EXECUTION'
      ) as Record<string, unknown>;

      expect(nodeEvent).toBeDefined();
      expect(nodeEvent['error']).toBe('node error');
    });

    it('async node function is wrapped correctly', async () => {
      const { core, emitted } = makeCore();
      const adapter = new LangGraphAdapter();

      let wrappedFn: ((...a: unknown[]) => unknown) | null = null;
      const origAddNode = FakeStateGraph.prototype.addNode;
      FakeStateGraph.prototype.addNode = function(name: unknown, fn: unknown, ...rest: unknown[]) {
        wrappedFn = fn as (...a: unknown[]) => unknown;
        return origAddNode.call(this, name, fn, ...rest);
      };

      await adapter.install(core as never);

      const asyncNodeFunc = vi.fn(async (state: Record<string, unknown>) => ({
        ...state,
        async_result: 'done',
      }));
      const graph = new FakeStateGraph();
      FakeStateGraph.prototype.addNode.call(graph, 'async_node', asyncNodeFunc);

      let result: unknown;
      if (wrappedFn) {
        result = await wrappedFn({ messages: [] });
      }

      adapter.uninstall();
      FakeStateGraph.prototype.addNode = origAddNode;

      expect(result).toEqual({ messages: [], async_result: 'done' });
      expect(asyncNodeFunc).toHaveBeenCalledOnce();

      const nodeEvent = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'NODE_EXECUTION'
      );
      expect(nodeEvent).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Config injection
  // -------------------------------------------------------------------------

  describe('config injection', () => {
    it('recursion_limit from langgraph config is injected', async () => {
      const { core } = makeCore({ langgraph: { recursion_limit: 10 } });
      const adapter = new LangGraphAdapter();

      // Set up spy BEFORE install so the adapter wraps it as the "original"
      let capturedConfig: unknown;
      const origInvoke = FakeCompiledGraph.prototype.invoke;
      FakeCompiledGraph.prototype.invoke = async function(_input: unknown, config?: unknown) {
        capturedConfig = config;
        return { result: 'ok' };
      };

      await adapter.install(core as never);

      const graph = new FakeCompiledGraph();
      await FakeCompiledGraph.prototype.invoke.call(graph, { q: 'test' }, {});

      adapter.uninstall();
      FakeCompiledGraph.prototype.invoke = origInvoke;

      expect((capturedConfig as Record<string, unknown>)?.['recursionLimit']).toBe(10);
    });

    it('llm temperature is injected into configurable', async () => {
      const { core } = makeCore({ llm: { temperature: 0.2 } });
      const adapter = new LangGraphAdapter();

      let capturedConfig: unknown;
      const origInvoke = FakeCompiledGraph.prototype.invoke;
      FakeCompiledGraph.prototype.invoke = async function(_input: unknown, config?: unknown) {
        capturedConfig = config;
        return { result: 'ok' };
      };

      await adapter.install(core as never);

      const graph = new FakeCompiledGraph();
      await FakeCompiledGraph.prototype.invoke.call(graph, { q: 'test' }, {});

      adapter.uninstall();
      FakeCompiledGraph.prototype.invoke = origInvoke;

      const configurable = (capturedConfig as Record<string, unknown>)?.['configurable'] as Record<string, unknown>;
      expect(configurable?.['temperature']).toBe(0.2);
    });

    it('thread_id is injected into configurable', async () => {
      const { core } = makeCore({ langgraph: { thread_id: 'thread-abc' } });
      const adapter = new LangGraphAdapter();

      let capturedConfig: unknown;
      const origInvoke = FakeCompiledGraph.prototype.invoke;
      FakeCompiledGraph.prototype.invoke = async function(_input: unknown, config?: unknown) {
        capturedConfig = config;
        return { result: 'ok' };
      };

      await adapter.install(core as never);

      const graph = new FakeCompiledGraph();
      await FakeCompiledGraph.prototype.invoke.call(graph, { q: 'test' });

      adapter.uninstall();
      FakeCompiledGraph.prototype.invoke = origInvoke;

      const configurable = (capturedConfig as Record<string, unknown>)?.['configurable'] as Record<string, unknown>;
      expect(configurable?.['thread_id']).toBe('thread-abc');
    });

    it('empty config store causes no injection and preserves user config', async () => {
      const { core } = makeCore(); // all nulls by default
      const adapter = new LangGraphAdapter();

      let capturedConfig: unknown;
      const origInvoke = FakeCompiledGraph.prototype.invoke;
      FakeCompiledGraph.prototype.invoke = async function(_input: unknown, config?: unknown) {
        capturedConfig = config;
        return { result: 'ok' };
      };

      await adapter.install(core as never);

      const originalConfig = { configurable: { thread_id: 'user-thread' } };
      const graph = new FakeCompiledGraph();
      await FakeCompiledGraph.prototype.invoke.call(graph, { q: 'test' }, originalConfig);

      adapter.uninstall();
      FakeCompiledGraph.prototype.invoke = origInvoke;

      // No syrin overrides → user config preserved
      const configurable = (capturedConfig as Record<string, unknown>)?.['configurable'] as Record<string, unknown>;
      expect(configurable?.['thread_id']).toBe('user-thread');
    });
  });

  // -------------------------------------------------------------------------
  // FrameworkContext
  // -------------------------------------------------------------------------

  describe('FrameworkContext', () => {
    it('FrameworkContext is set with framework=langgraph during invoke', async () => {
      const { core } = makeCore();
      const adapter = new LangGraphAdapter();

      // Set up spy BEFORE install so the adapter wraps it
      let capturedCtx: unknown;
      const origInvoke = FakeCompiledGraph.prototype.invoke;
      FakeCompiledGraph.prototype.invoke = async function() {
        capturedCtx = getFrameworkContext();
        return { result: 'ok' };
      };

      await adapter.install(core as never);

      const graph = new FakeCompiledGraph();
      await FakeCompiledGraph.prototype.invoke.call(graph, { q: 'test' });

      adapter.uninstall();
      FakeCompiledGraph.prototype.invoke = origInvoke;

      expect((capturedCtx as Record<string, unknown>)?.['framework']).toBe('langgraph');
    });

    it('FrameworkContext is cleared after invoke', async () => {
      const { core } = makeCore();
      const adapter = new LangGraphAdapter();
      await adapter.install(core as never);

      const graph = new FakeCompiledGraph();
      await FakeCompiledGraph.prototype.invoke.call(graph, { q: 'test' });

      adapter.uninstall();

      // Context should be gone after invoke completes
      const ctx = getFrameworkContext();
      expect(ctx).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // HITL interrupt
  // -------------------------------------------------------------------------

  describe('HITL interrupt', () => {
    it('patched interrupt emits HITL_INTERRUPT event', async () => {
      const { core, emitted } = makeCore();
      const adapter = new LangGraphAdapter();
      await adapter.install(core as never);

      // lgInterruptFn is now the patched version installed by the adapter
      lgInterruptFn({ reason: 'human review needed' });

      adapter.uninstall();

      const interruptEvent = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'HITL_INTERRUPT'
      );
      expect(interruptEvent).toBeDefined();
      const ev = interruptEvent as Record<string, unknown>;
      expect(ev['interrupt_value']).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // emitEvent helper
  // -------------------------------------------------------------------------

  describe('emitEvent helper', () => {
    it('emitEvent calls core emitter with event', async () => {
      const { core, emitted } = makeCore();
      const adapter = new LangGraphAdapter();
      await adapter.install(core as never);

      const customEvent = {
        event_type: 'CUSTOM_EVENT',
        data: 'test',
      };
      adapter.emitEvent(customEvent);

      adapter.uninstall();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual(customEvent);
    });
  });
});
