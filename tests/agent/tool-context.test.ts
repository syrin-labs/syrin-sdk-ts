/**
 * Tests: src/agent/tool-context.ts
 * Covers: tool(), memory(), toolSpan(), instrumentTool(), ToolSpan, MemorySpan
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tool, memory, toolSpan, instrumentTool, ToolSpan, MemorySpan } from '@/agent/tool-context';
import { setRegisteredEmitter, clearRegisteredEmitter } from '@/agent/emitter-registry';
import type { SyrinEvent } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedEmit {
  event: SyrinEvent;
  sessionId: string;
}

function makeEmitter(): { emit: ReturnType<typeof vi.fn>; captured: CapturedEmit[] } {
  const captured: CapturedEmit[] = [];
  const emit = vi.fn((event: SyrinEvent, sessionId: string) => {
    captured.push({ event, sessionId });
  });
  return { emit, captured };
}

beforeEach(() => {
  // Register a fresh emitter before each test
});

afterEach(() => {
  clearRegisteredEmitter();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// ToolSpan unit tests
// ---------------------------------------------------------------------------

describe('ToolSpan', () => {
  it('captures name and toolCallId', () => {
    const span = new ToolSpan('web_search', 'tc_001');
    expect(span.name).toBe('web_search');
    expect(span.toolCallId).toBe('tc_001');
  });

  it('durationMs increases over time', async () => {
    const span = new ToolSpan('fetch', 'tc_002');
    await new Promise((r) => setTimeout(r, 10));
    expect(span.durationMs).toBeGreaterThanOrEqual(5);
  });

  it('record() stores result', () => {
    const span = new ToolSpan('search', 'tc_003');
    span.record({ answer: 42 });
    expect(span._isResultRecorded()).toBe(true);
    expect(span._getResult()).toEqual({ answer: 42 });
  });

  it('setError() stores error string', () => {
    const span = new ToolSpan('search', 'tc_004');
    span.setError('timeout');
    expect(span._getError()).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// MemorySpan unit tests
// ---------------------------------------------------------------------------

describe('MemorySpan', () => {
  it('captures storeName and query', () => {
    const span = new MemorySpan('pinecone', 'user preferences');
    expect(span.storeName).toBe('pinecone');
    expect(span.query).toBe('user preferences');
  });

  it('record() stores result_count and hit', () => {
    const span = new MemorySpan('redis', 'key:123');
    span.record(3, true);
    expect(span._getResultCount()).toBe(3);
    expect(span._getHit()).toBe(true);
  });

  it('hit defaults to null', () => {
    const span = new MemorySpan('chroma', 'query');
    span.record(5);
    expect(span._getHit()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tool() — event emission
// ---------------------------------------------------------------------------

describe('tool()', () => {
  it('emits TOOL_CALL and TOOL_RESULT events', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test', agentId: 'agent_a' });

    await tool('web_search', { query: 'quantum' }, async (span) => {
      span.record({ results: ['a'] });
    });

    const types = captured.map((c) => c.event.event_type);
    expect(types).toContain('TOOL_CALL');
    expect(types).toContain('TOOL_RESULT');
  });

  it('TOOL_CALL event has tool_name and tool_arguments', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await tool('send_email', { to: 'user@example.com' }, async () => {
      // no record
    });

    const callEvt = captured.find((c) => c.event.event_type === 'TOOL_CALL');
    expect(callEvt).toBeDefined();
    const evt = callEvt!.event as unknown as Record<string, unknown>;
    expect(evt['tool_name']).toBe('send_email');
    expect(evt['tool_arguments']).toContain('user@example.com');
  });

  it('TOOL_RESULT event captures span.record() result', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await tool('calculator', null, async (span) => {
      span.record(42);
    });

    const resultEvt = captured.find((c) => c.event.event_type === 'TOOL_RESULT');
    expect(resultEvt).toBeDefined();
    const evt = resultEvt!.event as unknown as Record<string, unknown>;
    expect(evt['tool_result']).toContain('42');
  });

  it('TOOL_RESULT event captures setError() value', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await tool('lookup', null, async (span) => {
      span.setError('not_found');
    });

    const resultEvt = captured.find((c) => c.event.event_type === 'TOOL_RESULT');
    const evt = resultEvt!.event as unknown as Record<string, unknown>;
    expect(evt['tool_result']).toContain('[ERROR] not_found');
  });

  it('re-throws exceptions but still emits TOOL_RESULT with error', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await expect(
      tool('failing_tool', null, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const resultEvt = captured.find((c) => c.event.event_type === 'TOOL_RESULT');
    expect(resultEvt).toBeDefined();
    const evt = resultEvt!.event as unknown as Record<string, unknown>;
    expect(evt['tool_result']).toContain('[ERROR]');
    expect(evt['tool_result']).toContain('boom');
  });

  it('TOOL_RESULT event has duration_ms >= 0', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await tool('fast_op', null, async (span) => {
      span.record('done');
    });

    const resultEvt = captured.find((c) => c.event.event_type === 'TOOL_RESULT');
    const evt = resultEvt!.event as unknown as Record<string, unknown>;
    expect(typeof evt['duration_ms']).toBe('number');
    expect(evt['duration_ms'] as number).toBeGreaterThanOrEqual(0);
  });

  it('omitting args (2-arg overload) still emits events', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await tool('no_args_tool', async (span) => {
      span.record('result');
    });

    expect(captured.length).toBe(2);
  });

  it('fail-open: no SDK initialized — callback still executes', async () => {
    // No registered emitter
    let executed = false;
    const result = await tool('safe_op', null, async () => {
      executed = true;
      return 'ok';
    });
    expect(executed).toBe(true);
    expect(result).toBe('ok');
  });

  it('fail-open: no SDK — exceptions still propagate', async () => {
    await expect(
      tool('bad_op', null, async () => { throw new Error('propagated'); })
    ).rejects.toThrow('propagated');
  });
});

// ---------------------------------------------------------------------------
// memory() — event emission
// ---------------------------------------------------------------------------

describe('memory()', () => {
  it('emits MEMORY_RETRIEVAL event', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await memory('pinecone', 'recent preferences', async (span) => {
      span.record(5, true);
    });

    const evt = captured.find((c) => c.event.event_type === 'MEMORY_RETRIEVAL');
    expect(evt).toBeDefined();
  });

  it('MEMORY_RETRIEVAL event has result_count and hit', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await memory('redis', 'user:123', async (span) => {
      span.record(3, false);
    });

    const evt = captured.find((c) => c.event.event_type === 'MEMORY_RETRIEVAL');
    const raw = evt!.event as unknown as Record<string, unknown>;
    expect(raw['result_count']).toBe(3);
    expect(raw['hit']).toBe(false);
  });

  it('MEMORY_RETRIEVAL event has store_name and query', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await memory('chroma', 'search term', async () => { /* noop */ });

    const evt = captured.find((c) => c.event.event_type === 'MEMORY_RETRIEVAL')!;
    const raw = evt.event as unknown as Record<string, unknown>;
    expect(raw['store_name']).toBe('chroma');
    expect(raw['query']).toBe('search term');
  });

  it('MEMORY_RETRIEVAL event has duration_ms >= 0', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await memory('store', 'q', async (span) => { span.record(1); });

    const evt = captured.find((c) => c.event.event_type === 'MEMORY_RETRIEVAL')!;
    const raw = evt.event as unknown as Record<string, unknown>;
    expect(raw['duration_ms'] as number).toBeGreaterThanOrEqual(0);
  });

  it('omitting query (2-arg overload) still emits event', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await memory('mystore', async (span) => { span.record(2); });

    const evt = captured.find((c) => c.event.event_type === 'MEMORY_RETRIEVAL');
    expect(evt).toBeDefined();
  });

  it('fail-open: no SDK — callback still executes', async () => {
    let ran = false;
    const result = await memory('store', 'q', async () => {
      ran = true;
      return 'docs';
    });
    expect(ran).toBe(true);
    expect(result).toBe('docs');
  });

  it('fail-open: exceptions propagate', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    await expect(
      memory('store', 'q', async () => { throw new Error('db down'); })
    ).rejects.toThrow('db down');

    // Still emits the event even though callback threw
    const evt = captured.find((c) => c.event.event_type === 'MEMORY_RETRIEVAL');
    expect(evt).toBeDefined();
    const raw = evt!.event as unknown as Record<string, unknown>;
    expect(raw['error']).toContain('db down');
  });
});

