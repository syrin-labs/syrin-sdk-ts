/**
 * Tests: src/agent/handle.ts — AgentHandle
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
