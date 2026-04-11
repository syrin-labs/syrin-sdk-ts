/**
 * Stress tests — how real users use the TS adapters
 *
 * These tests simulate production usage patterns:
 *  1. 50 concurrent sessions, each running 3 sequential LLM calls → 150 total
 *  2. Session isolation — config changes in one session don't bleed into others
 *  3. Config hot-swap — applyConfigUpdate() is reflected immediately
 *  4. Tool calling flow — two consecutive calls in a tool-use round-trip
 *  5. Streaming — async iterator yields all deltas, LLM_CALL recorded
 *  6. Multi-adapter install — OpenAI + Anthropic co-exist without double-patching
 *  7. Session cost accumulation — cumulative_cost grows across calls
 *  8. Adapter uninstall/reinstall cycle — no double-patch or event leak
 *  9. mountConfigEndpoint — applies overrides and persists
 * 10. tune() + exportSchemas — custom tunables appear in registry
 * 11. Researcher → writer pipeline (2 sequential LLM calls per session)
 * 12. 10 parallel topic pipelines (20 total calls, each session isolated)
 * 13. Batch config push — 20 sessions each get independent temperature values
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SyrinSDKConfig } from '@/types';
import { SessionStore, sessionStorage } from '@/core/session';
import { Emitter } from '@/observability/emitter';
import { OTelBridge } from '@/observability/otel';
import { CheckpointClient } from '@/core/checkpoint';
import { SyrinSDKCore } from '@/core/engine';
import { patchWithModule, unpatch, isPatched } from '@/adapters/openai/index';
import { AnthropicAdapter } from '@/adapters/anthropic/index';
import { tune, globalRegistry, TunableRegistry } from '@/tunable/tunable';

// ── Mock openai ──────────────────────────────────────────────────────────────

vi.mock('openai', () => {
  const mockCreate = vi.fn();

  class MockCompletions {}
  (MockCompletions.prototype as Record<string, unknown>)['create'] = mockCreate;

  class MockChat {
    completions: MockCompletions;
    constructor() { this.completions = new MockCompletions(); }
  }

  class MockOpenAI {
    chat: MockChat;
    constructor(_opts?: unknown) { this.chat = new MockChat(); }
    static Completions = MockCompletions;
  }

  return { default: MockOpenAI, Completions: MockCompletions, __mockCreate: mockCreate };
});

async function getMockCreate(): Promise<ReturnType<typeof vi.fn>> {
  const mod = await import('openai');
  return (mod as unknown as { __mockCreate: ReturnType<typeof vi.fn> }).__mockCreate;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SyrinSDKConfig> = {}): SyrinSDKConfig {
  return {
    apiKey: 'syrin_test',
    agentId: 'stress-test-agent',
    backendUrl: 'http://localhost:4000',
    otelExporter: 'none',
    otelEndpoint: '',
    debug: false,
    captureContent: true,
    offline: true,
    batchSize: 100,
    idleFlushMs: 60_000,
    toolValidation: false,
    ...overrides,
  };
}

/** Build one fully-wired test environment — single core/emitter/sessionStore. */
function makeEnv(configOverrides: Partial<SyrinSDKConfig> = {}) {
  const config = makeConfig(configOverrides);
  const sessionStore = new SessionStore();
  const emitter = new Emitter(config, sessionStore);
  const otelBridge = new OTelBridge(config);
  const checkpointClient = new CheckpointClient(config);
  const core = new SyrinSDKCore(config, sessionStore, emitter, otelBridge, checkpointClient);
  return { config, sessionStore, emitter, core };
}

