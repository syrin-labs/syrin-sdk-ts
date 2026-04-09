/**
 * Tests: src/adapters/mastra.ts
 *
 * @mastra/core is NOT installed — all module-level patching is tested
 * via vi.mock. The adapter uses dynamic import('@mastra/core') which we mock.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '@/config-store';
import { getFrameworkContext } from '@/framework-context';

// ---------------------------------------------------------------------------
// Mock @mastra/core — Agent class created once and referenced by tests
// ---------------------------------------------------------------------------

class FakeAgent {
  name = 'test_agent';
  model: unknown = { modelId: 'gpt-4o', provider: 'openai' };

  async generate(
    _prompt: string,
    _opts?: Record<string, unknown>,
  ): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    return {
      text: 'Hello from FakeAgent',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };
  }

  async *stream(
    _prompt: string,
    _opts?: Record<string, unknown>,
  ): AsyncGenerator<string> {
    yield 'Hello';
    yield ' from';
    yield ' stream';
  }
}

vi.mock('@mastra/core', () => ({
  Agent: FakeAgent,
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

describe('MastraAdapter', () => {
  let MastraAdapter: typeof import('../src/adapters/mastra.js').MastraAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../src/adapters/mastra.js');
    MastraAdapter = mod.MastraAdapter;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Install / uninstall
  // -------------------------------------------------------------------------

  describe('install/uninstall', () => {
    it('install marks adapter as installed', async () => {
      const { core } = makeCore();
      const adapter = new MastraAdapter();
      expect(adapter.isInstalled()).toBe(false);
      await adapter.install(core as never);
      expect(adapter.isInstalled()).toBe(true);
      adapter.uninstall();
    });

    it('uninstall marks adapter as uninstalled', async () => {
      const { core } = makeCore();
      const adapter = new MastraAdapter();
      await adapter.install(core as never);
      adapter.uninstall();
      expect(adapter.isInstalled()).toBe(false);
    });

    it('double install is idempotent', async () => {
      const { core } = makeCore();
      const adapter = new MastraAdapter();
      await adapter.install(core as never);
      await adapter.install(core as never); // second call — must not throw
      expect(adapter.isInstalled()).toBe(true);
      adapter.uninstall();
    });

    it('install without @mastra/core does not throw', async () => {
      const { core } = makeCore();
      const adapter = new MastraAdapter();
      // The mock is present; verifies graceful handling
      await expect(adapter.install(core as never)).resolves.toBeUndefined();
      adapter.uninstall();
    });

    it('uninstall restores original generate and stream', async () => {
      const { core } = makeCore();
      const adapter = new MastraAdapter();

      const origGenerate = FakeAgent.prototype.generate;
      const origStream = FakeAgent.prototype.stream;

      await adapter.install(core as never);

      // After install, prototype methods are patched
      expect(FakeAgent.prototype.generate).not.toBe(origGenerate);
      expect(FakeAgent.prototype.stream).not.toBe(origStream);

      adapter.uninstall();

      // After uninstall, prototype methods are restored
      expect(FakeAgent.prototype.generate).toBe(origGenerate);
      expect(FakeAgent.prototype.stream).toBe(origStream);
    });
  });

  // -------------------------------------------------------------------------
  // LLM_CALL events — generate()
  // -------------------------------------------------------------------------

  describe('generate() LLM_CALL events', () => {
    it('generate() emits LLM_CALL event', async () => {
      const { core, emitted } = makeCore();
      const adapter = new MastraAdapter();
      await adapter.install(core as never);

      const agent = new FakeAgent();
      await agent.generate('Hello!');

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      );
      expect(ev).toBeDefined();
    });

    it('generate() LLM_CALL has required fields', async () => {
      const { core, emitted } = makeCore();
      const adapter = new MastraAdapter();
      await adapter.install(core as never);

      const agent = new FakeAgent();
      await agent.generate('Hello!');

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;

      expect(ev).toBeDefined();
      expect(ev['event_type']).toBe('LLM_CALL');
      expect(ev['model']).toBe('gpt-4o');
      expect(ev['provider']).toBe('openai');
      expect(ev['input_tokens']).toBe(100);
      expect(ev['output_tokens']).toBe(50);
      expect(typeof ev['duration_ms']).toBe('number');
      expect(ev['duration_ms']).toBeGreaterThanOrEqual(0);
      expect(ev['framework']).toBe('mastra');
      expect(ev['agent_name']).toBe('test_agent');
    });

    it('error in generate() still emits LLM_CALL with error field', async () => {
      const { core, emitted } = makeCore();
      const adapter = new MastraAdapter();

      const origGenerate = FakeAgent.prototype.generate;
      FakeAgent.prototype.generate = async function () {
        throw new Error('generate failed');
      };

      await adapter.install(core as never);

      const agent = new FakeAgent();
      await expect(agent.generate('Hello!')).rejects.toThrow('generate failed');

      adapter.uninstall();
      FakeAgent.prototype.generate = origGenerate;

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['error']).toBe('generate failed');
    });

    it('usage=null/undefined → input_tokens=0, output_tokens=0', async () => {
      const { core, emitted } = makeCore();
      const adapter = new MastraAdapter();

      const origGenerate = FakeAgent.prototype.generate;
      FakeAgent.prototype.generate = async function () {
        return { text: 'ok', usage: null } as never;
      };

      await adapter.install(core as never);

      const agent = new FakeAgent();
      await agent.generate('Hello!');

      adapter.uninstall();
      FakeAgent.prototype.generate = origGenerate;

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['input_tokens']).toBe(0);
      expect(ev['output_tokens']).toBe(0);
    });

    it('agent without name → agent_name="unknown"', async () => {
      const { core, emitted } = makeCore();
      const adapter = new MastraAdapter();
      await adapter.install(core as never);

      const agent = new FakeAgent();
      (agent as Record<string, unknown>)['name'] = undefined;
      await agent.generate('Hello!');

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['agent_name']).toBe('unknown');
    });

    it('model=undefined on agent → graceful (model="unknown")', async () => {
      const { core, emitted } = makeCore();
      const adapter = new MastraAdapter();
      await adapter.install(core as never);

      const agent = new FakeAgent();
      (agent as Record<string, unknown>)['model'] = undefined;
      await agent.generate('Hello!');

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['model']).toBe('unknown');
    });

    it('model as string → model set to string, provider="unknown"', async () => {
      const { core, emitted } = makeCore();
      const adapter = new MastraAdapter();
      await adapter.install(core as never);

      const agent = new FakeAgent();
      (agent as Record<string, unknown>)['model'] = 'gpt-4-turbo';
      await agent.generate('Hello!');

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['model']).toBe('gpt-4-turbo');
      expect(ev['provider']).toBe('unknown');
    });
  });

  // -------------------------------------------------------------------------
  // LLM_CALL events — stream()
  // -------------------------------------------------------------------------

  describe('stream() LLM_CALL events', () => {
    it('stream() emits LLM_CALL event after all chunks consumed', async () => {
      const { core, emitted } = makeCore();
      const adapter = new MastraAdapter();
      await adapter.install(core as never);

      const agent = new FakeAgent();
      const chunks: string[] = [];
      for await (const chunk of agent.stream('Hello!')) {
        chunks.push(chunk);
      }

      adapter.uninstall();

      expect(chunks).toEqual(['Hello', ' from', ' stream']);

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      );
      expect(ev).toBeDefined();
    });

    it('stream() LLM_CALL has framework="mastra"', async () => {
      const { core, emitted } = makeCore();
      const adapter = new MastraAdapter();
      await adapter.install(core as never);

      const agent = new FakeAgent();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of agent.stream('Hello!')) {
        // consume all
      }

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['framework']).toBe('mastra');
    });
  });

  // -------------------------------------------------------------------------
  // Config injection
  // -------------------------------------------------------------------------

  describe('config injection', () => {
    it('getConfig("llm") values are merged into generate() options', async () => {
      const { core } = makeCore({ llm: { temperature: 0.3, max_tokens: 500 } });
      const adapter = new MastraAdapter();

      let capturedOpts: unknown;
      const origGenerate = FakeAgent.prototype.generate;
      FakeAgent.prototype.generate = async function (_prompt: string, opts?: unknown) {
        capturedOpts = opts;
        return {
          text: 'ok',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      };

      await adapter.install(core as never);

      const agent = new FakeAgent();
      await agent.generate('Hello!', { someOption: true });

      adapter.uninstall();
      FakeAgent.prototype.generate = origGenerate;

      expect((capturedOpts as Record<string, unknown>)?.['temperature']).toBe(0.3);
      expect((capturedOpts as Record<string, unknown>)?.['max_tokens']).toBe(500);
    });

    it('empty config store causes no injection side-effects', async () => {
      const { core } = makeCore();
      const adapter = new MastraAdapter();

      let capturedOpts: unknown;
      const origGenerate = FakeAgent.prototype.generate;
      FakeAgent.prototype.generate = async function (_prompt: string, opts?: unknown) {
        capturedOpts = opts;
        return {
          text: 'ok',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      };

      await adapter.install(core as never);

      const agent = new FakeAgent();
      await agent.generate('Hello!', { userOption: 'keep-me' });

      adapter.uninstall();
      FakeAgent.prototype.generate = origGenerate;

      // User-provided options are preserved
      expect((capturedOpts as Record<string, unknown>)?.['userOption']).toBe('keep-me');
    });
  });

  // -------------------------------------------------------------------------
  // FrameworkContext
  // -------------------------------------------------------------------------

  describe('FrameworkContext', () => {
    it('FrameworkContext is set with framework="mastra" during generate()', async () => {
      const { core } = makeCore();
      const adapter = new MastraAdapter();

      let capturedCtx: unknown;
      const origGenerate = FakeAgent.prototype.generate;
      FakeAgent.prototype.generate = async function () {
        capturedCtx = getFrameworkContext();
        return {
          text: 'ok',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      };

      await adapter.install(core as never);

      const agent = new FakeAgent();
      await agent.generate('Hello!');

      adapter.uninstall();
      FakeAgent.prototype.generate = origGenerate;

      expect((capturedCtx as Record<string, unknown>)?.['framework']).toBe('mastra');
    });

    it('FrameworkContext is cleared after generate() completes', async () => {
      const { core } = makeCore();
      const adapter = new MastraAdapter();
      await adapter.install(core as never);

      const agent = new FakeAgent();
      await agent.generate('Hello!');

      adapter.uninstall();

      const ctx = getFrameworkContext();
      expect(ctx).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // emitEvent helper
  // -------------------------------------------------------------------------

  describe('emitEvent helper', () => {
    it('emitEvent calls core emitter with event', async () => {
      const { core, emitted } = makeCore();
      const adapter = new MastraAdapter();
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
