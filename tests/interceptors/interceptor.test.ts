/**
 * Tests: src/interceptor.ts
 *
 * Uses vi.mock to mock the openai module — no real API calls.
 * Mock structure mirrors the real OpenAI SDK v4 (create on prototype, not class field).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SyrinConfig, SyrinEvent } from '@/types';
import { SessionStore } from '@/core/session';
import { Emitter } from '@/observability/emitter';
import { OTelBridge } from '@/observability/otel';
import { CheckpointClient } from '@/core/checkpoint';
import { SyrinCore } from '@/core/engine';
import { patchWithModule, unpatch } from '@/interceptors/openai';

// Mock openai module — create is on the prototype to match real SDK v4 behavior
vi.mock('openai', () => {
  const mockCreate = vi.fn();

  class MockCompletions {}
  // Put create on the prototype (matches real OpenAI SDK structure)
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

// Helper to get the mock create function
async function getMockCreate(): Promise<ReturnType<typeof vi.fn>> {
  const mod = await import('openai');
  return (mod as unknown as { __mockCreate: ReturnType<typeof vi.fn> }).__mockCreate;
}

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4318',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4318',
    debug: false,
    captureContent: false,
    offline: true,
    batchIntervalMs: 60000,
    batchSize: 50,
    ...overrides,
  };
}

function makeSuccessResponse(model = 'gpt-4o', content = 'Hello!') {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Date.now(),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    },
  };
}

describe('interceptor: patchWithModule', () => {
  let config: SyrinConfig;
  let sessionStore: SessionStore;
  let emitter: Emitter;
  let otelBridge: OTelBridge;
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    unpatch();
    config = makeConfig();
    sessionStore = new SessionStore();
    emitter = new Emitter(config, sessionStore);
    otelBridge = new OTelBridge(config);
    otelBridge.setup();
    emitSpy = vi.spyOn(emitter, 'emit');

    const openaiModule = await import('openai');
    const checkpointClient = new CheckpointClient(config);
    const core = new SyrinCore(config, sessionStore, emitter, otelBridge, checkpointClient);
    patchWithModule(openaiModule, core);
  });

  afterEach(() => {
    unpatch();
    vi.clearAllMocks();
  });

  it('intercepts create and returns response unchanged', async () => {
    const mockCreate = await getMockCreate();
    const expectedResponse = makeSuccessResponse();
    mockCreate.mockResolvedValueOnce(expectedResponse);

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const result = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result).toEqual(expectedResponse);
  });

  it('emits an event after a successful call', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(emitSpy).toHaveBeenCalledOnce();
    const [event] = emitSpy.mock.calls[0] as [SyrinEvent, string];
    expect(event.event_type).toBe('LLM_CALL');
    expect(event.model).toBe('gpt-4o');
    expect(event.input_tokens).toBe(100);
    expect(event.output_tokens).toBe(50);
    expect(event.stream).toBe(false);
  });

  it('injects config override (temperature) from activeConfig', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'test-session-with-config';
    await sessionStore.getOrCreate(sessionId, undefined);
    sessionStore.applyConfigUpdate(sessionId, { temperature: 0.3 });

    const { sessionStorage } = await import('../../src/core/session.js');
    await sessionStorage.run(sessionId, async () => {
      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    const calledParams = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(calledParams['temperature']).toBe(0.3);

    const [event] = emitSpy.mock.calls[0] as [SyrinEvent, string];
    expect(event.config_applied).toBe(true);
  });

  it('emits LLM_ERROR event when API throws, and re-throws the error', async () => {
    const mockCreate = await getMockCreate();
    const apiError = new Error('Rate limit exceeded');
    mockCreate.mockRejectedValueOnce(apiError);

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    await expect(
      client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      })
    ).rejects.toThrow('Rate limit exceeded');

    expect(emitSpy).toHaveBeenCalledOnce();
    const [event] = emitSpy.mock.calls[0] as [SyrinEvent, string];
    expect(event.event_type).toBe('LLM_ERROR');
    expect(event.error).toBe('Rate limit exceeded');
  });

  it('does NOT inject temperature for o1 models', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeSuccessResponse('o1'));

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'o1-test-session';
    await sessionStore.getOrCreate(sessionId, undefined);
    sessionStore.applyConfigUpdate(sessionId, { temperature: 0.7 });

    const { sessionStorage } = await import('../../src/core/session.js');
    await sessionStorage.run(sessionId, async () => {
      await client.chat.completions.create({
        model: 'o1',
        messages: [{ role: 'user', content: 'Think step by step' }],
      });
    });

    const calledParams = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(calledParams['temperature']).toBeUndefined();
  });

  it('does NOT inject temperature for o3-mini models', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeSuccessResponse('o3-mini'));

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'o3-mini-session';
    await sessionStore.getOrCreate(sessionId, undefined);
    sessionStore.applyConfigUpdate(sessionId, { temperature: 0.5 });

    const { sessionStorage } = await import('../../src/core/session.js');
    await sessionStorage.run(sessionId, async () => {
      await client.chat.completions.create({
        model: 'o3-mini',
        messages: [{ role: 'user', content: 'Solve this' }],
      });
    });

    const calledParams = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(calledParams['temperature']).toBeUndefined();
  });

  it('clamps temperature to 1.0 for Anthropic models via openai-compat', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeSuccessResponse('claude-3-5-sonnet-20241022', 'Sure!'));

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'claude-session';
    await sessionStore.getOrCreate(sessionId, undefined);
    sessionStore.applyConfigUpdate(sessionId, { temperature: 1.8 }); // Over Anthropic's limit

    const { sessionStorage } = await import('../../src/core/session.js');
    await sessionStorage.run(sessionId, async () => {
      await client.chat.completions.create({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });

    const calledParams = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(calledParams['temperature']).toBe(1.0);
  });

  it('does not mutate the original params object', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'no-mutate-session';
    await sessionStore.getOrCreate(sessionId, undefined);
    sessionStore.applyConfigUpdate(sessionId, { temperature: 0.5, max_tokens: 100 });

    const originalParams = {
      model: 'gpt-4o',
      messages: [{ role: 'user' as const, content: 'Hello' }],
    };
    const originalParamsCopy = { ...originalParams };

    const { sessionStorage } = await import('../../src/core/session.js');
    await sessionStorage.run(sessionId, async () => {
      await client.chat.completions.create(originalParams);
    });

    expect(originalParams).toEqual(originalParamsCopy);
  });

  it('calculates cost and records it in the session', async () => {
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeSuccessResponse('gpt-4o'));

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'cost-tracking-session';
    await sessionStore.getOrCreate(sessionId, undefined);

    const { sessionStorage } = await import('../../src/core/session.js');
    await sessionStorage.run(sessionId, async () => {
      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });

    const session = sessionStore.getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.callCount).toBe(1);
    expect(session!.cumulativeCostUsd).toBeGreaterThan(0);
  });
});
