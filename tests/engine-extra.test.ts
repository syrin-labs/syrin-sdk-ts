/**
 * Tests: src/core/engine.ts — extra coverage for _recordAndEmit paths
 * Covers lines 508-611, 656-662
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SyrinCore } from '@/core/engine';
import { SessionStore, sessionStorage } from '@/core/session';
import { Emitter } from '@/observability/emitter';
import { OTelBridge } from '@/observability/otel';
import { CheckpointClient } from '@/core/checkpoint';
import { agentStorage } from '@/agent/context';
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

describe('SyrinCore._recordAndEmit — toolDefinitions included in LLM_CALL event', () => {
  it('includes tool_definitions in event when result has toolDefinitions', async () => {
    const { core, sessionStore, emitSpy } = makeCore();
    const sessionId = 'ses_td_1';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    core.afterCall(ctx, makeParams(), makeResult({
      toolDefinitions: [{ name: 'search', description: 'Search tool' }],
    }));

    const event = emitSpy.mock.calls[0][0];
    expect(event.event_type).toBe('LLM_CALL');
    expect(event['tool_definitions']).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(event['tool_definitions']![0]).toMatchObject({ name: 'search' });
  });

  it('does not include tool_definitions when empty', async () => {
    const { core, sessionStore, emitSpy } = makeCore();
    const sessionId = 'ses_td_2';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    core.afterCall(ctx, makeParams(), makeResult({ toolDefinitions: [] }));

    const event = emitSpy.mock.calls[0][0];
    expect(event['tool_definitions']).toBeUndefined();
  });
});

describe('SyrinCore._recordAndEmit — captureContent paths', () => {
  it('includes completion_text when captureContent=true and responseText is non-null', async () => {
    const { core, sessionStore, emitSpy } = makeCore({ captureContent: true });
    const sessionId = 'ses_cc_1';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    core.afterCall(ctx, makeParams(), makeResult({ responseText: 'The answer is 42.' }));

    const event = emitSpy.mock.calls[0][0];
    expect(event['completion_text']).toBe('The answer is 42.');
    expect(event['prompt_messages']).toBeDefined();
  });

  it('does not include completion_text when responseText is null/undefined', async () => {
    const { core, sessionStore, emitSpy } = makeCore({ captureContent: true });
    const sessionId = 'ses_cc_2';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    core.afterCall(ctx, makeParams(), makeResult({ responseText: undefined }));

    const event = emitSpy.mock.calls[0][0];
    expect(event['completion_text']).toBeUndefined();
    // prompt_messages still present with captureContent=true
    expect(event['prompt_messages']).toBeDefined();
  });

  it('does not include prompt_messages when captureContent=false', async () => {
    const { core, sessionStore, emitSpy } = makeCore({ captureContent: false });
    const sessionId = 'ses_cc_3';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    core.afterCall(ctx, makeParams(), makeResult({ responseText: 'Hello' }));

    const event = emitSpy.mock.calls[0][0];
    expect(event['prompt_messages']).toBeUndefined();
    expect(event['completion_text']).toBeUndefined();
  });
});

describe('SyrinCore._recordAndEmit — toolValidation flush path (lines 607-611)', () => {
  it('flushes emitter when toolValidation=true and tool calls are present', async () => {
    const { core, sessionStore, emitter } = makeCore({ toolValidation: true });
    const sessionId = 'ses_tv_1';
    await sessionStore.getOrCreate(sessionId);

    const flushSpy = vi.spyOn(emitter, 'flush').mockResolvedValue();

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    flushSpy.mockClear(); // reset any prior calls from beforeCall path
    core.afterCall(ctx, makeParams(), makeResult({
      toolCalls: [{ id: 'tc_1', name: 'validate_tool', arguments: '{}' }],
    }));

    // Allow the flush promise to settle
    await new Promise((r) => setTimeout(r, 0));

    // flush should have been called at least once from the toolValidation path
    expect(flushSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('toolValidation=true with tool calls calls flush (afterCall triggers it)', async () => {
    const { core, sessionStore, emitter } = makeCore({ toolValidation: true });
    const sessionId = 'ses_tv_2';
    await sessionStore.getOrCreate(sessionId);

    // Replace flush with a spy that tracks calls
    let flushCallCount = 0;
    vi.spyOn(emitter, 'flush').mockImplementation(() => { flushCallCount++; return Promise.resolve(); });

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    const beforeFlushCount = flushCallCount;

    core.afterCall(ctx, makeParams(), makeResult({
      toolCalls: [{ id: 'tc_2', name: 'search', arguments: '{}' }],
    }));

    await new Promise((r) => setTimeout(r, 10));
    // toolValidation=true with tool calls must call flush at least once more
    expect(flushCallCount).toBeGreaterThan(beforeFlushCount);
  });

  it('handles flush error gracefully (does not throw)', async () => {
    const { core, sessionStore, emitter } = makeCore({ toolValidation: true, debug: false });
    const sessionId = 'ses_tv_4';
    await sessionStore.getOrCreate(sessionId);

    vi.spyOn(emitter, 'flush').mockRejectedValue(new Error('Flush failed'));

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    expect(() =>
      core.afterCall(ctx, makeParams(), makeResult({
        toolCalls: [{ id: 'tc_3', name: 'tool', arguments: '{}' }],
      }))
    ).not.toThrow();

    // Wait for the catch branch
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('_runCtxFields — with active agentStorage context (lines 656-662)', () => {
  it('LLM_CALL event includes run_id and workflow_id from agent storage', async () => {
    const { core, sessionStore, emitSpy } = makeCore();
    const sessionId = 'ses_rctx_1';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));

    // Run afterCall inside an agentStorage context
    agentStorage.run(
      { agentId: 'my-agent', runId: 'run_ctx_1', workflowId: 'wf_ctx_1', swarmId: 'swarm_ctx_1' },
      () => {
        core.afterCall(ctx, makeParams(), makeResult());
      }
    );

    const event = emitSpy.mock.calls[0][0];
    expect(event['run_id']).toBe('run_ctx_1');
    expect(event['workflow_id']).toBe('wf_ctx_1');
    expect(event['swarm_id']).toBe('swarm_ctx_1');
  });

  it('LLM_CALL event has no run fields when no agentStorage context', async () => {
    const { core, sessionStore, emitSpy } = makeCore();
    const sessionId = 'ses_rctx_2';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    // No agentStorage.run wrapping
    core.afterCall(ctx, makeParams(), makeResult());

    const event = emitSpy.mock.calls[0][0];
    expect(event['run_id']).toBeUndefined();
    expect(event['workflow_id']).toBeUndefined();
  });
});

describe('SyrinCore._recordAndEmit — tool call with unparseable arguments', () => {
  it('emits TOOL_CALL event with _raw fallback for bad JSON args', async () => {
    const { core, sessionStore, emitSpy } = makeCore();
    const sessionId = 'ses_badargs_1';
    await sessionStore.getOrCreate(sessionId);

    const ctx = await sessionStorage.run(sessionId, () => core.beforeCall(makeParams()));
    core.afterCall(ctx, makeParams(), makeResult({
      toolCalls: [{ id: 'tc_bad', name: 'my_tool', arguments: 'not-valid-json{{{' }],
    }));

    const toolCallEvent = emitSpy.mock.calls.find((c) => c[0].event_type === 'TOOL_CALL');
    expect(toolCallEvent).toBeDefined();
    const args = toolCallEvent![0]['arguments'] as Record<string, unknown>;
    expect(args['_raw']).toBe('not-valid-json{{{');
  });
});