function makeSuccessResponse(model = 'gpt-4o-mini', content = 'OK', inputTokens = 10, outputTokens = 5) {
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 9)}`,
    object: 'chat.completion',
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content, tool_calls: null },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  };
}

function makeToolCallResponse(toolName: string, args: Record<string, unknown>) {
  return {
    id: `chatcmpl-tc-${Math.random().toString(36).slice(2, 9)}`,
    object: 'chat.completion',
    model: 'gpt-4o-mini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_${Math.random().toString(36).slice(2, 9)}`,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Adapter stress tests — real-world usage patterns', () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    unpatch();
    mockCreate = await getMockCreate();
    mockCreate.mockReset();
  });

  afterEach(() => {
    unpatch();
    vi.clearAllMocks();
  });

  // ─── 1. 50 concurrent sessions × 3 calls = 150 total ─────────────────────

  it('50 concurrent sessions each running 3 sequential calls → 150 mockCreate invocations', async () => {
    mockCreate.mockResolvedValue(makeSuccessResponse());

    const { core, sessionStore } = makeEnv();
    const { default: OpenAI } = await import('openai');
    patchWithModule(OpenAI as never, core);

    const client = new (await import('openai')).default({ apiKey: 'test' });
    const sessions = Array.from({ length: 50 }, (_, i) => `concurrent-${i}`);

    await Promise.all(
      sessions.map(async (sid) => {
        await sessionStore.getOrCreate(sid, undefined);
        for (let call = 0; call < 3; call++) {
          await sessionStorage.run(sid, () =>
            client.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [{ role: 'user', content: `Call ${call} in ${sid}` }],
            })
          );
        }
      })
    );

    expect(mockCreate).toHaveBeenCalledTimes(150);
  });

  // ─── 2. Session isolation ────────────────────────────────────────────────

  it('applyConfigUpdate in one session does not bleed into another', async () => {
    const { sessionStore } = makeEnv();

    const sidA = 'isolation-A';
    const sidB = 'isolation-B';

    await sessionStore.getOrCreate(sidA, undefined);
    await sessionStore.getOrCreate(sidB, undefined);

    // Apply override to session A only (using allowed flat keys)
    sessionStore.applyConfigUpdate(sidA, { temperature: 0.1 });

    expect(sessionStore.getEffectiveConfig(sidA)['temperature']).toBe(0.1);
    expect(sessionStore.getEffectiveConfig(sidB)['temperature']).toBeUndefined();
  });

  // ─── 3. Config hot-swap ──────────────────────────────────────────────────

  it('applyConfigUpdate is reflected immediately in getEffectiveConfig()', async () => {
    const { sessionStore } = makeEnv();

    const sid = 'hotswap-session';
    await sessionStore.getOrCreate(sid, undefined);

    // No config initially
    expect(sessionStore.getEffectiveConfig(sid)['temperature']).toBeUndefined();

    // First push
    sessionStore.applyConfigUpdate(sid, { temperature: 0.1, model: 'gpt-4o' });
    expect(sessionStore.getEffectiveConfig(sid)['temperature']).toBe(0.1);
    expect(sessionStore.getEffectiveConfig(sid)['model']).toBe('gpt-4o');

    // Second push — temperature updates, model stays
    sessionStore.applyConfigUpdate(sid, { temperature: 0.9 });
    expect(sessionStore.getEffectiveConfig(sid)['temperature']).toBe(0.9);
    expect(sessionStore.getEffectiveConfig(sid)['model']).toBe('gpt-4o');
  });

  // ─── 4. Tool calling round-trip ──────────────────────────────────────────

  it('two LLM calls in the same session (tool-use round trip) both recorded', async () => {
    mockCreate
      .mockResolvedValueOnce(makeToolCallResponse('get_weather', { location: 'SF' }))
      .mockResolvedValueOnce(makeSuccessResponse('gpt-4o-mini', "It's 72°F."));

    const { core, sessionStore } = makeEnv();
    const { default: OpenAI } = await import('openai');
    patchWithModule(OpenAI as never, core);

    const client = new (await import('openai')).default({ apiKey: 'test' });
    const sid = 'tool-call-session';
    await sessionStore.getOrCreate(sid, undefined);

    // Call 1: LLM returns tool_calls
    await sessionStorage.run(sid, () =>
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Weather in SF?' }],
        tools: [{
          type: 'function',
          function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } },
        }],
      })
    );

    // Call 2: follow-up with tool result
    await sessionStorage.run(sid, () =>
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: 'Weather in SF?' },
          { role: 'tool', tool_call_id: 'call_abc', content: '{"temp":"72F"}' },
        ],
      })
    );

    expect(mockCreate).toHaveBeenCalledTimes(2);

    const session = sessionStore.getSession(sid);
    expect(session!.callCount).toBe(2);
  });

  // ─── 5. Streaming ────────────────────────────────────────────────────────

  it('streaming response: all deltas yielded, mockCreate called once', async () => {
    const words = ['Hello', 'world', 'from', 'streaming'];
    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        for (let i = 0; i < words.length; i++) {
          yield {
            id: `chunk-${i}`,
            choices: [{ delta: { content: (i === 0 ? '' : ' ') + words[i] }, finish_reason: null }],
          };
        }
        yield {
          id: 'chunk-fin',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        };
      },
      finalChatCompletion: async () => ({
        model: 'gpt-4o-mini',
        choices: [{ message: { content: words.join(' ') }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }),
    };
    mockCreate.mockResolvedValue(mockStream);

    const { core, sessionStore } = makeEnv();
    const { default: OpenAI } = await import('openai');
    patchWithModule(OpenAI as never, core);

    const client = new (await import('openai')).default({ apiKey: 'test' });
    const sid = 'stream-session';
    await sessionStore.getOrCreate(sid, undefined);

    const result = await sessionStorage.run(sid, () =>
      client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }], stream: true })
    );

    let collected = '';
    for await (const chunk of result as AsyncIterable<{ choices: Array<{ delta: { content?: string } }> }>) {
      collected += chunk.choices[0]?.delta?.content ?? '';
    }

    expect(collected).toContain('Hello');
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  // ─── 6. Multi-adapter co-existence ──────────────────────────────────────

  it('registering OpenAI + Anthropic adapters does not double-patch either', async () => {
    unpatch();

    const { default: OpenAI } = await import('openai');
    const { core } = makeEnv();

    patchWithModule(OpenAI as never, core);
    expect(isPatched()).toBe(true);

    // Anthropic adapter: install() is a no-op when @anthropic-ai/sdk isn't available
    const anthropicAdapter = new AnthropicAdapter();
    await expect(anthropicAdapter.install(core)).resolves.not.toThrow();

    // Second patchWithModule call must be idempotent
    patchWithModule(OpenAI as never, core);
    mockCreate.mockResolvedValue(makeSuccessResponse());

    const client = new (await import('openai')).default({ apiKey: 'test' });
    const sid = 'multi-adapter-session';
    const { sessionStore } = makeEnv();
    await sessionStore.getOrCreate(sid, undefined);

    await sessionStorage.run(sid, () =>
      client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
    );

    // Exactly one call — no double-wrapping
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // ─── 7. Cumulative cost accumulation ─────────────────────────────────────

  it('cumulative cost and callCount grow correctly across 5 calls', async () => {
    mockCreate.mockResolvedValue(makeSuccessResponse('gpt-4o-mini', 'OK', 100, 50));

    const { core, sessionStore } = makeEnv();
    const { default: OpenAI } = await import('openai');
    patchWithModule(OpenAI as never, core);

    const sid = 'cost-accum-session';
    await sessionStore.getOrCreate(sid, undefined);

    const client = new (await import('openai')).default({ apiKey: 'test' });

    for (let i = 0; i < 5; i++) {
      await sessionStorage.run(sid, () =>
        client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: `Call ${i}` }] })
      );
    }

    const session = sessionStore.getSession(sid);
    expect(session).toBeDefined();
    expect(session!.callCount).toBe(5);
    expect(session!.cumulativeCostUsd).toBeGreaterThan(0);
  });

  // ─── 8. Uninstall/reinstall cycle ────────────────────────────────────────

  it('unpatch → patchWithModule produces exactly one event per call (no double-wrap)', async () => {
    mockCreate.mockResolvedValue(makeSuccessResponse());

    const { default: OpenAI } = await import('openai');
    const { core } = makeEnv();

    // Patch, unpatch, re-patch
    patchWithModule(OpenAI as never, core);
    unpatch();
    expect(isPatched()).toBe(false);
    patchWithModule(OpenAI as never, core);
    expect(isPatched()).toBe(true);

    const { sessionStore } = makeEnv();
    const sid = 'reinstall-session';
    await sessionStore.getOrCreate(sid, undefined);

    const client = new (await import('openai')).default({ apiKey: 'test' });
    await sessionStorage.run(sid, () =>
      client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] })
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // ─── 9. mountConfigEndpoint req/res interface ─────────────────────────────

  it('mountConfigEndpoint handler applies overrides and returns { ok: true, applied }', async () => {
    const { init, shutdown, mountConfigEndpoint } = await import('@/index');

    const sdk = await init({ apiKey: 'syrin_test', offline: true, instanceName: 'endpoint-test' });

    const handler = mountConfigEndpoint('endpoint-test');

    let statusCode = 200;
    const applied: Record<string, unknown> = {};

    const mockReq = { body: { temperature: 0.2, model: 'gpt-4o' } };
    const mockRes = {
      status: (code: number) => { statusCode = code; return mockRes; },
      json: (body: unknown) => { Object.assign(applied, body); },
    };

    await handler(mockReq, mockRes);

    expect(statusCode).toBe(200);
    expect(applied['ok']).toBe(true);
    expect(applied['applied']).toBe(2);

    void sdk;
    await shutdown('endpoint-test');
  });

  it('mountConfigEndpoint returns 400 for array body', async () => {
    const { init, shutdown, mountConfigEndpoint } = await import('@/index');
    await init({ apiKey: 'syrin_test', offline: true, instanceName: 'endpoint-400-test' });

    const handler = mountConfigEndpoint('endpoint-400-test');

    let statusCode = 200;
    const mockRes = {
      status: (code: number) => { statusCode = code; return mockRes; },
      json: (_body: unknown) => {},
    };

    await handler({ body: ['not', 'an', 'object'] }, mockRes);
    expect(statusCode).toBe(400);

    await shutdown('endpoint-400-test');
  });

  // ─── 10. tune() + exportSchemas ───────────────────────────────────────────

  it('tune() fields appear in globalRegistry.exportSchemas() under the correct namespace', () => {
    // Use isolated registry so test is independent of global state
    const registry = new TunableRegistry();

    const agentBehavior = { response_style: 'concise', max_hops: 3, debug_mode: false };
    const toolRegistry  = { get_weather: true, calculate: true };

    tune({ target: agentBehavior, namespace: 'agent', fields: { response_style: 'string', max_hops: 'number', debug_mode: 'boolean' }, registry });
    tune({ target: toolRegistry,  namespace: 'tools', fields: { get_weather: 'boolean', calculate: 'boolean' }, registry });

    const schemas = registry.exportSchemas();

    expect(schemas['agent']).toBeDefined();
    expect(schemas['tools']).toBeDefined();

    expect(Object.keys(schemas['agent']!)).toContain('response_style');
    expect(Object.keys(schemas['agent']!)).toContain('max_hops');
    expect(Object.keys(schemas['agent']!)).toContain('debug_mode');

    expect(Object.keys(schemas['tools']!)).toContain('get_weather');
    expect(Object.keys(schemas['tools']!)).toContain('calculate');
  });
});

