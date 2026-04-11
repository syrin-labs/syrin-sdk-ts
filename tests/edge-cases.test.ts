/**
 * Edge case tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SyrinConfig, SyrinEvent } from '@/types';
import { SessionStore } from '@/core/session';
import { Emitter } from '@/observability/emitter';
import { OTelBridge } from '@/observability/otel';
import { CheckpointClient } from '@/core/checkpoint';
import { SyrinCore } from '@/core/engine';
import { patchWithModule, unpatch } from '@/adapters/openai/index';
import { estimateCost, detectProvider } from '@/utils/helpers';

// Mock openai — create on prototype (matches real SDK v4 structure)
vi.mock('openai', () => {
  const mockCreate = vi.fn();

  class MockCompletions {}
  (MockCompletions.prototype as Record<string, unknown>)['create'] = mockCreate;

  class MockChat {
    completions: MockCompletions;
    constructor() {
      this.completions = new MockCompletions();
    }
  }

  class MockOpenAI {
    chat: MockChat;
    constructor(_options?: unknown) {
      this.chat = new MockChat();
    }
    static Completions = MockCompletions;
  }

  return {
    default: MockOpenAI,
    Completions: MockCompletions,
    __mockCreate: mockCreate,
  };
});

async function getMockCreate(): Promise<ReturnType<typeof vi.fn>> {
  const mod = await import('openai');
  return (mod as unknown as { __mockCreate: ReturnType<typeof vi.fn> }).__mockCreate;
}

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4399',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4399',
    debug: false,
    captureContent: false,
    offline: true,
    batchIntervalMs: 60000,
    batchSize: 200,
    ...overrides,
  };
}

function makeSuccessResponse(model = 'gpt-4o') {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Date.now(),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Response' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe('Edge cases', () => {
  let config: SyrinConfig;
  let sessionStore: SessionStore;
  let emitter: Emitter;
  let otelBridge: OTelBridge;

  beforeEach(async () => {
    unpatch();
    config = makeConfig();
    sessionStore = new SessionStore();
    emitter = new Emitter(config, sessionStore);
    otelBridge = new OTelBridge(config);
    otelBridge.setup();

    const openaiModule = await import('openai');
    const checkpointClient = new CheckpointClient(config);
    const core = new SyrinCore(config, sessionStore, emitter, otelBridge, checkpointClient);
    patchWithModule(openaiModule, core);
  });

  afterEach(async () => {
    unpatch();
    await emitter.stop();
    vi.clearAllMocks();
  });

  it('init() twice: second call logs warning and reinitializes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { init, shutdown } = await import('../src/index.js');

    unpatch(); // ensure clean state
    const instance1 = await init({ apiKey: 'syrin_first', offline: true });
    const instance2 = await init({ apiKey: 'syrin_second', offline: true });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/already initialized/));
    expect(instance2).not.toBe(instance1);

    await shutdown();
    warnSpy.mockRestore();
  });

  it('init() without apiKey throws descriptive error', async () => {
    delete process.env['SYRIN_API_KEY'];
    const { createConfig } = await import('../src/config/config.js');
    expect(() => createConfig({} as Parameters<typeof createConfig>[0])).toThrow(/apiKey/);
  });

  it('handles 50 concurrent calls without errors or dropped events', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeSuccessResponse());

    const emitSpy = vi.spyOn(emitter, 'emit');

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const { sessionStorage } = await import('../src/core/session.js');

    const sessionId = 'concurrent-session';
    await sessionStore.getOrCreate(sessionId, undefined);

    const calls = Array.from({ length: 50 }, (_, i) =>
      sessionStorage.run(sessionId, () =>
        client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: `Call ${i}` }],
        })
      )
    );

    await Promise.all(calls);

    expect(emitSpy).toHaveBeenCalledTimes(50);

    const events = emitSpy.mock.calls.map(([ev]) => ev as SyrinEvent);
    expect(events.filter((e) => e.event_type === 'LLM_CALL')).toHaveLength(50);
  });

  it('unknown model: cost estimated with fallback pricing (non-zero)', () => {
    const cost = estimateCost('unknown-model-xyz', 1000, 500);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(0.0025, 4);
  });

  it('unknown model: detectProvider returns "unknown"', () => {
    expect(detectProvider('unknown-model-xyz')).toBe('unknown');
  });

  it('very large response content: event emitted correctly', async () => {
    const largeContent = 'x'.repeat(100_000);
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce({
      ...makeSuccessResponse(),
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: largeContent },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 50000, completion_tokens: 25000, total_tokens: 75000 },
    });

    const emitSpy = vi.spyOn(emitter, 'emit');

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Write me a lot' }],
    });

    expect(emitSpy).toHaveBeenCalledOnce();
    const [event] = emitSpy.mock.calls[0] as [SyrinEvent, string];
    expect(event.event_type).toBe('LLM_CALL');
    expect(event.input_tokens).toBe(50000);
    expect(event.output_tokens).toBe(25000);
    expect(event.cost_usd).toBeGreaterThan(0);
  });

  it('patchWithModule called twice does not double-patch', async () => {
    const openaiModule = await import('openai');
    // Already patched — second call should be a no-op
    const checkpointClient = new CheckpointClient(config);
    const core = new SyrinCore(config, sessionStore, emitter, otelBridge, checkpointClient);
    patchWithModule(openaiModule, core);

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());

    const emitSpy = vi.spyOn(emitter, 'emit');

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    // Should emit exactly once
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('session accumulates cumulative cost across multiple calls', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeSuccessResponse('gpt-4o'));

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const { sessionStorage } = await import('../src/core/session.js');
    const sessionId = 'cumulative-cost-session';
    await sessionStore.getOrCreate(sessionId, undefined);

    for (let i = 0; i < 3; i++) {
      await sessionStorage.run(sessionId, async () => {
        await client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: `Call ${i}` }],
        });
      });
    }

    const session = sessionStore.getSession(sessionId);
    expect(session?.callCount).toBe(3);
    expect(session?.cumulativeCostUsd).toBeGreaterThan(0);
    // 3 calls × (100 input × $2.5/1M + 50 output × $10/1M) = 3 × $0.00075 = $0.00225
    expect(session?.cumulativeCostUsd).toBeCloseTo(0.00225, 4);
  });
});
