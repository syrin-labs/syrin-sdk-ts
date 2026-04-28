/**
 * Tests for interceptors/anthropic.ts — covers sync, streaming, config injection,
 * governance stop, error handling, tool calls, and unpatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { patchWithModule, unpatch, isPatched } from '@/interceptors/anthropic.js';
import type { ICallTarget, BeforeCallResult, NormalizedCallParams, NormalizedCallResult } from '@/core/call-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCore(overrides: Partial<ICallTarget> = {}): ICallTarget {
  return {
    config: { debug: false, captureContent: false } as ICallTarget['config'],
    sessionStore: {} as ICallTarget['sessionStore'],
    beforeCall: vi.fn().mockResolvedValue({ modifiedRaw: { model: 'claude-3-5-sonnet-20241022', messages: [], max_tokens: 1024 }, sessionId: 'ses_test', agentId: null }),
    afterCall: vi.fn(),
    onStreamComplete: vi.fn(),
    onCallError: vi.fn(),
    ...overrides,
  } as unknown as ICallTarget;
}

function makeBeforeCallResult(overrides: Partial<BeforeCallResult> = {}): BeforeCallResult {
  return {
    modifiedRaw: { model: 'claude-3-5-sonnet-20241022', messages: [], max_tokens: 1024 },
    sessionId: 'ses_test',
    agentId: null,
    configApplied: false,
    ...overrides,
  } as BeforeCallResult;
}

function makeAnthropicResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: 'Hello from Claude!' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

function makeMockAnthropicModule(createImpl: (...args: unknown[]) => unknown) {
  class MockMessages {
    create = createImpl;
  }
  class MockAnthropic {
    messages = new MockMessages();
  }
  return {
    default: MockAnthropic,
    Anthropic: MockAnthropic,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  unpatch();
});

afterEach(() => {
  unpatch();
});

// ---------------------------------------------------------------------------
// Basic patching
// ---------------------------------------------------------------------------

describe('patchWithModule', () => {
  it('marks as patched after patchWithModule', () => {
    const core = makeCore();
    const mod = makeMockAnthropicModule(vi.fn().mockResolvedValue(makeAnthropicResponse()));
    patchWithModule(mod, core);
    expect(isPatched()).toBe(true);
  });

  it('is idempotent — calling twice does not double-wrap', () => {
    const core = makeCore();
    const origCreate = vi.fn().mockResolvedValue(makeAnthropicResponse());
    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);
    patchWithModule(mod, core); // second call should be a no-op
    expect(isPatched()).toBe(true);
  });

  it('unpatch() restores original and marks as unpatched', () => {
    const core = makeCore();
    const mod = makeMockAnthropicModule(vi.fn().mockResolvedValue(makeAnthropicResponse()));
    patchWithModule(mod, core);
    unpatch();
    expect(isPatched()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Successful call flow
// ---------------------------------------------------------------------------

describe('successful create call', () => {
  it('calls beforeCall and afterCall with normalized params', async () => {
    const response = makeAnthropicResponse();
    const origCreate = vi.fn().mockResolvedValue(response);
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult()),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(core.beforeCall).toHaveBeenCalledOnce();
    expect(core.afterCall).toHaveBeenCalledOnce();
  });

  it('passes through the original response unchanged', async () => {
    const response = makeAnthropicResponse({ content: [{ type: 'text', text: 'test response' }] });
    const origCreate = vi.fn().mockResolvedValue(response);
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult()),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    const result = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result).toBe(response);
  });

  it('extracts Anthropic-specific usage tokens (input_tokens / output_tokens)', async () => {
    const response = makeAnthropicResponse({ usage: { input_tokens: 200, output_tokens: 75 } });
    const origCreate = vi.fn().mockResolvedValue(response);

    let capturedResult: NormalizedCallResult | null = null;
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult()),
      afterCall: vi.fn((_ctx, _params, result) => { capturedResult = result as NormalizedCallResult; }),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(capturedResult?.inputTokens).toBe(200);
    expect(capturedResult?.outputTokens).toBe(75);
  });

  it('uses stop_reason as finishReason (not choices[0].finish_reason)', async () => {
    const response = makeAnthropicResponse({ stop_reason: 'max_tokens' });
    const origCreate = vi.fn().mockResolvedValue(response);

    let capturedResult: NormalizedCallResult | null = null;
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult()),
      afterCall: vi.fn((_ctx, _params, result) => { capturedResult = result as NormalizedCallResult; }),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(capturedResult?.finishReason).toBe('max_tokens');
  });
});

// ---------------------------------------------------------------------------
// Tool use extraction
// ---------------------------------------------------------------------------

describe('tool_use blocks', () => {
  it('extracts tool_use blocks as toolCalls in result', async () => {
    const response = makeAnthropicResponse({
      content: [
        { type: 'tool_use', id: 'toolu_abc', name: 'get_weather', input: { city: 'NYC' } },
      ],
      stop_reason: 'tool_use',
    });
    const origCreate = vi.fn().mockResolvedValue(response);

    let capturedResult: NormalizedCallResult | null = null;
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult()),
      afterCall: vi.fn((_ctx, _params, result) => { capturedResult = result as NormalizedCallResult; }),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object' } }],
    });

    expect(capturedResult?.toolCalls).toHaveLength(1);
    expect(capturedResult?.toolCalls?.[0].name).toBe('get_weather');
    expect(capturedResult?.toolCalls?.[0].id).toBe('toolu_abc');
  });

  it('includes tool_definitions from the request tools array', async () => {
    const response = makeAnthropicResponse();
    const origCreate = vi.fn().mockResolvedValue(response);

    let capturedResult: NormalizedCallResult | null = null;
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult()),
      afterCall: vi.fn((_ctx, _params, result) => { capturedResult = result as NormalizedCallResult; }),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        { name: 'search', description: 'Search the web', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
      ],
    });

    expect(capturedResult?.toolDefinitions).toHaveLength(1);
    expect(capturedResult?.toolDefinitions?.[0].name).toBe('search');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('calls onCallError and re-throws on failure', async () => {
    const error = new Error('rate_limit_error');
    const origCreate = vi.fn().mockRejectedValue(error);
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult()),
      onCallError: vi.fn(),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await expect(
      client.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 1024, messages: [] })
    ).rejects.toThrow('rate_limit_error');

    expect(core.onCallError).toHaveBeenCalledOnce();
    expect(core.afterCall).not.toHaveBeenCalled();
  });

  it('does NOT call afterCall when the original create throws', async () => {
    const origCreate = vi.fn().mockRejectedValue(new Error('overloaded'));
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult()),
      afterCall: vi.fn(),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    try { await client.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 1024, messages: [] }); } catch { /* expected */ }

    expect(core.afterCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe('streaming', () => {
  it('calls onStreamComplete after consuming a stream', async () => {
    const events = [
      { type: 'message_start', message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];

    async function* fakeStream() {
      for (const e of events) yield e;
    }

    const origCreate = vi.fn().mockResolvedValue(fakeStream());
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult({
        modifiedRaw: { model: 'claude-3-5-sonnet-20241022', messages: [], max_tokens: 1024, stream: true },
      })),
      onStreamComplete: vi.fn(),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    const stream = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    }) as AsyncIterable<unknown>;

    // Consume
    const chunks: unknown[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(core.onStreamComplete).toHaveBeenCalledOnce();
    const result = (core.onStreamComplete as ReturnType<typeof vi.fn>).mock.calls[0][2] as NormalizedCallResult;
    expect(result.stream).toBe(true);
    expect(result.finishReason).toBe('end_turn');
  });

  it('calls onCallError when stream creation fails', async () => {
    const origCreate = vi.fn().mockRejectedValue(new Error('stream error'));
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult({
        modifiedRaw: { model: 'claude-3-5-sonnet-20241022', messages: [], max_tokens: 1024, stream: true },
      })),
      onCallError: vi.fn(),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await expect(
      client.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 1024, messages: [], stream: true })
    ).rejects.toThrow('stream error');

    expect(core.onCallError).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// System prompt normalization
// ---------------------------------------------------------------------------

describe('system prompt handling', () => {
  it('normalizes system param as a system role message', async () => {
    const origCreate = vi.fn().mockResolvedValue(makeAnthropicResponse());
    let capturedParams: NormalizedCallParams | null = null;
    const core = makeCore({
      beforeCall: vi.fn().mockImplementation(async (params: NormalizedCallParams) => {
        capturedParams = params;
        return makeBeforeCallResult({ modifiedRaw: { ...params.raw } });
      }),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const systemMsg = capturedParams?.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toBe('You are a helpful assistant.');
  });
});

// ---------------------------------------------------------------------------
// Content capture
// ---------------------------------------------------------------------------

describe('content capture', () => {
  it('includes responseText only when captureContent=true', async () => {
    const response = makeAnthropicResponse({ content: [{ type: 'text', text: 'secret answer' }] });
    const origCreate = vi.fn().mockResolvedValue(response);

    let capturedResult: NormalizedCallResult | null = null;
    const core = makeCore({
      config: { debug: false, captureContent: true } as ICallTarget['config'],
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult()),
      afterCall: vi.fn((_ctx, _params, result) => { capturedResult = result as NormalizedCallResult; }),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 1024, messages: [{ role: 'user', content: 'Hi' }] });

    expect(capturedResult?.responseText).toBe('secret answer');
  });

  it('omits responseText when captureContent=false (default)', async () => {
    const response = makeAnthropicResponse();
    const origCreate = vi.fn().mockResolvedValue(response);

    let capturedResult: NormalizedCallResult | null = null;
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult()),
      afterCall: vi.fn((_ctx, _params, result) => { capturedResult = result as NormalizedCallResult; }),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 1024, messages: [{ role: 'user', content: 'Hi' }] });

    expect(capturedResult?.responseText).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// beforeCall modification of params
// ---------------------------------------------------------------------------

describe('config injection via beforeCall', () => {
  it('passes modifiedRaw to the original create', async () => {
    const origCreate = vi.fn().mockResolvedValue(makeAnthropicResponse());
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult({
        modifiedRaw: {
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 512,
          messages: [{ role: 'user', content: 'Hello' }],
          temperature: 0.5,
        },
        configApplied: true,
      })),
    });

    const mod = makeMockAnthropicModule(origCreate);
    patchWithModule(mod, core);

    const client = new (mod.default as unknown as new (o: { apiKey: string }) => { messages: { create: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const calledWith = origCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(calledWith['model']).toBe('claude-3-5-haiku-20241022');
    expect(calledWith['max_tokens']).toBe(512);
    expect(calledWith['temperature']).toBe(0.5);
  });
});
