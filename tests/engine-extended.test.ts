/**
 * Tests: src/core/engine.ts — SyrinCore: beforeCall/afterCall pipeline, config injection, governance
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SyrinCore } from '@/core/engine';
import { SessionStore } from '@/core/session';
import { Emitter } from '@/observability/emitter';
import { OTelBridge } from '@/observability/otel';
import { CheckpointClient } from '@/core/checkpoint';
import { GovernanceStopError } from '@/core/governance';
import { sessionStorage } from '@/core/session';
import type { SyrinConfig } from '@/types';
import type { NormalizedCallParams, NormalizedCallResult } from '@/core/engine';

afterEach(() => vi.clearAllMocks());

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4402',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4402',
    debug: false,
    captureContent: false,
    offline: true,
    batchIntervalMs: 60000,
    batchSize: 50,
    ...overrides,
  };
}

function makeCore(configOverrides: Partial<SyrinConfig> = {}): {
  core: SyrinCore;
  sessionStore: SessionStore;
  emitter: Emitter;
  emitSpy: ReturnType<typeof vi.spyOn>;
} {
  const config = makeConfig(configOverrides);
  const sessionStore = new SessionStore();
  const emitter = new Emitter(config, sessionStore);
  const otelBridge = new OTelBridge(config);
  otelBridge.setup();
  const checkpointClient = new CheckpointClient(config);
  const core = new SyrinCore(config, sessionStore, emitter, otelBridge, checkpointClient);
  const emitSpy = vi.spyOn(emitter, 'emit');
  return { core, sessionStore, emitter, emitSpy };
}

function makeParams(overrides: Partial<NormalizedCallParams> = {}): NormalizedCallParams {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
    temperature: 0.7,
    stream: false,
    raw: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }], temperature: 0.7 },
    ...overrides,
  };
}

function makeResult(overrides: Partial<NormalizedCallResult> = {}): NormalizedCallResult {
  return {
    model: 'gpt-4o',
    inputTokens: 100,
    outputTokens: 50,
    finishReason: 'stop',
    durationMs: 123,
    stream: false,
    ...overrides,
  };
}

describe('SyrinCore.beforeCall', () => {
  it('returns BeforeCallResult with session and agent info', async () => {
    const { core, sessionStore } = makeCore();
    const sessionId = 'ses_bc_1';
    await sessionStore.getOrCreate(sessionId, 'agent-x');

    const result = await sessionStorage.run(sessionId, () =>
      core.beforeCall(makeParams())
    );

    expect(result.sessionId).toBe(sessionId);
    expect(result.configApplied).toBe(false);
  });

  it('injects temperature from effectiveConfig', async () => {
    const { core, sessionStore } = makeCore();
    const sessionId = 'ses_bc_2';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.applyConfigUpdate(sessionId, { temperature: 0.2 });

    const result = await sessionStorage.run(sessionId, () =>
      core.beforeCall(makeParams())
    );

    expect(result.modifiedRaw['temperature']).toBe(0.2);
    expect(result.configApplied).toBe(true);
  });

  it('injects max_tokens from effectiveConfig', async () => {
    const { core, sessionStore } = makeCore();
    const sessionId = 'ses_bc_3';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.applyConfigUpdate(sessionId, { max_tokens: 500 });

    const result = await sessionStorage.run(sessionId, () =>
      core.beforeCall(makeParams())
    );

    expect(result.modifiedRaw['max_tokens']).toBe(500);
    expect(result.configApplied).toBe(true);
  });

  it('injects model from effectiveConfig', async () => {
    const { core, sessionStore } = makeCore();
    const sessionId = 'ses_bc_4';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.applyConfigUpdate(sessionId, { model: 'gpt-4o-mini' });

    const result = await sessionStorage.run(sessionId, () =>
      core.beforeCall(makeParams())
    );

    expect(result.modifiedRaw['model']).toBe('gpt-4o-mini');
    expect(result.configApplied).toBe(true);
  });

  it('skips temperature injection for o1 models', async () => {
    const { core, sessionStore } = makeCore();
    const sessionId = 'ses_bc_5';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.applyConfigUpdate(sessionId, { temperature: 0.5 });

    const result = await sessionStorage.run(sessionId, () =>
      core.beforeCall(makeParams({ model: 'o1', raw: { model: 'o1', messages: [] } }))
    );

    expect(result.tempUnsupported).toBe(true);
    // temperature should not be in modifiedRaw from config injection (may not exist at all)
    expect(result.modifiedRaw['model']).toBe('o1');
  });

  it('throws GovernanceStopError when stop action is pending', async () => {
    const { core, sessionStore } = makeCore();
    const sessionId = 'ses_bc_6';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.appendGovernanceAction(sessionId, { type: 'stop', reason: 'cost limit' });

    await expect(
      sessionStorage.run(sessionId, () => core.beforeCall(makeParams()))
    ).rejects.toThrow(GovernanceStopError);
  });

  it('includes injected messages when inject_message queued', async () => {
    const { core, sessionStore } = makeCore();
    const sessionId = 'ses_bc_7';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.appendInjectedMessage(sessionId, { role: 'system', content: 'Focus on X' });

    const result = await sessionStorage.run(sessionId, () =>
      core.beforeCall(makeParams())
    );

    const messages = result.modifiedRaw['messages'] as Array<Record<string, unknown>>;
    expect(messages.some((m) => m['role'] === 'system' && m['content'] === 'Focus on X')).toBe(true);
    expect(result.governanceApplied).toBe(true);
  });

  it('injects system_prompt into messages (OpenAI format)', async () => {
    const { core, sessionStore } = makeCore();
    const sessionId = 'ses_bc_8';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.applyConfigUpdate(sessionId, { system_prompt: 'Be concise' });

    const result = await sessionStorage.run(sessionId, () =>
      core.beforeCall(makeParams({ raw: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] } }))
    );

    const messages = result.modifiedRaw['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({ role: 'system', content: 'Be concise' });
    expect(result.configApplied).toBe(true);
  });

  it('replaces existing system message with new system_prompt', async () => {
    const { core, sessionStore } = makeCore();
    const sessionId = 'ses_bc_9';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.applyConfigUpdate(sessionId, { system_prompt: 'New system prompt' });

    const params = makeParams({
      raw: {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Old prompt' },
          { role: 'user', content: 'Hello' },
        ],
      },
    });

    const result = await sessionStorage.run(sessionId, () =>
      core.beforeCall(params)
    );

    const messages = result.modifiedRaw['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({ role: 'system', content: 'New system prompt' });
    expect(messages.filter((m) => m['role'] === 'system')).toHaveLength(1);
  });

  it('filters disabled tools', async () => {
    const { core, sessionStore } = makeCore();
    const sessionId = 'ses_bc_10';
    await sessionStore.getOrCreate(sessionId);
    sessionStore.applyConfigUpdate(sessionId, { disabled_tools: ['search'] });

    const tools = [
      { function: { name: 'search', parameters: {} } },
      { function: { name: 'calculate', parameters: {} } },
    ];

    const result = await sessionStorage.run(sessionId, () =>
      core.beforeCall(makeParams({ raw: { model: 'gpt-4o', messages: [], tools } }))
    );

    const filteredTools = result.modifiedRaw['tools'] as Array<unknown>;
    expect(filteredTools).toHaveLength(1);
    expect((filteredTools[0] as { function: { name: string } }).function.name).toBe('calculate');
  });
});

describe('SyrinCore.afterCall', () => {
  it('emits LLM_CALL event', async () => {
    const { core, sessionStore, emitSpy } = makeCore();
    const sessionId = 'ses_ac_1';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    core.afterCall(ctx, makeParams(), makeResult());

    expect(emitSpy).toHaveBeenCalled();
    const firstCall = emitSpy.mock.calls[0];
    expect(firstCall[0].event_type).toBe('LLM_CALL');
    expect(firstCall[0].model).toBe('gpt-4o');
  });

  it('records call and cost in session', async () => {
    const { core, sessionStore } = makeCore();
    const sessionId = 'ses_ac_2';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    core.afterCall(ctx, makeParams(), makeResult({ inputTokens: 1000, outputTokens: 500 }));

    const session = sessionStore.getSession(sessionId);
    expect(session?.callCount).toBe(1);
    expect(session?.cumulativeCostUsd).toBeGreaterThan(0);
  });

  it('includes capture_content when enabled', async () => {
    const { core, sessionStore, emitSpy } = makeCore({ captureContent: true });
    const sessionId = 'ses_ac_3';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    core.afterCall(ctx, makeParams(), makeResult({ responseText: 'Hello there!' }));

    const event = emitSpy.mock.calls[0][0];
    expect(event['completion_text']).toBe('Hello there!');
  });

  it('emits TOOL_CALL events for tool calls', async () => {
    const { core, sessionStore, emitSpy } = makeCore();
    const sessionId = 'ses_ac_4';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    core.afterCall(ctx, makeParams(), makeResult({
      toolCalls: [{ id: 'tc_1', name: 'search', arguments: '{"q":"test"}' }],
    }));

    const eventTypes = emitSpy.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);
    expect(eventTypes).toContain('LLM_CALL');
    expect(eventTypes).toContain('TOOL_CALL');
  });
});

describe('SyrinCore.onStreamComplete', () => {
  it('emits LLM_CALL event for streaming', async () => {
    const { core, sessionStore, emitSpy } = makeCore();
    const sessionId = 'ses_sc_1';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams({ stream: true })));
    core.onStreamComplete(ctx, makeParams({ stream: true }), makeResult({ stream: true }));

    const eventTypes = emitSpy.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);
    expect(eventTypes).toContain('LLM_CALL');
  });
});

describe('SyrinCore.onCallError', () => {
  it('emits LLM_ERROR event', async () => {
    const { core, sessionStore, emitSpy } = makeCore();
    const sessionId = 'ses_err_1';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    core.onCallError(ctx, makeParams(), new Error('API failure'), 123);

    const event = emitSpy.mock.calls[0][0];
    expect(event.event_type).toBe('LLM_ERROR');
    expect(event.error).toBe('API failure');
  });

  it('handles null ctx gracefully', () => {
    const { core, emitSpy } = makeCore();
    core.onCallError(null, makeParams(), new Error('crash'), 50);
    const event = emitSpy.mock.calls[0][0];
    expect(event.event_type).toBe('LLM_ERROR');
  });
});

describe('SyrinCore.buildSchema', () => {
  it('returns schema with version, global sections', () => {
    const { core } = makeCore();
    const schema = core.buildSchema();
    expect(schema['version']).toBeDefined();
    expect(schema['global']).toBeDefined();
    const global = schema['global'] as Record<string, unknown>;
    expect(global['llm']).toBeDefined();
    expect(global['prompt']).toBeDefined();
  });

  it('applies schemaDefaults to field defaults', () => {
    const { core } = makeCore({ schemaDefaults: { 'llm.temperature': 0.3 } });
    const schema = core.buildSchema();
    const llmFields = (schema['global'] as Record<string, { fields: Array<{ name: string; default: unknown }> }>)['llm'].fields;
    const tempField = llmFields.find((f) => f.name === 'temperature');
    expect(tempField?.default).toBe(0.3);
  });

  it('includes agents sections when agent fields declared', () => {
    const { core } = makeCore();
    // Simulate field declarations via _agentFields
    (core as unknown as { _agentFields: Record<string, Array<{ key: string; default: unknown }>> })._agentFields = {
      'my-agent': [{ key: 'llm.temperature', default: 0.7 }],
    };
    const schema = core.buildSchema();
    const agents = schema['agents'] as Record<string, unknown>;
    expect(agents['my-agent']).toBeDefined();
  });
});

describe('SyrinCore.uninstallAll', () => {
  it('does not throw when called', () => {
    const { core } = makeCore();
    expect(() => core.uninstallAll()).not.toThrow();
  });
});
