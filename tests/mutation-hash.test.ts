/**
 * Tests: Feature 2 — mutation_hash in LLM_CALL events
 * Tests: Feature 3 — toolCallHash in LLM_CALL events
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyrinSDKCore } from '@/core/engine';
import { SessionStore } from '@/core/session';
import type { SyrinSDKConfig, SyrinEvent } from '@/types';
import type { NormalizedCallParams, NormalizedCallResult } from '@/adapters/types';

vi.mock('openai', () => {
  class MockCompletions {}
  (MockCompletions.prototype as Record<string, unknown>)['create'] = vi.fn();
  class MockChat { completions = new MockCompletions(); }
  class MockOpenAI { chat = new MockChat(); constructor(_?: unknown) {} }
  return { default: MockOpenAI };
});

function makeConfig(overrides: Partial<SyrinSDKConfig> = {}): SyrinSDKConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4399',
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

function makeParams(messages: Array<{ role: string; content: string }> = []): NormalizedCallParams {
  return {
    model: 'gpt-4o',
    messages,
    stream: false,
    raw: { model: 'gpt-4o', messages },
  };
}

function makeResult(toolCalls?: Array<{ function?: { name?: string; arguments?: string } }>): NormalizedCallResult {
  return {
    model: 'gpt-4o',
    inputTokens: 10,
    outputTokens: 5,
    finishReason: 'stop',
    durationMs: 100,
    stream: false,
    responseText: 'Hello!',
    toolCalls: toolCalls?.map((tc, i) => ({
      id: `tc_${i}`,
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '{}',
    })),
  };
}

describe('Feature 2: mutation_hash in LLM_CALL events', () => {
  let emittedEvents: SyrinEvent[];
  let core: SyrinSDKCore;
  let sessionStore: SessionStore;

  beforeEach(() => {
    emittedEvents = [];
    const config = makeConfig();
    sessionStore = new SessionStore();

    const emitter = {
      emit: vi.fn((event: SyrinEvent) => { emittedEvents.push(event); }),
      flush: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const otelBridge = {
      recordSpan: vi.fn(),
      setup: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const checkpointClient = {
      save: vi.fn(),
      getById: vi.fn().mockResolvedValue(null),
      listForSession: vi.fn().mockReturnValue([]),
    };

    core = new SyrinSDKCore(
      config,
      sessionStore,
      emitter as never,
      otelBridge as never,
      checkpointClient as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mutation_hash is present in LLM_CALL event', async () => {
    const params = makeParams([{ role: 'user', content: 'Hello' }]);
    const ctx = await core.beforeCall(params);
    core.afterCall(ctx, params, makeResult());

    const event = emittedEvents.find((e) => e.event_type === 'LLM_CALL');
    expect(event).toBeDefined();
    expect(event!.mutation_hash).toBeDefined();
    expect(typeof event!.mutation_hash).toBe('string');
  });

  it('first call uses empty string as prevHash (deterministic)', async () => {
    const msgs = [{ role: 'user', content: 'First message' }];
    const params = makeParams(msgs);
    const ctx = await core.beforeCall(params);
    core.afterCall(ctx, params, makeResult());

    const event1 = emittedEvents.find((e) => e.event_type === 'LLM_CALL');
    expect(event1!.mutation_hash).toBeDefined();

    // Same first message should yield same mutation_hash (deterministic)
    emittedEvents.length = 0;
    const sessionStore2 = new SessionStore();
    const emitter2 = {
      emit: vi.fn((event: SyrinEvent) => { emittedEvents.push(event); }),
      flush: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const core2 = new SyrinSDKCore(
      makeConfig(),
      sessionStore2,
      emitter2 as never,
      { recordSpan: vi.fn(), setup: vi.fn(), shutdown: vi.fn() } as never,
      { save: vi.fn(), getById: vi.fn().mockResolvedValue(null), listForSession: vi.fn().mockReturnValue([]) } as never,
    );
    const ctx2 = await core2.beforeCall(params);
    core2.afterCall(ctx2, params, makeResult());
    const event2 = emittedEvents.find((e) => e.event_type === 'LLM_CALL');
    expect(event2!.mutation_hash).toBe(event1!.mutation_hash);
  });

  it('mutation_hash changes when messages change between calls', async () => {
    const params1 = makeParams([{ role: 'user', content: 'Hello' }]);
    const ctx1 = await core.beforeCall(params1);
    core.afterCall(ctx1, params1, makeResult());

    const params2 = makeParams([{ role: 'user', content: 'Different message' }]);
    const ctx2 = await core.beforeCall(params2);
    core.afterCall(ctx2, params2, makeResult());

    const events = emittedEvents.filter((e) => e.event_type === 'LLM_CALL');
    expect(events).toHaveLength(2);
    expect(events[0]!.mutation_hash).not.toBe(events[1]!.mutation_hash);
  });

  it('mutation_hash is stable for identical consecutive calls', async () => {
    const msgs = [{ role: 'user', content: 'Stable message' }];

    const params1 = makeParams(msgs);
    const ctx1 = await core.beforeCall(params1);
    core.afterCall(ctx1, params1, makeResult());

    const params2 = makeParams(msgs);
    const ctx2 = await core.beforeCall(params2);
    core.afterCall(ctx2, params2, makeResult());

    const events = emittedEvents.filter((e) => e.event_type === 'LLM_CALL');
    expect(events).toHaveLength(2);
    // Consecutive identical messages → mutation_hash should be the same
    // because conversationHash is the same, and the mutation is same → stable
    expect(events[0]!.mutation_hash).toBe(events[1]!.mutation_hash);
  });

  it('second call uses first call conversation_hash as prevHash', async () => {
    const params1 = makeParams([{ role: 'user', content: 'Hello' }]);
    const ctx1 = await core.beforeCall(params1);
    core.afterCall(ctx1, params1, makeResult());

    const params2 = makeParams([{ role: 'user', content: 'World' }]);
    const ctx2 = await core.beforeCall(params2);
    core.afterCall(ctx2, params2, makeResult());

    const events = emittedEvents.filter((e) => e.event_type === 'LLM_CALL');
    expect(events).toHaveLength(2);

    // mutation_hash should exist for both events
    expect(events[0]!.mutation_hash).toBeDefined();
    expect(events[1]!.mutation_hash).toBeDefined();

    // Second mutation should differ from first (different messages → different hashes)
    expect(events[0]!.mutation_hash).not.toBe(events[1]!.mutation_hash);
  });
});

// ---------------------------------------------------------------------------
// Feature 3: toolCallHash
// ---------------------------------------------------------------------------

describe('Feature 3: tool_call_hash in LLM_CALL events', () => {
  let emittedEvents: SyrinEvent[];
  let core: SyrinSDKCore;

  beforeEach(() => {
    emittedEvents = [];
    const config = makeConfig();
    const sessionStore = new SessionStore();

    const emitter = {
      emit: vi.fn((event: SyrinEvent) => { emittedEvents.push(event); }),
      flush: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const otelBridge = {
      recordSpan: vi.fn(),
      setup: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const checkpointClient = {
      save: vi.fn(),
      getById: vi.fn().mockResolvedValue(null),
      listForSession: vi.fn().mockReturnValue([]),
    };

    core = new SyrinSDKCore(
      config,
      sessionStore,
      emitter as never,
      otelBridge as never,
      checkpointClient as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tool_call_hash is null when no tool calls', async () => {
    const params = makeParams([{ role: 'user', content: 'Hi' }]);
    const ctx = await core.beforeCall(params);
    core.afterCall(ctx, params, makeResult()); // no toolCalls

    const event = emittedEvents.find((e) => e.event_type === 'LLM_CALL');
    expect(event).toBeDefined();
    expect(event!.tool_call_hash).toBeNull();
  });

  it('tool_call_hash is present when tool calls exist', async () => {
    const params = makeParams([{ role: 'user', content: 'Hi' }]);
    const ctx = await core.beforeCall(params);
    core.afterCall(ctx, params, makeResult([
      { function: { name: 'search', arguments: '{"q":"hello"}' } },
    ]));

    const event = emittedEvents.find((e) => e.event_type === 'LLM_CALL');
    expect(event!.tool_call_hash).toBeDefined();
    expect(typeof event!.tool_call_hash).toBe('string');
  });

  it('tool_call_hash is order-independent (sorted by name)', async () => {
    const params = makeParams([{ role: 'user', content: 'Hi' }]);

    // Order 1: search, then calculate
    const ctx1 = await core.beforeCall(params);
    core.afterCall(ctx1, params, makeResult([
      { function: { name: 'search', arguments: '{"q":"hi"}' } },
      { function: { name: 'calculate', arguments: '{"x":1}' } },
    ]));

    // Order 2: calculate, then search
    const ctx2 = await core.beforeCall(params);
    core.afterCall(ctx2, params, makeResult([
      { function: { name: 'calculate', arguments: '{"x":1}' } },
      { function: { name: 'search', arguments: '{"q":"hi"}' } },
    ]));

    const events = emittedEvents.filter((e) => e.event_type === 'LLM_CALL');
    expect(events[0]!.tool_call_hash).toBe(events[1]!.tool_call_hash);
  });

  it('tool_call_hash changes when arguments change', async () => {
    const params = makeParams([{ role: 'user', content: 'Hi' }]);

    const ctx1 = await core.beforeCall(params);
    core.afterCall(ctx1, params, makeResult([
      { function: { name: 'search', arguments: '{"q":"hello"}' } },
    ]));

    const ctx2 = await core.beforeCall(params);
    core.afterCall(ctx2, params, makeResult([
      { function: { name: 'search', arguments: '{"q":"world"}' } },
    ]));

    const events = emittedEvents.filter((e) => e.event_type === 'LLM_CALL');
    expect(events[0]!.tool_call_hash).not.toBe(events[1]!.tool_call_hash);
  });

  it('tool_call_hash stable for identical tool calls', async () => {
    const params = makeParams([{ role: 'user', content: 'Hi' }]);
    const toolCalls = [{ function: { name: 'search', arguments: '{"q":"hello"}' } }];

    const ctx1 = await core.beforeCall(params);
    core.afterCall(ctx1, params, makeResult(toolCalls));

    const ctx2 = await core.beforeCall(params);
    core.afterCall(ctx2, params, makeResult(toolCalls));

    const events = emittedEvents.filter((e) => e.event_type === 'LLM_CALL');
    expect(events[0]!.tool_call_hash).toBe(events[1]!.tool_call_hash);
  });
});
