/**
 * Tests: src/agent/handle.ts — AgentHandle
 * Merged with handle-chat.test.ts (AgentHandle.chat() / _runChat())
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentHandle } from '@/agent/handle';
import { agentStorage } from '@/agent/context';
import type { SyrinSDKInstance } from '@/index';

afterEach(() => vi.clearAllMocks());

// Build a minimal mock SyrinSDKInstance
function makeSdk(activeConfigOverrides: Record<string, unknown> = {}): SyrinSDKInstance {
  const core: Record<string, unknown> = {};
  const sdk = {
    _core: core,
    _sessionId: 'ses_default',
    activeConfig: vi.fn().mockReturnValue(activeConfigOverrides),
    emit: vi.fn(),
    agent: vi.fn(),
    workflow: vi.fn(),
    swarm: vi.fn(),
    configure: vi.fn(),
    configSnapshot: vi.fn(),
    activeSession: vi.fn(),
    shutdown: vi.fn(),
    createCheckpoint: vi.fn(),
    applyRemoteConfig: vi.fn(),
    session: vi.fn(),
  } as unknown as SyrinSDKInstance;
  return sdk;
}

describe('AgentHandle.id', () => {
  it('returns the agentId', () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('my-agent', sdk);
    expect(handle.id).toBe('my-agent');
  });
});

describe('AgentHandle.field()', () => {
  it('registers field declarations and returns self for chaining', () => {
    const sdk = makeSdk();
    const core = (sdk as unknown as { _core: Record<string, unknown> })._core;
    const handle = new AgentHandle('agent-a', sdk);

    const returned = handle.field('llm.temperature', 0.7, { ge: 0.0, le: 2.0 });
    expect(returned).toBe(handle); // chaining

    const agentFields = core['_agentFields'] as Record<string, unknown[]>;
    expect(agentFields).toBeDefined();
    expect(agentFields['agent-a']).toHaveLength(1);
    expect(agentFields['agent-a'][0]).toMatchObject({
      key: 'llm.temperature',
      default: 0.7,
      ge: 0.0,
      le: 2.0,
    });
  });

  it('supports chaining multiple fields', () => {
    const sdk = makeSdk();
    const core = (sdk as unknown as { _core: Record<string, unknown> })._core;
    const handle = new AgentHandle('agent-b', sdk);

    handle
      .field('llm.model', 'gpt-4o')
      .field('llm.temperature', 0.3)
      .field('prompt.system_prompt', 'Be helpful', { multiline: true });

    const agentFields = core['_agentFields'] as Record<string, unknown[]>;
    expect(agentFields['agent-b']).toHaveLength(3);
  });

  it('initializes _agentFields if not present', () => {
    const sdk = makeSdk();
    const core = (sdk as unknown as { _core: Record<string, unknown> })._core;
    expect(core['_agentFields']).toBeUndefined();

    const handle = new AgentHandle('agent-c', sdk);
    handle.field('llm.model', 'gpt-4o');

    expect(core['_agentFields']).toBeDefined();
  });

  it('handles missing core gracefully', () => {
    const sdk = makeSdk();
    (sdk as unknown as { _core: null })._core = null;
    const handle = new AgentHandle('agent-d', sdk);
    expect(() => handle.field('llm.temperature', 0.5)).not.toThrow();
  });

  it('stores enum and multiline options', () => {
    const sdk = makeSdk();
    const core = (sdk as unknown as { _core: Record<string, unknown> })._core;
    const handle = new AgentHandle('agent-e', sdk);

    handle.field('llm.model', 'gpt-4o', {
      enum: ['gpt-4o', 'gpt-4o-mini'],
      multiline: false,
      description: 'Model to use',
    });

    const fields = (core['_agentFields'] as Record<string, unknown[]>)['agent-e'];
    expect(fields[0]).toMatchObject({
      enum: ['gpt-4o', 'gpt-4o-mini'],
      multiline: false,
    });
  });
});

describe('AgentHandle.outputs()', () => {
  it('returns self for chaining', () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-f', sdk);
    const ret = handle.outputs({ result: 'string' });
    expect(ret).toBe(handle);
  });
});

describe('AgentHandle.cfg()', () => {
  it('returns defaultValue when no config', () => {
    const sdk = makeSdk({});
    const handle = new AgentHandle('agent-1', sdk);
    expect(handle.cfg('llm.temperature', 0.7)).toBe(0.7);
  });

  it('returns agent-scoped key first', () => {
    const sdk = makeSdk({ 'agents.agent-1.llm.temperature': 0.3, 'temperature': 0.9 });
    const handle = new AgentHandle('agent-1', sdk);
    expect(handle.cfg('llm.temperature', 0.7)).toBe(0.3);
  });

  it('falls back to global key', () => {
    const sdk = makeSdk({ 'llm.temperature': 0.5 });
    const handle = new AgentHandle('agent-2', sdk);
    expect(handle.cfg('llm.temperature', 0.7)).toBe(0.5);
  });

  it('falls back to last segment key', () => {
    const sdk = makeSdk({ 'temperature': 0.4 });
    const handle = new AgentHandle('agent-3', sdk);
    expect(handle.cfg('llm.temperature', 0.7)).toBe(0.4);
  });

  it('returns defaultValue when last segment is same as key', () => {
    const sdk = makeSdk({});
    const handle = new AgentHandle('agent-4', sdk);
    expect(handle.cfg('temperature', 0.7)).toBe(0.7);
  });

  it('calls activeConfig with the correct sessionId', () => {
    const sdk = makeSdk({});
    const handle = new AgentHandle('agent-5', sdk);
    handle.cfg('llm.model', 'gpt-4o');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const activeConfigMock = sdk.activeConfig as ReturnType<typeof vi.fn>;
    expect(activeConfigMock).toHaveBeenCalledWith('ses_default');
  });
});

describe('AgentHandle.run()', () => {
  it('executes the provided function', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-run', sdk);
    const fn = vi.fn().mockResolvedValue('done');

    const result = await handle.run(fn);

    expect(fn).toHaveBeenCalledOnce();
    expect(result).toBe('done');
  });

  it('emits AGENT_RUN_STARTED and AGENT_RUN_ENDED', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-run-2', sdk);

    await handle.run(() => Promise.resolve('value'));

    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const eventTypes = emitCalls.map((c) => c[0] as string);
    expect(eventTypes).toContain('AGENT_RUN_STARTED');
    expect(eventTypes).toContain('AGENT_RUN_ENDED');
  });

  it('emits AGENT_RUN_STARTED with correct agentId and run_id', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-run-3', sdk);

    await handle.run(() => Promise.resolve('ok'));

    const startCall = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'AGENT_RUN_STARTED');
    expect(startCall![1]).toMatchObject({ agent_id: 'agent-run-3' });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(startCall![1].run_id).toMatch(/^run_/);
  });

  it('emits AGENT_RUN_ENDED with duration_ms', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-run-4', sdk);

    await handle.run(() => Promise.resolve('ok'));

    const endCall = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'AGENT_RUN_ENDED');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(endCall![1].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('propagates errors from the function', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-run-5', sdk);

    await expect(handle.run(() => { throw new Error('fn failed'); })).rejects.toThrow('fn failed');
  });

  it('still emits AGENT_RUN_ENDED when function throws', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-run-6', sdk);

    try {
      await handle.run(() => { throw new Error('oops'); });
    } catch { /* expected */ }

    const eventTypes = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(eventTypes).toContain('AGENT_RUN_ENDED');
  });

  it('emits HANDOFF when switching from a different agent', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('new-agent', sdk);

    await agentStorage.run({ agentId: 'old-agent', runId: 'run_old' }, async () => {
      await handle.run(() => Promise.resolve('ok'));
    });

    const handoffCall = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'HANDOFF');
    expect(handoffCall).toBeDefined();
    expect(handoffCall![1]).toEqual({
      from_agent: 'old-agent',
      to_agent: 'new-agent',
    });
  });

  it('does NOT emit HANDOFF when same agent continues', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('same-agent', sdk);

    await agentStorage.run({ agentId: 'same-agent', runId: 'run_same' }, async () => {
      await handle.run(() => Promise.resolve('ok'));
    });

    const handoffCall = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'HANDOFF');
    expect(handoffCall).toBeUndefined();
  });

  it('inherits workflowId and swarmId from outer context', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('nested-agent', sdk);
    let capturedCtx: { workflowId?: string; swarmId?: string } | undefined;

    await agentStorage.run({ agentId: 'outer', runId: 'run_outer', workflowId: 'wf_1', swarmId: 'swarm_1' }, async () => {
      await handle.run(() => {
        capturedCtx = agentStorage.getStore();
        return Promise.resolve('ok');
      });
    });

    expect(capturedCtx?.workflowId).toBe('wf_1');
    expect(capturedCtx?.swarmId).toBe('swarm_1');
  });

  it('sets parentRunId from outer context', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('child-agent', sdk);
    let capturedParentRunId: string | undefined;

    await agentStorage.run({ agentId: 'parent', runId: 'run_parent' }, async () => {
      await handle.run(() => {
        capturedParentRunId = agentStorage.getStore()?.parentRunId;
        return Promise.resolve('ok');
      });
    });

    expect(capturedParentRunId).toBe('run_parent');
  });
});