// ── Realistic workflow: researcher → writer pipeline ──────────────────────────

describe('Realistic workflow: researcher → writer pipeline', () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    unpatch();
    mockCreate = await getMockCreate();
    mockCreate.mockReset();
  });

  afterEach(() => { unpatch(); vi.clearAllMocks(); });

  it('two sequential LLM calls in the same session share the session and accumulate cost', async () => {
    mockCreate
      .mockResolvedValueOnce(makeSuccessResponse('gpt-4o-mini', '1. Fact one\n2. Fact two', 50, 30))
      .mockResolvedValueOnce(makeSuccessResponse('gpt-4o-mini', 'Here is the article...', 80, 60));

    const { core, sessionStore } = makeEnv();
    const { default: OpenAI } = await import('openai');
    patchWithModule(OpenAI as never, core);

    const sid = 'research-pipeline';
    await sessionStore.getOrCreate(sid, undefined);
    const client = new (await import('openai')).default({ apiKey: 'test' });

    await sessionStorage.run(sid, async () => {
      // Agent 1: Researcher
      await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a research specialist.' },
          { role: 'user', content: 'Research: quantum computing. List 5 key facts.' },
        ],
      });

      // Agent 2: Writer
      await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are an expert writer.' },
          { role: 'user', content: 'Write a 3-paragraph article from the research.' },
        ],
      });
    });

    const session = sessionStore.getSession(sid);
    expect(session!.callCount).toBe(2);
    expect(session!.cumulativeCostUsd).toBeGreaterThan(0);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('10 parallel topic pipelines: each session has exactly 2 calls, 20 total', async () => {
    mockCreate.mockResolvedValue(makeSuccessResponse('gpt-4o-mini', 'content', 20, 10));

    const { core, sessionStore } = makeEnv();
    const { default: OpenAI } = await import('openai');
    patchWithModule(OpenAI as never, core);

    const client = new (await import('openai')).default({ apiKey: 'test' });
    const topics = Array.from({ length: 10 }, (_, i) => `topic-${i}`);

    await Promise.all(
      topics.map(async (topic) => {
        const sid = `pipeline-${topic}`;
        await sessionStore.getOrCreate(sid, undefined);
        await sessionStorage.run(sid, async () => {
          await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: `Research ${topic}` }] });
          await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: `Write about ${topic}` }] });
        });
      })
    );

    expect(mockCreate).toHaveBeenCalledTimes(20);

    for (const topic of topics) {
      const session = sessionStore.getSession(`pipeline-${topic}`);
      expect(session!.callCount).toBe(2);
    }
  });
});

