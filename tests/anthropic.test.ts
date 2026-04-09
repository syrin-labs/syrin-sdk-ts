/**
 * Tests: src/adapters/anthropic.ts
 *
 * Uses vi.mock to stub @anthropic-ai/sdk. The adapter must handle the
 * missing module gracefully (dynamic import + try/catch).
 *
 * The mock puts `create` as an instance field (class-field style), which
 * triggers the constructor-proxy patching path in the adapter — the same
 * path that would be used for bundled or transpiled SDKs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ISyrinCore, BeforeCallResult, NormalizedCallParams, NormalizedCallResult } from '@/adapters/types';
import type { SyrinConfig } from '@/types';

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/sdk
// ---------------------------------------------------------------------------

const mockMessagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockMessages {
    create = mockMessagesCreate;
  }

  class MockAnthropic {
    messages: MockMessages;
    baseURL: string;

    constructor(opts?: { apiKey?: string; baseURL?: string }) {
      this.messages = new MockMessages();
      this.baseURL = opts?.baseURL ?? 'https://api.anthropic.com';
    }
  }

  return {
    default: MockAnthropic,
    __MockAnthropic: MockAnthropic,
    __MockMessages: MockMessages,
  };
});

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
    ...overrides,
  };
}

function makeBeforeCallResult(overrides: Partial<BeforeCallResult> = {}): BeforeCallResult {
  return {
    sessionId: 'ses-test',
    agentId: 'agent-1',
    initialCumulativeCostUsd: 0,
    configApplied: false,
    governanceApplied: false,
    modifiedRaw: { model: 'claude-3-5-sonnet-20241022', messages: [], max_tokens: 1024 },
    modifiedMessages: [],
    tempUnsupported: false,
    ...overrides,
  };
}

function makeCore(config: SyrinConfig = makeConfig()): ISyrinCore {
  const beforeResult = makeBeforeCallResult();
  return {
    config,
    sessionStore: {} as ISyrinCore['sessionStore'],
    beforeCall: vi.fn().mockResolvedValue(beforeResult),
    afterCall: vi.fn(),
    onStreamComplete: vi.fn(),
    onCallError: vi.fn(),
  };
}

function makeAnthropicResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: 'Hello from Claude!' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
    },
    ...overrides,
  };
}

/**
 * Helper: get the (possibly proxied) Anthropic constructor from the module.
 * After install(), mod.default is the constructor proxy.
 */
async function getAnthropicClass(): Promise<new (opts?: unknown) => { messages: { create: (...a: unknown[]) => unknown }; baseURL?: string }> {
  const mod = await import('@anthropic-ai/sdk');
  return mod.default as unknown as new (opts?: unknown) => { messages: { create: (...a: unknown[]) => unknown }; baseURL?: string };
}

// ---------------------------------------------------------------------------
// Import the adapter under test (after mock setup)
// ---------------------------------------------------------------------------