// ---------------------------------------------------------------------------
// Merged from handle-chat.test.ts — AgentHandle.chat() / _runChat()
// ---------------------------------------------------------------------------

function makeSimpleResponse(content: string) {
  return {
    choices: [{ message: { content, tool_calls: null } }],
  };
}

function makeToolCallResponse(toolName: string, args: string, toolId = 'call_1') {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: toolId, function: { name: toolName, arguments: args } }],
      },
    }],
  };
}

describe('AgentHandle.chat()', () => {
  it('returns final content when no tool calls', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-chat', sdk);
    const mockCreate = vi.fn().mockResolvedValue(makeSimpleResponse('Hello there!'));
    const client = { chat: { completions: { create: mockCreate } } };

    const result = await handle.chat({
      client,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result).toBe('Hello there!');
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it('returns empty string when content is null', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-chat', sdk);
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null, tool_calls: null } }],
    });
    const client = { chat: { completions: { create: mockCreate } } };

    const result = await handle.chat({
      client,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result).toBe('');
  });

  it('performs one round of tool calls then returns final answer', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-tools', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('get_weather', '{"city":"NYC"}'))
      .mockResolvedValueOnce(makeSimpleResponse('It is sunny in NYC'));

    const client = { chat: { completions: { create: mockCreate } } };

    const onTool = vi.fn().mockReturnValue('sunny, 72°F');

    const result = await handle.chat({
      client,
      messages: [{ role: 'user', content: 'Weather in NYC?' }],
      onTool,
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });

    expect(result).toBe('It is sunny in NYC');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(onTool).toHaveBeenCalledWith('get_weather', { city: 'NYC' });
  });

  it('emits TOOL_RESULT event after executing a tool', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-tool-emit', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('search', '{"q":"test"}', 'call_x'))
      .mockResolvedValueOnce(makeSimpleResponse('Done'));

    const client = { chat: { completions: { create: mockCreate } } };
    const onTool = vi.fn().mockReturnValue('search result');

    await handle.chat({ client, messages: [{ role: 'user', content: 'search' }], onTool });

    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const toolResultEmit = emitCalls.find((c) => c[0] === 'TOOL_RESULT');
    expect(toolResultEmit).toBeDefined();
    expect(toolResultEmit![1]).toMatchObject({
      tool_call_id: 'call_x',
      tool_name: 'search',
      result: 'search result',
    });
  });

  it('emits HANDOFF when switching from a different agent', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('new-agent', sdk);
    const mockCreate = vi.fn().mockResolvedValue(makeSimpleResponse('done'));
    const client = { chat: { completions: { create: mockCreate } } };

    await agentStorage.run({ agentId: 'old-agent', runId: 'run_old' }, async () => {
      await handle.chat({ client, messages: [{ role: 'user', content: 'hi' }] });
    });

    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const handoff = emitCalls.find((c) => c[0] === 'HANDOFF');
    expect(handoff).toBeDefined();
    expect(handoff![1]).toEqual({ from_agent: 'old-agent', to_agent: 'new-agent' });
  });

  it('does NOT emit HANDOFF when same agent continues', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('same-agent', sdk);
    const mockCreate = vi.fn().mockResolvedValue(makeSimpleResponse('ok'));
    const client = { chat: { completions: { create: mockCreate } } };

    await agentStorage.run({ agentId: 'same-agent', runId: 'run_same' }, async () => {
      await handle.chat({ client, messages: [{ role: 'user', content: 'hi' }] });
    });

    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const handoff = emitCalls.find((c) => c[0] === 'HANDOFF');
    expect(handoff).toBeUndefined();
  });

  it('exhausts maxRounds and calls final chat without tools', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-maxrounds', sdk);

    const toolResponse = makeToolCallResponse('loop_tool', '{}');
    const finalResponse = makeSimpleResponse('final answer');

    const mockCreate = vi.fn()
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(toolResponse)
      .mockResolvedValueOnce(finalResponse);

    const client = { chat: { completions: { create: mockCreate } } };
    const onTool = vi.fn().mockReturnValue('result');

    const result = await handle.chat({
      client,
      messages: [{ role: 'user', content: 'loop' }],
      tools: [{ type: 'function', function: { name: 'loop_tool' } }],
      onTool,
      maxRounds: 2,
    });

    expect(result).toBe('final answer');
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  it('uses onTool as a function handler', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-fn-tool', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('calc', '{"x":5}'))
      .mockResolvedValueOnce(makeSimpleResponse('25'));
    const client = { chat: { completions: { create: mockCreate } } };

    const onTool = vi.fn((name: string, args: Record<string, unknown>) => `${name}:${String(args['x'])}`);

    await handle.chat({
      client,
      messages: [{ role: 'user', content: 'calc' }],
      onTool,
    });

    expect(onTool).toHaveBeenCalledWith('calc', { x: 5 });
  });

  it('uses onTool as an object map — found handler', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-obj-tool', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('get_user', '{"id":42}'))
      .mockResolvedValueOnce(makeSimpleResponse('User found'));
    const client = { chat: { completions: { create: mockCreate } } };

    const getUserHandler = vi.fn().mockReturnValue({ name: 'Alice' });
    const onTool = { get_user: getUserHandler };

    await handle.chat({ client, messages: [{ role: 'user', content: 'get user' }], onTool });

    expect(getUserHandler).toHaveBeenCalledWith({ id: 42 });
  });

  it('uses onTool as object map — not-found handler emits error in TOOL_RESULT', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-unknown-tool', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('unknown_fn', '{}', 'call_u'))
      .mockResolvedValueOnce(makeSimpleResponse('ok'));
    const client = { chat: { completions: { create: mockCreate } } };

    const onTool = { known_fn: vi.fn() };

    await handle.chat({ client, messages: [{ role: 'user', content: 'call unknown' }], onTool });

    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const toolResultEmit = emitCalls.find((c) => c[0] === 'TOOL_RESULT');
    expect(toolResultEmit![1]).toMatchObject({
      error: 'Unknown tool: unknown_fn',
    });
  });

  it('handles no onTool provided — emits error in TOOL_RESULT', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-no-tool-handler', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('some_tool', '{}', 'call_n'))
      .mockResolvedValueOnce(makeSimpleResponse('ok'));
    const client = { chat: { completions: { create: mockCreate } } };

    await handle.chat({ client, messages: [{ role: 'user', content: 'call tool' }] });

    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const toolResultEmit = emitCalls.find((c) => c[0] === 'TOOL_RESULT');
    expect(toolResultEmit![1]).toMatchObject({
      error: 'No on_tool handler provided',
    });
  });

  it('handles async tool handler', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-async-tool', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('async_fn', '{"val":"hello"}'))
      .mockResolvedValueOnce(makeSimpleResponse('done async'));
    const client = { chat: { completions: { create: mockCreate } } };

    const asyncHandler = vi.fn().mockResolvedValue('async result');

    await handle.chat({
      client,
      messages: [{ role: 'user', content: 'async' }],
      onTool: asyncHandler,
    });

    expect(asyncHandler).toHaveBeenCalledWith('async_fn', { val: 'hello' });
    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const toolResultEmit = emitCalls.find((c) => c[0] === 'TOOL_RESULT');
    expect(toolResultEmit![1]).toMatchObject({ result: 'async result' });
  });

  it('tool handler that throws → errorStr in TOOL_RESULT', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-throw-tool', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('bad_tool', '{}', 'call_b'))
      .mockResolvedValueOnce(makeSimpleResponse('recovered'));
    const client = { chat: { completions: { create: mockCreate } } };

    const throwingHandler = vi.fn().mockImplementation(() => {
      throw new Error('Tool execution failed');
    });

    await handle.chat({ client, messages: [{ role: 'user', content: 'run bad tool' }], onTool: throwingHandler });

    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const toolResultEmit = emitCalls.find((c) => c[0] === 'TOOL_RESULT');
    expect(toolResultEmit![1]).toMatchObject({
      tool_call_id: 'call_b',
      error: 'Tool execution failed',
    });
  });

  it('tool handler throws non-Error → stringified error in TOOL_RESULT', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-throw-string', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('bad_tool', '{}'))
      .mockResolvedValueOnce(makeSimpleResponse('ok'));
    const client = { chat: { completions: { create: mockCreate } } };

    const throwingHandler = vi.fn().mockImplementation(() => {
      throw 'string error thrown'; // eslint-disable-line no-throw-literal
    });

    await handle.chat({ client, messages: [{ role: 'user', content: 'run' }], onTool: throwingHandler });

    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const toolResultEmit = emitCalls.find((c) => c[0] === 'TOOL_RESULT');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect((toolResultEmit![1] as Record<string, unknown>).error).toBe('string error thrown');
  });

  it('tool returning null — JSON.stringify(null) = "null" in TOOL_RESULT', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-null-tool', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('null_tool', '{}'))
      .mockResolvedValueOnce(makeSimpleResponse('null handled'));
    const client = { chat: { completions: { create: mockCreate } } };

    const nullHandler = vi.fn().mockReturnValue(null);

    await handle.chat({ client, messages: [{ role: 'user', content: 'null' }], onTool: nullHandler });

    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const toolResultEmit = emitCalls.find((c) => c[0] === 'TOOL_RESULT');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect((toolResultEmit![1] as Record<string, unknown>).result).toBe('null');
  });

  it('JSON parse error in tool args — uses empty args object', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-bad-json', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('some_tool', 'not-valid-json'))
      .mockResolvedValueOnce(makeSimpleResponse('ok'));
    const client = { chat: { completions: { create: mockCreate } } };

    const onTool = vi.fn().mockReturnValue('result');

    await handle.chat({ client, messages: [{ role: 'user', content: 'call' }], onTool });

    expect(onTool).toHaveBeenCalledWith('some_tool', {});
  });

  it('tool returning a plain string — stored as-is in TOOL_RESULT', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-str-tool', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('str_tool', '{}'))
      .mockResolvedValueOnce(makeSimpleResponse('ok'));
    const client = { chat: { completions: { create: mockCreate } } };

    const strHandler = vi.fn().mockReturnValue('plain string result');

    await handle.chat({ client, messages: [{ role: 'user', content: 'call' }], onTool: strHandler });

    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const toolResultEmit = emitCalls.find((c) => c[0] === 'TOOL_RESULT');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect((toolResultEmit![1] as Record<string, unknown>).result).toBe('plain string result');
  });

  it('tool returning an object — JSON-stringified in TOOL_RESULT', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-obj-result', sdk);
    const mockCreate = vi.fn()
      .mockResolvedValueOnce(makeToolCallResponse('obj_tool', '{}'))
      .mockResolvedValueOnce(makeSimpleResponse('ok'));
    const client = { chat: { completions: { create: mockCreate } } };

    const objHandler = vi.fn().mockReturnValue({ key: 'value' });

    await handle.chat({ client, messages: [{ role: 'user', content: 'call' }], onTool: objHandler });

    const emitCalls = (sdk.emit as ReturnType<typeof vi.fn>).mock.calls;
    const toolResultEmit = emitCalls.find((c) => c[0] === 'TOOL_RESULT');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect((toolResultEmit![1] as Record<string, unknown>).result).toBe('{"key":"value"}');
  });

  it('uses model and temperature from agent cfg', async () => {
    const sdk = makeSdk({ model: 'gpt-4o-mini', temperature: 0.3 });
    const handle = new AgentHandle('agent-cfg-test', sdk);
    const mockCreate = vi.fn().mockResolvedValue(makeSimpleResponse('ok'));
    const client = { chat: { completions: { create: mockCreate } } };

    await handle.chat({ client, messages: [{ role: 'user', content: 'hi' }] });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = (mockCreate.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(callArgs['temperature']).toBe(0.3);
  });

  it('uses custom maxTokens when provided', async () => {
    const sdk = makeSdk();
    const handle = new AgentHandle('agent-tokens', sdk);
    const mockCreate = vi.fn().mockResolvedValue(makeSimpleResponse('ok'));
    const client = { chat: { completions: { create: mockCreate } } };

    await handle.chat({
      client,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 512,
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = (mockCreate.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(callArgs['max_tokens']).toBe(512);
  });
});
