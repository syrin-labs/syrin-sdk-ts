/**
 * Tests: TOOL_CALL and TOOL_RESULT events (Group A)
 *
 * Emitted from SyrinSDKCore._doRecordAndEmit():
 *   - TOOL_RESULT: one per role='tool' message in the request (emitted BEFORE LLM_CALL)
 *   - TOOL_CALL:   one per tool call in the LLM response (emitted AFTER LLM_CALL)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SyrinEvent, SyrinSDKConfig } from '@/types';
import type { BeforeCallResult, NormalizedCallParams, NormalizedCallResult } from '@/adapters/types';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SyrinSDKConfig> = {}): SyrinSDKConfig {
  return {
    apiKey: 'syrin_test_key',
    backendUrl: 'http://localhost:4399',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4399',
    debug: false,
    captureContent: false,
    offline: true,
    batchSize: 50,
    idleFlushMs: 60000,
    toolValidation: false,
    ...overrides,
  };
}

function makeCollectingEmitter() {
  const events: Array<{ event: SyrinEvent; sessionId: string }> = [];
  return {
    emitter: {
      emit(event: SyrinEvent, sessionId: string) {
        events.push({ event, sessionId });
      },
      flush: vi.fn().mockResolvedValue(undefined),
    },
    events,
  };
}

function makeOtelBridge() {
  return { recordSpan: vi.fn() };
}

function makeSessionStore(sessionId = 'ses_test') {
  const session = {
    sessionId,
    agentId: 'agent-1',
    activeConfig: {},
    localConfig: {},
    cumulativeCostUsd: 0,
    callCount: 0,
    callIndex: 0,
    startedAt: new Date().toISOString(),
    toolValidationResults: {},
    pendingGovernance: [],
    injectedMessages: [],
    lastConversationHash: undefined as string | undefined,
  };
  return {
    getSession: vi.fn().mockReturnValue(session),
    recordCall: vi.fn(),
    incrementCallIndex: vi.fn(),
    getEffectiveConfig: vi.fn().mockReturnValue({}),
    popGovernanceActions: vi.fn().mockReturnValue([]),
    popInjectedMessages: vi.fn().mockReturnValue([]),
    getOrCreate: vi.fn().mockResolvedValue(session),
    appendGovernanceAction: vi.fn(),
    appendInjectedMessage: vi.fn(),
    storeToolValidationResults: vi.fn(),
    applyConfigUpdate: vi.fn(),
  };
}

function makeCheckpointClient() {
  return { save: vi.fn(), getById: vi.fn() };
}

/** Build a BeforeCallResult with sensible defaults */
function makeCtx(overrides: Partial<BeforeCallResult> = {}): BeforeCallResult {
  return {
    sessionId: 'ses_test',
    agentId: 'agent-1',
    initialCumulativeCostUsd: 0,
    configApplied: false,
    governanceApplied: false,
    modifiedRaw: { model: 'gpt-4o', temperature: 0.7 },
    modifiedMessages: [],
    tempUnsupported: false,
    ...overrides,
  };
}

function makeParams(overrides: Partial<NormalizedCallParams> = {}): NormalizedCallParams {
  return {
    model: 'gpt-4o',
    messages: [],
    stream: false,
    raw: { model: 'gpt-4o' },
    ...overrides,
  };
}

