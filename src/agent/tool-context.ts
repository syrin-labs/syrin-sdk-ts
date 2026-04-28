/**
 * Syrin SDK — Tool and memory observability
 *
 * Callback-based API for tracking function calls and memory retrievals as named spans.
 *
 * Tool usage:
 *   await tool("web_search", { query: "quantum computing" }, async (span) => {
 *     const result = await searchWeb("quantum computing");
 *     span.record(result);
 *     return result;
 *   });
 *
 * Memory usage:
 *   await memory("pinecone", "recent user preferences", async (span) => {
 *     const docs = await vectorDb.query("recent user preferences", { topK: 5 });
 *     span.record(docs.length, true);
 *     return docs;
 *   });
 *
 * Lower-level / manual use:
 *   const { span, done } = toolSpan("web_search", { query: "..." });
 *   try {
 *     const result = await searchWeb(...);
 *     span.record(result);
 *     done();
 *   } catch (err) {
 *     done(err as Error);
 *     throw err;
 *   }
 */

import { generateId, nowIso } from '@/utils/helpers.js';
import { agentStorage } from '@/agent/context.js';
import { sessionStorage } from '@/core/session.js';
import { getRegisteredEmitter } from '@/agent/emitter-registry.js';
import type { SyrinEvent } from '@/types.js';

// ---------------------------------------------------------------------------
// ToolSpan
// ---------------------------------------------------------------------------

export class ToolSpan {
  /** The tool name passed to tool(). */
  readonly name: string;
  /** Auto-generated unique ID for this tool invocation. */
  readonly toolCallId: string;
  /** performance.now()-equivalent monotonic start time (ms). */
  readonly startTime: number;

  private _result: unknown = null;
  private _error: string | null = null;
  private _resultRecorded = false;

  constructor(name: string, toolCallId: string) {
    this.name = name;
    this.toolCallId = toolCallId;
    this.startTime = Date.now();
  }

  /**
   * Record the tool's return value in the telemetry event.
   * Call this inside the callback before it returns.
   */
  record(result: unknown): void {
    this._result = result;
    this._resultRecorded = true;
  }

  /**
   * Record an error string for this tool call.
   * Not needed if the error propagates via exception — that is captured automatically.
   * Use this when the tool returns an error value rather than throwing.
   */
  setError(error: string): void {
    this._error = error;
  }

  /** Elapsed milliseconds since the span was created. */
  get durationMs(): number {
    return Date.now() - this.startTime;
  }

  /** @internal */
  _getResult(): unknown { return this._result; }
  /** @internal */
  _getError(): string | null { return this._error; }
  /** @internal */
  _isResultRecorded(): boolean { return this._resultRecorded; }
}

// ---------------------------------------------------------------------------
// MemorySpan
// ---------------------------------------------------------------------------

export class MemorySpan {
  /** The name of the memory store (e.g. "pinecone", "redis", "chroma"). */
  readonly storeName: string;
  /** The query or key used for the retrieval. */
  readonly query: string;
  /** Monotonic start time (ms). */
  readonly startTime: number;

  private _resultCount = 0;
  private _hit: boolean | null = null;

  constructor(storeName: string, query: string) {
    this.storeName = storeName;
    this.query = query;
    this.startTime = Date.now();
  }

  /**
   * Record the retrieval outcome.
   * @param resultCount Number of results returned.
   * @param hit true for a cache/exact hit, false for a miss, null if not applicable.
   */
  record(resultCount = 0, hit: boolean | null = null): void {
    this._resultCount = resultCount;
    this._hit = hit;
  }

  /** Elapsed milliseconds since the span was created. */
  get durationMs(): number {
    return Date.now() - this.startTime;
  }