const { AnthropicAdapter } = await import('../src/adapters/anthropic.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicAdapter', () => {
  let adapter: InstanceType<typeof AnthropicAdapter>;
  let core: ISyrinCore;

  beforeEach(async () => {
    adapter = new AnthropicAdapter();
    core = makeCore();
    vi.clearAllMocks();
    adapter.uninstall();
  });

  afterEach(() => {
    adapter.uninstall();
    vi.clearAllMocks();
  });

  // ── Install / uninstall ──────────────────────────────────────────────────

  it('install patches Messages.prototype.create', async () => {
    // Before install: create a pre-install instance to capture original create
    const mod = await import('@anthropic-ai/sdk');
    const OriginalClass = (mod as Record<string, unknown>)['__MockAnthropic'] as new (opts?: unknown) => { messages: { create: unknown } };
    const before = new OriginalClass();
    const originalCreate = before.messages.create;

    await adapter.install(core);

    // After install, mod.default is the proxy — new instances get patched create
    const ProxiedClass = mod.default as unknown as new (opts?: unknown) => { messages: { create: unknown } };
    const after = new ProxiedClass();
    // The patched create should differ from the raw mock function
    expect(after.messages.create).not.toBe(originalCreate);
  });

  it('uninstall restores original', async () => {
    const mod = await import('@anthropic-ai/sdk');
    const OriginalClass = mod.default;

    await adapter.install(core);
    adapter.uninstall();

    // After uninstall, isInstalled() is false and the adapter is clean
    expect(adapter.isInstalled()).toBe(false);
    // A freshly-created instance's create should be the raw mock function
    const PostUninstall = mod.default as unknown as new (opts?: unknown) => { messages: { create: unknown } };
    const inst = new PostUninstall();
    expect(inst.messages.create).toBe(mockMessagesCreate);
  });

  it('double install is idempotent', async () => {
    await adapter.install(core);
    await adapter.install(core); // second call should not throw or double-patch
    expect(adapter.isInstalled()).toBe(true);
  });

  it('isInstalled returns false before install', () => {
    expect(adapter.isInstalled()).toBe(false);
  });

  it('isInstalled returns true after install', async () => {
    await adapter.install(core);
    expect(adapter.isInstalled()).toBe(true);
  });

  it('isInstalled returns false after uninstall', async () => {
    await adapter.install(core);
    adapter.uninstall();
    expect(adapter.isInstalled()).toBe(false);
  });

  it('install without anthropic package does not throw', async () => {
    const safeAdapter = new AnthropicAdapter(null as unknown as undefined);
    await expect(safeAdapter.install(core)).resolves.not.toThrow();
  });

  // ── Non-streaming calls ──────────────────────────────────────────────────

  it('create calls beforeCall and afterCall', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse());
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    expect(core.beforeCall).toHaveBeenCalledOnce();
    expect(core.afterCall).toHaveBeenCalledOnce();
  });

  it('create uses modifiedRaw from beforeCall', async () => {
    const modifiedRaw = { model: 'claude-3-haiku-20240307', messages: [{ role: 'user', content: 'Modified' }], max_tokens: 512 };
    (core.beforeCall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeBeforeCallResult({ modifiedRaw })
    );
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse({ model: 'claude-3-haiku-20240307' }));

    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Original' }],
      max_tokens: 1024,
    });

    // The underlying create should have been called with modifiedRaw
    expect(mockMessagesCreate).toHaveBeenCalledWith(modifiedRaw, undefined);
  });

  it('create returns original response', async () => {
    const response = makeAnthropicResponse();
    mockMessagesCreate.mockResolvedValueOnce(response);
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    const result = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    expect(result).toEqual(response);
  });

  it('create extracts input_tokens and output_tokens from usage', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse({ usage: { input_tokens: 200, output_tokens: 75 } })
    );
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    const calls = (core.afterCall as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [, , result] = calls[0] as [BeforeCallResult, NormalizedCallParams, NormalizedCallResult];
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(75);
  });

  it('create extracts model from response.model', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse({ model: 'claude-3-5-sonnet-20241022' })
    );
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    const calls = (core.afterCall as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [, , result] = calls[0] as [BeforeCallResult, NormalizedCallParams, NormalizedCallResult];
    expect(result.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('create extracts stop_reason as finishReason', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse({ stop_reason: 'max_tokens' })
    );
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100,
    });

    const calls = (core.afterCall as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [, , result] = calls[0] as [BeforeCallResult, NormalizedCallParams, NormalizedCallResult];
    expect(result.finishReason).toBe('max_tokens');
  });

  it('create calls onCallError on exception and rethrows', async () => {
    const apiError = new Error('Anthropic rate limit');
    mockMessagesCreate.mockRejectedValueOnce(apiError);
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    await expect(
      client.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
      })
    ).rejects.toThrow('Anthropic rate limit');

    expect(core.onCallError).toHaveBeenCalledOnce();
    expect(core.afterCall).not.toHaveBeenCalled();
  });

  it('create with captureContent=false — responseText is undefined', async () => {
    core = makeCore(makeConfig({ captureContent: false }));
    (core.beforeCall as ReturnType<typeof vi.fn>).mockResolvedValue(makeBeforeCallResult());
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse());
    adapter.uninstall();
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    const calls = (core.afterCall as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [, , result] = calls[0] as [BeforeCallResult, NormalizedCallParams, NormalizedCallResult];
    expect(result.responseText).toBeUndefined();
  });

  it('create with captureContent=true — responseText extracted from text content block', async () => {
    core = makeCore(makeConfig({ captureContent: true }));
    (core.beforeCall as ReturnType<typeof vi.fn>).mockResolvedValue(makeBeforeCallResult());
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse({ content: [{ type: 'text', text: 'Hello from Claude!' }] })
    );
    adapter.uninstall();
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    const calls = (core.afterCall as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [, , result] = calls[0] as [BeforeCallResult, NormalizedCallParams, NormalizedCallResult];
    expect(result.responseText).toBe('Hello from Claude!');
  });

  // ── Streaming ────────────────────────────────────────────────────────────

  it('streaming wraps async iterator and yields chunks', async () => {
    const chunks = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
    ];

    async function* mockStream() {
      for (const chunk of chunks) yield chunk;
    }

    const streamIterable = { [Symbol.asyncIterator]: () => mockStream() };
    mockMessagesCreate.mockResolvedValueOnce(streamIterable);

    (core.beforeCall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeBeforeCallResult({ modifiedRaw: { model: 'claude-3-5-sonnet-20241022', messages: [], max_tokens: 1024, stream: true } })
    );

    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    const result = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
      stream: true,
    });

    const collected: unknown[] = [];
    for await (const chunk of result as AsyncIterable<unknown>) {
      collected.push(chunk);
    }

    expect(collected).toHaveLength(chunks.length);
  });

  it('streaming calls onStreamComplete after iteration', async () => {
    async function* mockStream() {
      yield { type: 'message_start', message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 50 } } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } };
    }

    const streamIterable = { [Symbol.asyncIterator]: () => mockStream() };
    mockMessagesCreate.mockResolvedValueOnce(streamIterable);

    (core.beforeCall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeBeforeCallResult({ modifiedRaw: { model: 'claude-3-5-sonnet-20241022', messages: [], max_tokens: 1024, stream: true } })
    );

    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    const stream = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
      stream: true,
    });

    // Drain the stream
    for await (const _ of stream as AsyncIterable<unknown>) { /* noop */ }

    expect(core.onStreamComplete).toHaveBeenCalledOnce();
  });

  it('streaming accumulates text from content_block_delta events', async () => {
    const textCore = makeCore(makeConfig({ captureContent: true }));
    (textCore.beforeCall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      makeBeforeCallResult({ modifiedRaw: { model: 'claude-3-5-sonnet-20241022', messages: [], max_tokens: 1024, stream: true } })
    );

    async function* mockStream() {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ', world' } };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } };
    }

    const streamIterable = { [Symbol.asyncIterator]: () => mockStream() };
    mockMessagesCreate.mockResolvedValueOnce(streamIterable);

    adapter.uninstall();
    await adapter.install(textCore);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    const stream = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
      stream: true,
    });

    for await (const _ of stream as AsyncIterable<unknown>) { /* noop */ }

    const calls = (textCore.onStreamComplete as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [, , result] = calls[0] as [BeforeCallResult, NormalizedCallParams, NormalizedCallResult];
    expect(result.responseText).toBe('Hello, world');
  });

  // ── Normalization ────────────────────────────────────────────────────────

  it('normalizeParams extracts model, messages, temperature, max_tokens', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse());
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 512,
      temperature: 0.7,
    });

    const calls = (core.beforeCall as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [normalizedParams] = calls[0] as [NormalizedCallParams];
    expect(normalizedParams.model).toBe('claude-3-5-sonnet-20241022');
    expect(normalizedParams.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(normalizedParams.temperature).toBe(0.7);
    expect(normalizedParams.max_tokens).toBe(512);
    expect(normalizedParams.stream).toBe(false);
  });

  it('normalizeParams tools=undefined when not provided', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse());
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    const calls = (core.beforeCall as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [normalizedParams] = calls[0] as [NormalizedCallParams];
    expect(normalizedParams.tools).toBeUndefined();
  });

  it('normalizeParams handles Anthropic tool format (name + input_schema)', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse());
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    const tools = [
      {
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { location: { type: 'string' } } },
      },
    ];

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      max_tokens: 1024,
      tools,
    });

    const calls = (core.beforeCall as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [normalizedParams] = calls[0] as [NormalizedCallParams];
    expect(normalizedParams.tools).toBeDefined();
    expect(normalizedParams.tools![0].name).toBe('get_weather');
    expect(normalizedParams.tools![0].parameters).toEqual(tools[0].input_schema);
  });

  it('extractResult with no usage defaults to 0 tokens', async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse({ usage: undefined })
    );
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test' });

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    const calls = (core.afterCall as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [, , result] = calls[0] as [BeforeCallResult, NormalizedCallParams, NormalizedCallResult];
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  // ── Provider detection ───────────────────────────────────────────────────

  it('provider detected from Anthropic client baseUrl', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse());
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client({ apiKey: 'test', baseURL: 'https://api.anthropic.com' });

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    expect(core.afterCall).toHaveBeenCalledOnce();
    const calls = (core.beforeCall as ReturnType<typeof vi.fn>).mock.calls;
    const [normalizedParams] = calls[0] as [NormalizedCallParams];
    // Provider is embedded in the raw params for telemetry
    expect(normalizedParams.raw['_syrin_provider']).toBe('anthropic');
  });

  it('defaults to anthropic provider for standard client', async () => {
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse());
    await adapter.install(core);

    const Client = await getAnthropicClass();
    const client = new Client();

    await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
    });

    expect(core.beforeCall).toHaveBeenCalledOnce();
    expect(core.afterCall).toHaveBeenCalledOnce();
    const calls = (core.beforeCall as ReturnType<typeof vi.fn>).mock.calls;
    const [normalizedParams] = calls[0] as [NormalizedCallParams];
    expect(normalizedParams.raw['_syrin_provider']).toBe('anthropic');
  });
});