function makeResult(overrides: Partial<NormalizedCallResult> = {}): NormalizedCallResult {
  return {
    model: 'gpt-4o',
    inputTokens: 100,
    outputTokens: 50,
    finishReason: 'stop',
    durationMs: 200,
    stream: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Build a SyrinSDKCore with injectable stubs
// ---------------------------------------------------------------------------

async function buildCore(
  collectingEmitter: ReturnType<typeof makeCollectingEmitter>,
  sessionStore: ReturnType<typeof makeSessionStore>,
  config?: SyrinSDKConfig,
) {
  const { SyrinSDKCore } = await import('../src/core/engine.js');
  const otelBridge = makeOtelBridge();
  const checkpointClient = makeCheckpointClient();

  const core = new SyrinSDKCore(
    config ?? makeConfig(),
    sessionStore as never,
    collectingEmitter.emitter as never,
    otelBridge as never,
    checkpointClient as never,
  );
  return { core, otelBridge };
}

// ---------------------------------------------------------------------------
// TOOL_CALL events
// ---------------------------------------------------------------------------

describe('TOOL_CALL events', () => {
  let collectingEmitter: ReturnType<typeof makeCollectingEmitter>;
  let sessionStore: ReturnType<typeof makeSessionStore>;

  beforeEach(() => {
    collectingEmitter = makeCollectingEmitter();
    sessionStore = makeSessionStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a TOOL_CALL event for each tool call in the LLM response', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const result = makeResult({
      toolCalls: [
        { id: 'tc_1', name: 'get_weather', arguments: '{"city":"London"}' },
        { id: 'tc_2', name: 'search_web',  arguments: '{"query":"news"}' },
      ],
    });

    core.afterCall(makeCtx(), makeParams(), result);

    const toolCallEvents = collectingEmitter.events.filter((e) => e.event.event_type === 'TOOL_CALL');
    expect(toolCallEvents).toHaveLength(2);
  });

  it('TOOL_CALL event has correct tool_name, tool_call_id, tool_arguments', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const result = makeResult({
      toolCalls: [
        { id: 'tc_abc', name: 'calculate', arguments: '{"expr":"2+2"}' },
      ],
    });

    core.afterCall(makeCtx(), makeParams(), result);

    const ev = collectingEmitter.events.find((e) => e.event.event_type === 'TOOL_CALL')?.event;
    expect(ev).toBeDefined();
    expect(ev!.tool_name).toBe('calculate');
    expect(ev!.tool_call_id).toBe('tc_abc');
    expect(ev!.tool_arguments).toBe('{"expr":"2+2"}');
  });

  it('TOOL_CALL event carries session_id from context', async () => {
    const sessionId = 'ses_custom_123';
    const store = makeSessionStore(sessionId);
    const { core } = await buildCore(collectingEmitter, store);

    const result = makeResult({
      toolCalls: [{ id: 'tc_1', name: 'lookup', arguments: '{}' }],
    });

    core.afterCall(makeCtx({ sessionId }), makeParams(), result);

    const ev = collectingEmitter.events.find((e) => e.event.event_type === 'TOOL_CALL')?.event;
    expect(ev!.session_id).toBe(sessionId);
  });

  it('TOOL_CALL event carries agent_id from context', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const result = makeResult({
      toolCalls: [{ id: 'tc_1', name: 'tool_a', arguments: '{}' }],
    });

    core.afterCall(makeCtx({ agentId: 'my-agent' }), makeParams(), result);

    const ev = collectingEmitter.events.find((e) => e.event.event_type === 'TOOL_CALL')?.event;
    expect(ev!.agent_id).toBe('my-agent');
  });

  it('does not emit TOOL_CALL events when response has no tool calls', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    core.afterCall(makeCtx(), makeParams(), makeResult());

    const toolCallEvents = collectingEmitter.events.filter((e) => e.event.event_type === 'TOOL_CALL');
    expect(toolCallEvents).toHaveLength(0);
  });

  it('does not emit TOOL_CALL events when toolCalls is an empty array', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    core.afterCall(makeCtx(), makeParams(), makeResult({ toolCalls: [] }));

    const toolCallEvents = collectingEmitter.events.filter((e) => e.event.event_type === 'TOOL_CALL');
    expect(toolCallEvents).toHaveLength(0);
  });

  it('multiple tool calls emit multiple TOOL_CALL events with correct ordering', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const calls = [
      { id: 'tc_1', name: 'first_tool',  arguments: '{"a":1}' },
      { id: 'tc_2', name: 'second_tool', arguments: '{"b":2}' },
      { id: 'tc_3', name: 'third_tool',  arguments: '{"c":3}' },
    ];

    core.afterCall(makeCtx(), makeParams(), makeResult({ toolCalls: calls }));

    const toolCallEvents = collectingEmitter.events
      .filter((e) => e.event.event_type === 'TOOL_CALL')
      .map((e) => e.event.tool_name);

    expect(toolCallEvents).toEqual(['first_tool', 'second_tool', 'third_tool']);
  });

  it('TOOL_CALL event emitted AFTER LLM_CALL in the event stream', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    core.afterCall(
      makeCtx(),
      makeParams(),
      makeResult({ toolCalls: [{ id: 'tc_x', name: 'my_tool', arguments: '{}' }] }),
    );

    const types = collectingEmitter.events.map((e) => e.event.event_type);
    const llmIdx = types.indexOf('LLM_CALL');
    const tcIdx = types.indexOf('TOOL_CALL');
    expect(llmIdx).toBeGreaterThanOrEqual(0);
    expect(tcIdx).toBeGreaterThan(llmIdx);
  });

  it('TOOL_CALL event emission failure is non-fatal (fail-open)', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);
    // Poison the emit so it throws on TOOL_CALL
    vi.spyOn(collectingEmitter.emitter, 'emit').mockImplementation((event: SyrinEvent) => {
      if (event.event_type === 'TOOL_CALL') throw new Error('emit failure');
    });

    expect(() =>
      core.afterCall(
        makeCtx(),
        makeParams(),
        makeResult({ toolCalls: [{ id: 'tc_1', name: 'tool', arguments: '{}' }] }),
      )
    ).not.toThrow();
  });

  it('tool call with missing function object → empty strings, does not crash', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    // Force a malformed tool call (no name / no arguments)
    const result = makeResult({
      toolCalls: [{ id: 'tc_bad', name: '', arguments: '' }],
    });

    expect(() => core.afterCall(makeCtx(), makeParams(), result)).not.toThrow();

    const ev = collectingEmitter.events.find((e) => e.event.event_type === 'TOOL_CALL')?.event;
    expect(ev).toBeDefined();
    expect(ev!.tool_name).toBe('');
    expect(ev!.tool_arguments).toBe('');
  });

  it('tool call with missing id → empty string for tool_call_id', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const result = makeResult({
      toolCalls: [{ id: '', name: 'no_id_tool', arguments: '{}' }],
    });

    core.afterCall(makeCtx(), makeParams(), result);

    const ev = collectingEmitter.events.find((e) => e.event.event_type === 'TOOL_CALL')?.event;
    expect(ev!.tool_call_id).toBe('');
  });
});