  /** @internal */
  _getResultCount(): number { return this._resultCount; }
  /** @internal */
  _getHit(): boolean | null { return this._hit; }
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function _getActiveSessionId(): string {
  try {
    const fromStorage = sessionStorage.getStore();
    if (fromStorage) return fromStorage;
  } catch { /* ignore */ }
  try {
    const reg = getRegisteredEmitter();
    if (reg?.sessionId) return reg.sessionId;
  } catch { /* ignore */ }
  return 'unknown';
}

function _getActiveAgentId(): string {
  try {
    const ctx = agentStorage.getStore();
    if (ctx?.agentId) return ctx.agentId;
  } catch { /* ignore */ }
  try {
    const reg = getRegisteredEmitter();
    if (reg?.agentId) return reg.agentId;
  } catch { /* ignore */ }
  return '';
}

// ---------------------------------------------------------------------------
// Event emission helpers
// ---------------------------------------------------------------------------

function _emitToolEvents(
  span: ToolSpan,
  args: Record<string, unknown> | null | undefined,
  exc: unknown,
): void {
  try {
    const emitter = getRegisteredEmitter();
    if (!emitter) return;

    const sessionId = _getActiveSessionId();
    const agentId = _getActiveAgentId();

    // TOOL_CALL event
    const callEvent = {
      event_id: generateId('evt_'),
      event_type: 'TOOL_CALL',
      timestamp: nowIso(),
      duration_ms: 0,
      session_id: sessionId,
      agent_id: agentId,
      model: '',
      provider: '',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      stream: false,
      config_applied: false,
      tool_name: span.name,
      tool_call_id: span.toolCallId,
      tool_arguments: args ? JSON.stringify(args) : '',
    } as unknown as SyrinEvent;

    try { emitter.emit(callEvent, sessionId); } catch { /* fail-open */ }

    // TOOL_RESULT event
    let resultStr = '';
    if (exc != null) {
      const err = exc instanceof Error ? exc : new Error(String(exc));
      resultStr = `[ERROR] ${err.name}: ${err.message}`;
    } else if (span._isResultRecorded()) {
      const raw = span._getResult();
      try { resultStr = JSON.stringify(raw); } catch { resultStr = String(raw); }
    } else if (span._getError()) {
      resultStr = `[ERROR] ${span._getError() as string}`;
    }

    const resultEvent = {
      event_id: generateId('evt_'),
      event_type: 'TOOL_RESULT',
      timestamp: nowIso(),
      duration_ms: span.durationMs,
      session_id: sessionId,
      agent_id: agentId,
      model: '',
      provider: '',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      stream: false,
      config_applied: false,
      tool_name: span.name,
      tool_call_id: span.toolCallId,
      tool_result: resultStr,
    } as unknown as SyrinEvent;

    try { emitter.emit(resultEvent, sessionId); } catch { /* fail-open */ }
  } catch { /* fail-open — outer guard */ }
}

function _emitMemoryEvent(span: MemorySpan, exc: unknown): void {
  try {
    const emitter = getRegisteredEmitter();
    if (!emitter) return;

    const sessionId = _getActiveSessionId();
    const agentId = _getActiveAgentId();

    let errorStr: string | undefined;
    if (exc != null) {
      const err = exc instanceof Error ? exc : new Error(String(exc));
      errorStr = `${err.name}: ${err.message}`;
    }

    const event = {
      event_id: generateId('evt_'),
      event_type: 'MEMORY_RETRIEVAL',
      timestamp: nowIso(),
      duration_ms: span.durationMs,
      session_id: sessionId,
      agent_id: agentId,
      store_name: span.storeName,
      query: span.query,
      result_count: span._getResultCount(),
      hit: span._getHit(),
      model: '',
      provider: '',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      stream: false,
      config_applied: false,
      ...(errorStr != null ? { error: errorStr } : {}),
    } as unknown as SyrinEvent;

    try { emitter.emit(event, sessionId); } catch { /* fail-open */ }
  } catch { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// tool() — callback-based API
// ---------------------------------------------------------------------------

/**
 * Track a tool call with name, args, result, and latency.
 * Emits TOOL_CALL on start and TOOL_RESULT on completion.
 *
 * @example
 * const result = await tool("web_search", { query: "quantum computing" }, async (span) => {
 *   const data = await searchWeb("quantum computing");
 *   span.record(data);
 *   return data;
 * });
 */
export async function tool<T>(
  name: string,
  args: Record<string, unknown> | null | undefined,
  fn: (span: ToolSpan) => Promise<T>,
): Promise<T>;

export async function tool<T>(
  name: string,
  fn: (span: ToolSpan) => Promise<T>,
): Promise<T>;

export async function tool<T>(
  name: string,
  argsOrFn: Record<string, unknown> | null | undefined | ((span: ToolSpan) => Promise<T>),
  fn?: (span: ToolSpan) => Promise<T>,
): Promise<T> {
  let args: Record<string, unknown> | null | undefined;
  let callback: (span: ToolSpan) => Promise<T>;

  if (typeof argsOrFn === 'function') {
    args = undefined;
    callback = argsOrFn;
  } else {
    args = argsOrFn;
    callback = fn!;
  }

  const span = new ToolSpan(name, generateId('tc_'));
  let excCaptured: unknown = null;
  try {
    return await callback(span);
  } catch (exc) {
    excCaptured = exc;
    throw exc;
  } finally {
    _emitToolEvents(span, args, excCaptured);
  }
}

// ---------------------------------------------------------------------------
// memory() — callback-based API
// ---------------------------------------------------------------------------

/**
 * Track a memory retrieval with store, query, and latency.
 * Emits a MEMORY_RETRIEVAL event on completion.
 *
 * @example
 * const docs = await memory("pinecone", "recent user preferences", async (span) => {
 *   const results = await vectorDb.query("recent user preferences", { topK: 5 });
 *   span.record(results.length, true);
 *   return results;
 * });
 */
export async function memory<T>(
  storeName: string,
  query: string,
  fn: (span: MemorySpan) => Promise<T>,
): Promise<T>;

export async function memory<T>(
  storeName: string,
  fn: (span: MemorySpan) => Promise<T>,
): Promise<T>;

export async function memory<T>(
  storeName: string,
  queryOrFn: string | ((span: MemorySpan) => Promise<T>),
  fn?: (span: MemorySpan) => Promise<T>,
): Promise<T> {
  let query: string;
  let callback: (span: MemorySpan) => Promise<T>;

  if (typeof queryOrFn === 'function') {
    query = '';
    callback = queryOrFn;
  } else {
    query = queryOrFn;
    callback = fn!;
  }

  const span = new MemorySpan(storeName, query);
  let excCaptured: unknown = null;
  try {
    return await callback(span);
  } catch (exc) {
    excCaptured = exc;
    throw exc;
  } finally {
    _emitMemoryEvent(span, excCaptured);
  }
}

// ---------------------------------------------------------------------------
// toolSpan() — lower-level manual API
// ---------------------------------------------------------------------------

/**
 * Lower-level manual API — returns a ToolSpan and a done() callback.
 * Use when you can't use the callback form (e.g. wrapping a streaming response).
 *
 * @example
 * const { span, done } = toolSpan("stream_response", { prompt: "..." });
 * try {
 *   const result = await streamResult();
 *   span.record(result);
 *   done();
 * } catch (err) {
 *   done(err as Error);
 *   throw err;
 * }
 */
export function toolSpan(
  name: string,
  args?: Record<string, unknown> | null,
): { span: ToolSpan; done: (err?: unknown) => void } {
  const span = new ToolSpan(name, generateId('tc_'));
  const done = (err?: unknown): void => {
    _emitToolEvents(span, args, err ?? null);
  };
  return { span, done };
}

// ---------------------------------------------------------------------------
// instrumentTool() — function wrapper decorator
// ---------------------------------------------------------------------------

export interface InstrumentToolOptions {
  /** Override the tool name used in telemetry. Defaults to the function's name. */
  name?: string;
}

/**
 * Wrap a function to auto-emit TOOL_CALL + TOOL_RESULT events on every call.
 * No callback or span.record() needed — the return value is captured automatically.
 *
 * @example
 * const searchWeb = instrumentTool(async (query: string) => {
 *   return await fetch(`/search?q=${query}`).then(r => r.json());
 * }, { name: "web_search" });
 *
 * // Decorator pattern (manual):
 * async function rawSearch(query: string) { ... }
 * const search = instrumentTool(rawSearch);
 */
export function instrumentTool<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options?: InstrumentToolOptions,
): (...args: TArgs) => Promise<TReturn> {
  const toolName = options?.name ?? fn.name ?? 'unknown_tool';

  return async function instrumented(...args: TArgs): Promise<TReturn> {
    // Try to capture args as a plain object for telemetry (best-effort)
    let argsDict: Record<string, unknown> | undefined;
    try {
      argsDict = {};
      args.forEach((value, i) => {
        (argsDict as Record<string, unknown>)[String(i)] = value;
      });
    } catch {
      argsDict = undefined;
    }

    const span = new ToolSpan(toolName, generateId('tc_'));
    let excCaptured: unknown = null;
    try {
      const result = await fn(...args);
      span.record(result);
      return result;
    } catch (exc) {
      excCaptured = exc;
      throw exc;
    } finally {
      _emitToolEvents(span, argsDict, excCaptured);
    }
  };
}