// ---------------------------------------------------------------------------
// toolSpan() — lower-level manual API
// ---------------------------------------------------------------------------

describe('toolSpan()', () => {
  it('done() emits TOOL_CALL and TOOL_RESULT', () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const { span, done } = toolSpan('manual_tool', { key: 'val' });
    span.record('response');
    done();

    const types = captured.map((c) => c.event.event_type);
    expect(types).toContain('TOOL_CALL');
    expect(types).toContain('TOOL_RESULT');
  });

  it('done(err) records error in TOOL_RESULT', () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const { done } = toolSpan('manual_tool');
    done(new Error('stream_err'));

    const resultEvt = captured.find((c) => c.event.event_type === 'TOOL_RESULT');
    const raw = resultEvt!.event as unknown as Record<string, unknown>;
    expect(raw['tool_result']).toContain('stream_err');
  });
});

// ---------------------------------------------------------------------------
// instrumentTool()
// ---------------------------------------------------------------------------

describe('instrumentTool()', () => {
  it('wraps function transparently — return value passes through', async () => {
    const { emit } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const raw = async (x: number) => x * 2;
    const wrapped = instrumentTool(raw, { name: 'doubler' });
    const result = await wrapped(21);
    expect(result).toBe(42);
  });

  it('emits TOOL_CALL and TOOL_RESULT events', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const fetchData = instrumentTool(async (url: string) => ({ status: 200, url }), { name: 'http_get' });
    await fetchData('https://example.com');

    const types = captured.map((c) => c.event.event_type);
    expect(types).toContain('TOOL_CALL');
    expect(types).toContain('TOOL_RESULT');
  });

  it('TOOL_RESULT contains the return value', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const add = instrumentTool(async (a: number, b: number) => a + b, { name: 'add' });
    await add(3, 4);

    const resultEvt = captured.find((c) => c.event.event_type === 'TOOL_RESULT');
    const raw = resultEvt!.event as unknown as Record<string, unknown>;
    expect(raw['tool_result']).toContain('7');
  });

  it('re-throws errors from wrapped function', async () => {
    const { emit } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    const boom = instrumentTool(async () => { throw new Error('wrapped_err'); });
    await expect(boom()).rejects.toThrow('wrapped_err');
  });

  it('uses function name when name option omitted', async () => {
    const { emit, captured } = makeEmitter();
    setRegisteredEmitter({ emit, sessionId: 'ses_test' });

    async function namedFunc() { return 1; }
    const wrapped = instrumentTool(namedFunc);
    await wrapped();

    const callEvt = captured.find((c) => c.event.event_type === 'TOOL_CALL');
    const raw = callEvt!.event as unknown as Record<string, unknown>;
    expect(raw['tool_name']).toBe('namedFunc');
  });

  it('fail-open: still executes when SDK not initialized', async () => {
    // No registered emitter
    const fn = instrumentTool(async (x: number) => x + 1);
    const result = await fn(10);
    expect(result).toBe(11);
  });
});
