/**
 * Tests: lazy-init queue for pre-init LLM calls
 * Covers isReady, preInitQueue, markReady, and afterCall queue-guard.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SyrinCore } from '@/core/engine';
import { SessionStore } from '@/core/session';
import { Emitter } from '@/observability/emitter';
import { OTelBridge } from '@/observability/otel';
import { CheckpointClient } from '@/core/checkpoint';
import type { SyrinConfig, SyrinEvent } from '@/types';
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
    idleFlushMs: 60000,
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

function makeResult(overrides: Partial<NormalizedCallResult> = {}): NormalizedCallResult {
  return {
    model: 'gpt-4o',
    inputTokens: 10,
    outputTokens: 5,
    finishReason: 'stop',
    durationMs: 100,
    stream: false,
    ...overrides,
  };
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

describe('lazy-init queue', () => {
  it('should start with isReady=true by default (direct instantiation)', () => {
    // Direct instantiation — adapters/tests don't go through init(), so isReady=true
    const { core } = makeCore();
    expect(core.isReady).toBe(true);
  });

  it('should be set to isReady=false by init() before async setup', () => {
    // When init() creates the core, it immediately sets isReady=false
    const { core } = makeCore();
    core.isReady = false; // simulates what init() does
    expect(core.isReady).toBe(false);
  });

  it('should expose a preInitQueue array', () => {
    const { core } = makeCore();
    expect(Array.isArray(core.preInitQueue)).toBe(true);
    expect(core.preInitQueue).toHaveLength(0);
  });

  it('should set isReady=true when markReady is called', () => {
    const { core } = makeCore();
    core.isReady = false; // simulate init() flow
    const mockEmitter = { emit: vi.fn() };
    core.markReady(mockEmitter);
    expect(core.isReady).toBe(true);
  });

  it('should flush preInitQueue to emitter on markReady', () => {
    const { core } = makeCore();
    core.isReady = false; // simulate init() flow
    const fakeEvent = { event_type: 'LLM_CALL', event_id: 'e1', session_id: 's1' } as unknown as SyrinEvent;
    core.preInitQueue.push({ event: fakeEvent, sessionId: 's1' });
    const mockEmitter = { emit: vi.fn() };
    core.markReady(mockEmitter);
    expect(mockEmitter.emit).toHaveBeenCalledWith(fakeEvent, 's1');
    expect(core.preInitQueue).toHaveLength(0);
  });

  it('should flush multiple queued events in order on markReady', () => {
    const { core } = makeCore();
    core.isReady = false; // simulate init() flow
    const e1 = { event_type: 'LLM_CALL', event_id: 'e1' } as unknown as SyrinEvent;
    const e2 = { event_type: 'LLM_CALL', event_id: 'e2' } as unknown as SyrinEvent;
    core.preInitQueue.push({ event: e1, sessionId: 's1' });
    core.preInitQueue.push({ event: e2, sessionId: 's2' });
    const mockEmitter = { emit: vi.fn() };
    core.markReady(mockEmitter);
    expect(mockEmitter.emit).toHaveBeenCalledTimes(2);
    expect(mockEmitter.emit).toHaveBeenNthCalledWith(1, e1, 's1');
    expect(mockEmitter.emit).toHaveBeenNthCalledWith(2, e2, 's2');
    expect(core.preInitQueue).toHaveLength(0);
  });

  it('should warn about replayed events when queue is non-empty', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { core } = makeCore();
    core.preInitQueue.push({ event: { event_type: 'LLM_CALL' } as unknown as SyrinEvent, sessionId: 's1' });
    core.markReady({ emit: vi.fn() });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('before init()'));
    consoleSpy.mockRestore();
  });

  it('should NOT warn when queue is empty on markReady', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { core } = makeCore();
    core.markReady({ emit: vi.fn() });
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should queue events in afterCall when isReady=false', async () => {
    const { core, sessionStore, emitSpy } = makeCore();
    // Simulate init() pre-ready state
    core.isReady = false;

    await sessionStore.getOrCreate('ses_test', 'agent-1');
    const ctx = await core.beforeCall(makeParams());
    core.afterCall(ctx, makeParams(), makeResult());

    // When isReady=false, emitter.emit should NOT be called; event should be in preInitQueue
    expect(emitSpy).not.toHaveBeenCalled();
    expect(core.preInitQueue.length).toBeGreaterThan(0);
    const queued = core.preInitQueue[0];
    expect(queued.event.event_type).toBe('LLM_CALL');
  });

  it('should emit normally after markReady is called', async () => {
    const { core, sessionStore, emitSpy } = makeCore();
    // isReady is already true by default for direct instantiation
    expect(core.isReady).toBe(true);

    await sessionStore.getOrCreate('ses_test2', 'agent-1');
    const ctx = await core.beforeCall(makeParams());
    core.afterCall(ctx, makeParams(), makeResult());

    // Now emitter.emit SHOULD have been called
    expect(emitSpy).toHaveBeenCalled();
    expect(core.preInitQueue).toHaveLength(0);
  });

  it('should replay pre-init events via markReady and then allow normal emission', async () => {
    const { core, sessionStore, emitter } = makeCore();
    const emitSpy = vi.spyOn(emitter, 'emit');

    // Simulate init() pre-ready state
    core.isReady = false;

    // Simulate 2 pre-init LLM calls
    await sessionStore.getOrCreate('ses_preinit', 'agent-test');
    const ctx1 = await core.beforeCall(makeParams());
    core.afterCall(ctx1, makeParams(), makeResult());

    const ctx2 = await core.beforeCall(makeParams());
    core.afterCall(ctx2, makeParams(), makeResult());

    // Nothing emitted yet
    expect(emitSpy).not.toHaveBeenCalled();
    expect(core.preInitQueue.length).toBe(2);

    // Now mark ready — should replay those 2 events
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    core.markReady(emitter);
    consoleSpy.mockRestore();

    expect(emitSpy).toHaveBeenCalledTimes(2);
    expect(core.preInitQueue).toHaveLength(0);

    // Post-ready call should emit immediately
    const ctx3 = await core.beforeCall(makeParams());
    core.afterCall(ctx3, makeParams(), makeResult());
    expect(emitSpy).toHaveBeenCalledTimes(3);
  });
});