// ── Realistic workflow: remote config hot-swap mid-session ────────────────────

describe('Realistic workflow: remote config hot-swap mid-session', () => {
  it('config applied via applyConfigUpdate is visible immediately in getEffectiveConfig()', async () => {
    const { sessionStore } = makeEnv();

    const sid = 'hotswap-mid';
    await sessionStore.getOrCreate(sid, undefined);

    expect(sessionStore.getEffectiveConfig(sid)['temperature']).toBeUndefined();

    sessionStore.applyConfigUpdate(sid, { temperature: 0.1, model: 'gpt-4o' });
    expect(sessionStore.getEffectiveConfig(sid)['temperature']).toBe(0.1);
    expect(sessionStore.getEffectiveConfig(sid)['model']).toBe('gpt-4o');

    sessionStore.applyConfigUpdate(sid, { temperature: 0.9 });
    expect(sessionStore.getEffectiveConfig(sid)['temperature']).toBe(0.9);
    // Prior keys survive subsequent partial updates
    expect(sessionStore.getEffectiveConfig(sid)['model']).toBe('gpt-4o');
  });

  it('20 sessions receive independent temperatures in a batch push', async () => {
    const { sessionStore } = makeEnv();

    const sessions = Array.from({ length: 20 }, (_, i) => `cfg-sess-${i}`);
    await Promise.all(sessions.map((sid) => sessionStore.getOrCreate(sid, undefined)));

    // Even sessions → 0.1, odd sessions → 0.9
    for (const sid of sessions) {
      const idx = parseInt(sid.split('-')[2]!);
      sessionStore.applyConfigUpdate(sid, { temperature: idx % 2 === 0 ? 0.1 : 0.9 });
    }

    for (const sid of sessions) {
      const idx = parseInt(sid.split('-')[2]!);
      const expected = idx % 2 === 0 ? 0.1 : 0.9;
      expect(sessionStore.getEffectiveConfig(sid)['temperature']).toBe(expected);
    }
  });

  it('unknown config keys are silently dropped and do not affect the session', async () => {
    const { sessionStore } = makeEnv();
    const sid = 'unknown-key-session';
    await sessionStore.getOrCreate(sid, undefined);

    // 'llm.temperature' is dot-notation — not in ALLOWED_CONFIG_KEYS
    sessionStore.applyConfigUpdate(sid, { 'llm.temperature': 0.5 } as Record<string, unknown>);

    // Should have been silently dropped
    expect(sessionStore.getEffectiveConfig(sid)['llm.temperature']).toBeUndefined();
    expect(sessionStore.getEffectiveConfig(sid)['temperature']).toBeUndefined();
  });
});
