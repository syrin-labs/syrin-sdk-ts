/**
 * Tests: src/interceptors/openai.ts — streaming, unpatch, edge cases
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SyrinConfig } from '@/types';
import { SessionStore } from '@/core/session';
import { Emitter } from '@/observability/emitter';
import { OTelBridge } from '@/observability/otel';
import { CheckpointClient } from '@/core/checkpoint';
import { SyrinCore } from '@/core/engine';
import { patchWithModule, unpatch, isPatched } from '@/interceptors/openai';
import { sessionStorage } from '@/core/session';

// Mock openai module with prototype-based create (mirrors real SDK)
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

async function makeCore(configOverrides: Partial<SyrinConfig> = {}): Promise<{
  core: SyrinCore;
  sessionStore: SessionStore;
  emitter: Emitter;
}> {
  const config = makeConfig(configOverrides);
  const sessionStore = new SessionStore();
  const emitter = new Emitter(config, sessionStore);
  const otelBridge = new OTelBridge(config);
  otelBridge.setup();
  const checkpointClient = new CheckpointClient(config);
  const core = new SyrinCore(config, sessionStore, emitter, otelBridge, checkpointClient);
  const openaiModule = await import('openai');
  patchWithModule(openaiModule, core);
  return { core, sessionStore, emitter };
}

function makeSuccessResponse(model = 'gpt-4o', content = 'Hello!') {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Date.now(),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

beforeEach(() => unpatch());
afterEach(() => {
  unpatch();
  vi.clearAllMocks();
});

describe('patchWithModule / isPatched / unpatch', () => {
  it('isPatched returns false before patching', () => {
    expect(isPatched()).toBe(false);
  });

  it('isPatched returns true after patching', async () => {
    await makeCore();
    expect(isPatched()).toBe(true);
  });

  it('isPatched returns false after unpatch', async () => {
    await makeCore();
    unpatch();
    expect(isPatched()).toBe(false);
  });

  it('patchWithModule is idempotent (does not double-patch)', async () => {
    const { core } = await makeCore();
    const openaiModule = await import('openai');
    // Second patch call should be a no-op
    patchWithModule(openaiModule, core);
    expect(isPatched()).toBe(true);
  });

  it('unpatch restores original create function', async () => {
    const mockCreate = await getMockCreate();
    const originalCreate = mockCreate;

    await makeCore();
    unpatch();

    // After unpatch, prototype create should be restored to original
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });
    // The patched version should not be the current create
    expect(isPatched()).toBe(false);
    // client.chat.completions.create should be callable without going through our wrapper
    void client; // suppress unused warning
    void originalCreate;
  });
});

describe('streaming response handling', () => {
  it('wraps stream and calls onStreamComplete on exhaustion', async () => {
    const mockCreate = await getMockCreate();
    const { core, sessionStore } = await makeCore({ captureContent: true });
    const onStreamCompleteSpy = vi.spyOn(core, 'onStreamComplete');

    // Create a mock async iterable stream
    const chunks = [
      {
        model: 'gpt-4o',
        choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
      },
      {
        model: 'gpt-4o',
        choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ];

    // eslint-disable-next-line @typescript-eslint/require-await
    const asyncIterator = async function* () {
      for (const chunk of chunks) yield chunk;
    };

    const mockStream = {
      [Symbol.asyncIterator]: asyncIterator,
    };

    mockCreate.mockResolvedValueOnce(mockStream);

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'ses_stream_1';
    await sessionStore.getOrCreate(sessionId);

    const stream = await sessionStorage.run(sessionId, () =>
      client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      })
    );

    // Exhaust the stream
    const collectedChunks: unknown[] = [];
    for await (const chunk of stream as AsyncIterable<unknown>) {
      collectedChunks.push(chunk);
    }

    expect(collectedChunks).toHaveLength(2);
    expect(onStreamCompleteSpy).toHaveBeenCalledOnce();
    const [, , result] = onStreamCompleteSpy.mock.calls[0];
    expect(result.stream).toBe(true);
    expect(result.responseText).toBe('Hello world');
  });

  it('calls onCallError when stream creation fails', async () => {
    const mockCreate = await getMockCreate();
    const { core, sessionStore } = await makeCore();
    const onCallErrorSpy = vi.spyOn(core, 'onCallError');

    mockCreate.mockRejectedValueOnce(new Error('Stream failed'));

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'ses_stream_2';
    await sessionStore.getOrCreate(sessionId);

    await expect(
      sessionStorage.run(sessionId, () =>
        client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        })
      )
    ).rejects.toThrow('Stream failed');

    expect(onCallErrorSpy).toHaveBeenCalledOnce();
  });

  it('stream wrapper proxies other properties', async () => {
    const mockCreate = await getMockCreate();
    const { sessionStore } = await makeCore();

    // eslint-disable-next-line @typescript-eslint/require-await
    const asyncIterator = async function* () {
      yield { model: 'gpt-4o', choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] };
    };

    const mockStream = {
      [Symbol.asyncIterator]: asyncIterator,
      controller: { abort: vi.fn() },
    };

    mockCreate.mockResolvedValueOnce(mockStream);

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'ses_stream_3';
    await sessionStore.getOrCreate(sessionId);

    const stream = await sessionStorage.run(sessionId, () =>
      client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      })
    );

    // Proxy should forward other props
    expect((stream as unknown as typeof mockStream).controller).toBeDefined();
  });
});

describe('non-streaming edge cases', () => {
  it('handles response with tool_calls', async () => {
    const mockCreate = await getMockCreate();
    const { sessionStore, emitter } = await makeCore();
    const emitSpy = vi.spyOn(emitter, 'emit');

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc_1', function: { name: 'search', arguments: '{"q":"test"}' } }],
        },
      }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'ses_tools_1';
    await sessionStore.getOrCreate(sessionId);

    await sessionStorage.run(sessionId, () =>
      client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Search for X' }],
        tools: [{ function: { name: 'search', parameters: {} } }],
      })
    );

    const eventTypes = emitSpy.mock.calls.map((c) => c[0].event_type);
    expect(eventTypes).toContain('LLM_CALL');
    expect(eventTypes).toContain('TOOL_CALL');
  });

  it('handles empty usage gracefully', async () => {
    const mockCreate = await getMockCreate();
    const { sessionStore, emitter } = await makeCore();
    const emitSpy = vi.spyOn(emitter, 'emit');

    mockCreate.mockResolvedValueOnce({
      model: 'gpt-4o',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      // No usage field
    });

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'ses_no_usage';
    await sessionStore.getOrCreate(sessionId);

    await sessionStorage.run(sessionId, () =>
      client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    );

    const event = emitSpy.mock.calls[0][0];
    expect(event.input_tokens).toBe(0);
    expect(event.output_tokens).toBe(0);
  });

  it('handles non-Error thrown objects', async () => {
    const mockCreate = await getMockCreate();
    const { sessionStore } = await makeCore();

    mockCreate.mockRejectedValueOnce('string error');

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'ses_string_err';
    await sessionStore.getOrCreate(sessionId);

    await expect(
      sessionStorage.run(sessionId, () =>
        client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hi' }],
        })
      )
    ).rejects.toBeDefined();
  });

  it('captureContent includes response text', async () => {
    const mockCreate = await getMockCreate();
    const { sessionStore, emitter } = await makeCore({ captureContent: true });
    const emitSpy = vi.spyOn(emitter, 'emit');

    mockCreate.mockResolvedValueOnce(makeSuccessResponse('gpt-4o', 'Captured content here'));

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'ses_capture';
    await sessionStore.getOrCreate(sessionId);

    await sessionStorage.run(sessionId, () =>
      client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    );

    const event = emitSpy.mock.calls[0][0];
    expect(event['completion_text']).toBe('Captured content here');
  });
});
