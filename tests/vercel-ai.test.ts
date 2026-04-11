/**
 * Tests: src/adapters/vercel-ai.ts
 *
 * The `ai` package is NOT installed — all module-level patching is tested
 * via vi.mock. The adapter uses dynamic import('ai') which we mock.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '@/config/store';
import { getFrameworkContext } from '@/agent/framework-context';

// ---------------------------------------------------------------------------
// Mock `ai` module — standalone functions
// ---------------------------------------------------------------------------

const fakeModel = { modelId: 'gpt-4o', provider: 'openai' };

const fakeUsage = {
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
};

async function fakeGenerateText(
  opts: Record<string, unknown>,
): Promise<{ text: string; usage: typeof fakeUsage }> {
  void opts;
  return { text: 'Hello from generateText', usage: fakeUsage };
}

function fakeStreamText(
  opts: Record<string, unknown>,
): { textStream: AsyncIterable<string>; usage: Promise<typeof fakeUsage> } {
  void opts;
  const chunks = ['Hello', ' from', ' streamText'];
  async function* gen(): AsyncGenerator<string> {
    for (const c of chunks) yield c;
  }
  return {
    textStream: gen(),
    usage: Promise.resolve(fakeUsage),
  };
}

async function fakeGenerateObject(
  opts: Record<string, unknown>,
): Promise<{ object: unknown; usage: typeof fakeUsage }> {
  void opts;
  return { object: { answer: 42 }, usage: fakeUsage };
}

// Store mutable refs so adapter patches the module object
const aiModule = {
  generateText: fakeGenerateText as (opts: Record<string, unknown>) => Promise<unknown>,
  streamText: fakeStreamText as (opts: Record<string, unknown>) => unknown,
  generateObject: fakeGenerateObject as (opts: Record<string, unknown>) => Promise<unknown>,
};

vi.mock('ai', () => aiModule);

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

describe('VercelAIAdapter', () => {
  let VercelAIAdapter: typeof import('../src/adapters/vercel-ai/index.js').VercelAIAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module functions to originals before each test
    aiModule.generateText = fakeGenerateText;
    aiModule.streamText = fakeStreamText;
    aiModule.generateObject = fakeGenerateObject;

    const mod = await import('../src/adapters/vercel-ai/index.js');
    VercelAIAdapter = mod.VercelAIAdapter;
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Restore originals after each test
    aiModule.generateText = fakeGenerateText;
    aiModule.streamText = fakeStreamText;
    aiModule.generateObject = fakeGenerateObject;
  });

  // -------------------------------------------------------------------------
  // Install / uninstall
  // -------------------------------------------------------------------------

  describe('install/uninstall', () => {
    it('install marks adapter as installed', async () => {
      const { core } = makeCore();
      const adapter = new VercelAIAdapter();
      expect(adapter.isInstalled()).toBe(false);
      await adapter.install(core as never);
      expect(adapter.isInstalled()).toBe(true);
      adapter.uninstall();
    });

    it('uninstall marks adapter as uninstalled', async () => {
      const { core } = makeCore();
      const adapter = new VercelAIAdapter();
      await adapter.install(core as never);
      adapter.uninstall();
      expect(adapter.isInstalled()).toBe(false);
    });

    it('double install is idempotent', async () => {
      const { core } = makeCore();
      const adapter = new VercelAIAdapter();
      await adapter.install(core as never);
      await adapter.install(core as never);
      expect(adapter.isInstalled()).toBe(true);
      adapter.uninstall();
    });

    it('install without `ai` package does not throw', async () => {
      const { core } = makeCore();
      const adapter = new VercelAIAdapter();
      await expect(adapter.install(core as never)).resolves.toBeUndefined();
      adapter.uninstall();
    });

    it('uninstall restores original generateText, streamText, generateObject', async () => {
      const { core } = makeCore();
      const adapter = new VercelAIAdapter();

      const origGenerateText = aiModule.generateText;
      const origStreamText = aiModule.streamText;
      const origGenerateObject = aiModule.generateObject;

      await adapter.install(core as never);

      expect(aiModule.generateText).not.toBe(origGenerateText);
      expect(aiModule.streamText).not.toBe(origStreamText);
      expect(aiModule.generateObject).not.toBe(origGenerateObject);

      adapter.uninstall();

      expect(aiModule.generateText).toBe(origGenerateText);
      expect(aiModule.streamText).toBe(origStreamText);
      expect(aiModule.generateObject).toBe(origGenerateObject);
    });
  });

  // -------------------------------------------------------------------------
  // generateText() LLM_CALL events
  // -------------------------------------------------------------------------

  describe('generateText() LLM_CALL events', () => {
    it('generateText emits LLM_CALL event', async () => {
      const { core, emitted } = makeCore();
      const adapter = new VercelAIAdapter();
      await adapter.install(core as never);

      await aiModule.generateText({ model: fakeModel, prompt: 'Hello!' });

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      );
      expect(ev).toBeDefined();
    });

    it('generateText LLM_CALL has required fields (model, provider, tokens, duration, framework)', async () => {
      const { core, emitted } = makeCore();
      const adapter = new VercelAIAdapter();
      await adapter.install(core as never);

      await aiModule.generateText({ model: fakeModel, prompt: 'Hello!' });

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
      expect(ev['framework']).toBe('vercel-ai');
    });

    it('error in generateText still emits LLM_CALL with error field', async () => {
      const { core, emitted } = makeCore();
      const adapter = new VercelAIAdapter();

      aiModule.generateText = async (_opts: Record<string, unknown>) => {
        throw new Error('generateText failed');
      };

      await adapter.install(core as never);

      await expect(
        aiModule.generateText({ model: fakeModel, prompt: 'Hello!' }),
      ).rejects.toThrow('generateText failed');

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['error']).toBe('generateText failed');
    });

    it('usage=null → input_tokens=0, output_tokens=0', async () => {
      const { core, emitted } = makeCore();
      const adapter = new VercelAIAdapter();

      aiModule.generateText = async (_opts: Record<string, unknown>) => ({
        text: 'ok',
        usage: null,
      });

      await adapter.install(core as never);

      await aiModule.generateText({ model: fakeModel, prompt: 'Hello!' });

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['input_tokens']).toBe(0);
      expect(ev['output_tokens']).toBe(0);
    });

    it('model=undefined → graceful (model="unknown")', async () => {
      const { core, emitted } = makeCore();
      const adapter = new VercelAIAdapter();
      await adapter.install(core as never);

      await aiModule.generateText({ model: undefined, prompt: 'Hello!' });

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['model']).toBe('unknown');
    });

    it('model as string → model set to string, provider="unknown"', async () => {
      const { core, emitted } = makeCore();
      const adapter = new VercelAIAdapter();
      await adapter.install(core as never);

      await aiModule.generateText({ model: 'gpt-4-turbo', prompt: 'Hello!' });

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
  // streamText() LLM_CALL events
  // -------------------------------------------------------------------------

  describe('streamText() LLM_CALL events', () => {
    it('streamText emits LLM_CALL event after stream is consumed', async () => {
      const { core, emitted } = makeCore();
      const adapter = new VercelAIAdapter();
      await adapter.install(core as never);

      const result = aiModule.streamText({ model: fakeModel, prompt: 'Hello!' }) as {
        textStream: AsyncIterable<string>;
        usage: Promise<unknown>;
      };

      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(String(chunk));
      }

      // Await usage to trigger event emission
      await result.usage;

      adapter.uninstall();

      expect(chunks).toEqual(['Hello', ' from', ' streamText']);

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      );
      expect(ev).toBeDefined();
    });

    it('streamText LLM_CALL has framework="vercel-ai"', async () => {
      const { core, emitted } = makeCore();
      const adapter = new VercelAIAdapter();
      await adapter.install(core as never);

      const result = aiModule.streamText({ model: fakeModel, prompt: 'Hello!' }) as {
        textStream: AsyncIterable<string>;
        usage: Promise<unknown>;
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of result.textStream) { /* consume */ }
      await result.usage;

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['framework']).toBe('vercel-ai');
    });
  });

  // -------------------------------------------------------------------------
  // generateObject() LLM_CALL events
  // -------------------------------------------------------------------------

  describe('generateObject() LLM_CALL events', () => {
    it('generateObject emits LLM_CALL event', async () => {
      const { core, emitted } = makeCore();
      const adapter = new VercelAIAdapter();
      await adapter.install(core as never);

      await aiModule.generateObject({
        model: fakeModel,
        prompt: 'Return an answer',
        schema: {},
      });

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      );
      expect(ev).toBeDefined();
    });

    it('generateObject LLM_CALL has operation="generateObject"', async () => {
      const { core, emitted } = makeCore();
      const adapter = new VercelAIAdapter();
      await adapter.install(core as never);

      await aiModule.generateObject({
        model: fakeModel,
        prompt: 'Return an answer',
        schema: {},
      });

      adapter.uninstall();

      const ev = emitted.find(
        (e) => (e as Record<string, unknown>)['event_type'] === 'LLM_CALL',
      ) as Record<string, unknown>;
      expect(ev).toBeDefined();
      expect(ev['operation']).toBe('generateObject');
    });
  });

  // -------------------------------------------------------------------------
  // Config injection
  // -------------------------------------------------------------------------

  describe('config injection', () => {
    it('getConfig("llm") values merged into generateText opts', async () => {
      const { core } = makeCore({ llm: { temperature: 0.2, max_tokens: 1000 } });
      const adapter = new VercelAIAdapter();

      let capturedOpts: unknown;
      aiModule.generateText = async (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return { text: 'ok', usage: fakeUsage };
      };

      await adapter.install(core as never);

      await aiModule.generateText({ model: fakeModel, prompt: 'Hello!' });

      adapter.uninstall();

      expect((capturedOpts as Record<string, unknown>)?.['temperature']).toBe(0.2);
      // Vercel AI uses camelCase maxTokens
      expect((capturedOpts as Record<string, unknown>)?.['maxTokens']).toBe(1000);
    });

    it('empty config store causes no injection side-effects', async () => {
      const { core } = makeCore();
      const adapter = new VercelAIAdapter();

      let capturedOpts: unknown;
      aiModule.generateText = async (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return { text: 'ok', usage: fakeUsage };
      };

      await adapter.install(core as never);

      await aiModule.generateText({ model: fakeModel, prompt: 'Hello!', userOption: 'keep' });

      adapter.uninstall();

      expect((capturedOpts as Record<string, unknown>)?.['userOption']).toBe('keep');
    });
  });

  // -------------------------------------------------------------------------
  // FrameworkContext
  // -------------------------------------------------------------------------

  describe('FrameworkContext', () => {
    it('FrameworkContext is set with framework="vercel-ai" during generateText', async () => {
      const { core } = makeCore();
      const adapter = new VercelAIAdapter();

      let capturedCtx: unknown;
      aiModule.generateText = async (opts: Record<string, unknown>) => {
        capturedCtx = getFrameworkContext();
        return { text: 'ok', usage: { ...fakeUsage, ...opts } };
      };

      await adapter.install(core as never);

      await aiModule.generateText({ model: fakeModel, prompt: 'Hello!' });

      adapter.uninstall();

      expect((capturedCtx as Record<string, unknown>)?.['framework']).toBe('vercel-ai');
    });

    it('FrameworkContext is cleared after generateText completes', async () => {
      const { core } = makeCore();
      const adapter = new VercelAIAdapter();
      await adapter.install(core as never);

      await aiModule.generateText({ model: fakeModel, prompt: 'Hello!' });

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
      const adapter = new VercelAIAdapter();
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