// ---------------------------------------------------------------------------
// TOOL_RESULT events
// ---------------------------------------------------------------------------

describe('TOOL_RESULT events', () => {
  let collectingEmitter: ReturnType<typeof makeCollectingEmitter>;
  let sessionStore: ReturnType<typeof makeSessionStore>;

  beforeEach(() => {
    collectingEmitter = makeCollectingEmitter();
    sessionStore = makeSessionStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a TOOL_RESULT event for each role=tool message in the request', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const ctx = makeCtx({
      modifiedMessages: [
        { role: 'user', content: 'Hello' },
        { role: 'tool', content: 'result-1', tool_call_id: 'tc_1', name: 'weather' } as never,
        { role: 'tool', content: 'result-2', tool_call_id: 'tc_2', name: 'search'  } as never,
      ],
    });

    core.afterCall(ctx, makeParams(), makeResult());

    const toolResultEvents = collectingEmitter.events.filter(
      (e) => e.event.event_type === 'TOOL_RESULT',
    );
    expect(toolResultEvents).toHaveLength(2);
  });

  it('TOOL_RESULT event has correct tool_call_id, tool_name, tool_result', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const ctx = makeCtx({
      modifiedMessages: [
        {
          role: 'tool',
          content: '{"temp":20}',
          tool_call_id: 'tc_weather',
          name: 'get_weather',
        } as never,
      ],
    });

    core.afterCall(ctx, makeParams(), makeResult());

    const ev = collectingEmitter.events.find((e) => e.event.event_type === 'TOOL_RESULT')?.event;
    expect(ev).toBeDefined();
    expect(ev!.tool_call_id).toBe('tc_weather');
    expect(ev!.tool_name).toBe('get_weather');
    expect(ev!.tool_result).toBe('{"temp":20}');
  });

  it('does not emit TOOL_RESULT events when no role=tool messages in request', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const ctx = makeCtx({
      modifiedMessages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user',   content: 'What is the weather?' },
      ],
    });

    core.afterCall(ctx, makeParams(), makeResult());

    const toolResultEvents = collectingEmitter.events.filter(
      (e) => e.event.event_type === 'TOOL_RESULT',
    );
    expect(toolResultEvents).toHaveLength(0);
  });

  it('TOOL_RESULT events emitted BEFORE LLM_CALL in the event stream', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const ctx = makeCtx({
      modifiedMessages: [
        { role: 'tool', content: 'ok', tool_call_id: 'tc_1', name: 'tool_a' } as never,
      ],
    });

    core.afterCall(ctx, makeParams(), makeResult());

    const types = collectingEmitter.events.map((e) => e.event.event_type);
    const llmIdx = types.indexOf('LLM_CALL');
    const trIdx  = types.indexOf('TOOL_RESULT');
    expect(llmIdx).toBeGreaterThanOrEqual(0);
    expect(trIdx).toBeGreaterThanOrEqual(0);
    expect(trIdx).toBeLessThan(llmIdx);
  });

  it('tool result with non-string content → coerced to string', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const ctx = makeCtx({
      modifiedMessages: [
        {
          role: 'tool',
          content: 42,
          tool_call_id: 'tc_1',
          name: 'numeric_tool',
        } as never,
      ],
    });

    core.afterCall(ctx, makeParams(), makeResult());

    const ev = collectingEmitter.events.find((e) => e.event.event_type === 'TOOL_RESULT')?.event;
    expect(ev!.tool_result).toBe('42');
  });

  it('tool result with missing name field → empty string', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const ctx = makeCtx({
      modifiedMessages: [
        { role: 'tool', content: 'data', tool_call_id: 'tc_1' } as never,
      ],
    });

    core.afterCall(ctx, makeParams(), makeResult());

    const ev = collectingEmitter.events.find((e) => e.event.event_type === 'TOOL_RESULT')?.event;
    expect(ev!.tool_name).toBe('');
  });

  it('TOOL_RESULT event emission failure is non-fatal (fail-open)', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    vi.spyOn(collectingEmitter.emitter, 'emit').mockImplementation((event: SyrinEvent) => {
      if (event.event_type === 'TOOL_RESULT') throw new Error('emit failure');
    });

    const ctx = makeCtx({
      modifiedMessages: [
        { role: 'tool', content: 'ok', tool_call_id: 'tc_1', name: 'tool_a' } as never,
      ],
    });

    expect(() => core.afterCall(ctx, makeParams(), makeResult())).not.toThrow();
  });

  it('TOOL_RESULT and TOOL_CALL ordering: results first, then LLM_CALL, then tool calls', async () => {
    const { core } = await buildCore(collectingEmitter, sessionStore);

    const ctx = makeCtx({
      modifiedMessages: [
        { role: 'tool', content: 'previous result', tool_call_id: 'tc_prev', name: 'prev_tool' } as never,
      ],
    });

    core.afterCall(
      ctx,
      makeParams(),
      makeResult({ toolCalls: [{ id: 'tc_new', name: 'new_tool', arguments: '{}' }] }),
    );

    const types = collectingEmitter.events.map((e) => e.event.event_type);
    const trIdx  = types.indexOf('TOOL_RESULT');
    const llmIdx = types.indexOf('LLM_CALL');
    const tcIdx  = types.indexOf('TOOL_CALL');

    expect(trIdx).toBeGreaterThanOrEqual(0);
    expect(llmIdx).toBeGreaterThan(trIdx);
    expect(tcIdx).toBeGreaterThan(llmIdx);
  });
});
