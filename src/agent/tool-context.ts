/**
 * Tool and memory observability — track function calls and memory retrievals as named spans.
 *
 * Tool spans emit TOOL_CALL and TOOL_RESULT events with latency, args, and result.
 * Memory spans emit MEMORY_RETRIEVAL events with store name, query, duration, and result count.
 *
 * @example
 * // Tool: return value automatically captured
 * const result = await withTool('web_search', { query: 'quantum computing' }, async (t) => {
 *   const data = await searchWeb('quantum computing');
 *   t.record(data);
 *   return data;
 * });
 *
 * @example
 * // Memory retrieval from a vector DB
 * const docs = await withMemory('pinecone', 'recent user preferences', async (m) => {
 *   const results = await vectorDb.query('recent user preferences', { topK: 5 });
 *   m.record(results.length, true);
 *   return results;
 * });
 */

import { generateId, nowIso } from '@/utils/helpers.js';
import type { Emitter } from '@/observability/emitter.js';

/** Handle returned by `withTool()` for recording tool results. */
export class ToolSpan {
  /** The tool name passed to `withTool()`. */
  readonly name: string;
  /** Auto-generated unique ID for this tool invocation. */
  readonly toolCallId: string;
  /** Timestamp (ms) when the span was created. */
  readonly startTime: number;

  private _result: unknown = undefined;
  private _resultRecorded = false;
  private _error: string | undefined;

  constructor(name: string, toolCallId: string) {
    this.name = name;
    this.toolCallId = toolCallId;
    this.startTime = Date.now();
  }

  /**
   * Record the tool's return value in the telemetry event.
   * Call this inside the `withTool()` callback before returning.
   *
   * @example
   * const data = await searchWeb('quantum computing');
   * t.record(data);
   */
  record(result: unknown): void {
    this._result = result;
    this._resultRecorded = true;
  }

  /**
   * Record an error string without throwing.
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
  _getResult(): string {
    if (this._error) return `[ERROR] ${this._error}`;
    if (this._resultRecorded) return String(this._result);
    return '';
  }

  /** @internal */
  _hasError(): boolean {
    return !!this._error;
  }
}

/**
 * Track a tool call with name, args, result, and latency.
 *
 * Emits a `TOOL_CALL` event at the start and a `TOOL_RESULT` event at the end.
 * The result event includes `duration_ms` (latency) and the recorded result.
 *
 * @param name - Tool name as shown in the dashboard.
 * @param args - Arguments passed to the tool (logged as metadata).
 * @param fn - Async callback that performs the tool operation.
 * @returns Whatever the callback returns.
 *
 * @example
 * const weather = await withTool('get_weather', { city: 'London' }, async (t) => {
 *   const data = await fetchWeather('London');
 *   t.record(data);
 *   return data;
 * });
 */
export async function withTool<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  fn: (span: ToolSpan) => Promise<T>,
  emitter?: Emitter,
): Promise<T> {
  const toolCallId = generateId('tc_');
  const span = new ToolSpan(name, toolCallId);

  const _emitEvents = (error?: unknown) => {
    if (!emitter) {
      // Fallback: use global primary emitter via dynamic import
      _emitWithGlobal(span, args, error);
      return;
    }
    _emitEvents_impl(span, args, error, emitter);
  };

  try {
    const result = await fn(span);
    _emitEvents();
    return result;
  } catch (error) {
    _emitEvents(error);
    throw error;
  }
}

function _emitEvents_impl(
  span: ToolSpan,
  args: Record<string, unknown> | undefined,
  error: unknown,
  emitter: Emitter,
): void {
  const base = {
    session_id: '',  // emitter fills this from context
    agent_id: undefined,
    model: '',
    provider: '',
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    stream: false,
    config_applied: false,
  };

  // TOOL_CALL event
  emitter.emit({
    ...base,
    event_id: generateId('evt_'),
    event_type: 'TOOL_CALL' as const,
    timestamp: nowIso(),
    duration_ms: 0,
    tool_name: span.name,
    tool_call_id: span.toolCallId,
    tool_arguments: args ? JSON.stringify(args) : '',
  } as Parameters<typeof emitter.emit>[0], '');

  // TOOL_RESULT event
  const resultStr = error != null
    ? `[ERROR] ${error instanceof Error ? error.message : String(error)}`
    : span._getResult();

  emitter.emit({
    ...base,
    event_id: generateId('evt_'),
    event_type: 'TOOL_RESULT' as const,
    timestamp: nowIso(),
    duration_ms: span.durationMs,
    tool_name: span.name,
    tool_call_id: span.toolCallId,
    tool_result: resultStr,
  } as Parameters<typeof emitter.emit>[0], '');
}

/**
 * Emit TOOL_CALL + TOOL_RESULT events for a completed tool span.
 * Used by `instrumentTool()` in the public API.
 * @internal
 */
export function _emitToolEvents(
  span: ToolSpan,
  args: Record<string, unknown>,
  error: unknown,
): void {
  _emitWithGlobal(span, args, error ?? undefined);
}

function _emitWithGlobal(
  span: ToolSpan,
  args: Record<string, unknown> | undefined,
  error: unknown,
): void {
  // Import lazily to avoid circular dependency
  import('../index.js').then(({ getInstance }) => {
    try {
      const sdk = getInstance();
      _emitEvents_impl(span, args, error, (sdk as unknown as { _emitter: Emitter })._emitter);
    } catch {
      // SDK not initialized — tool span silently dropped
    }
  }).catch(() => {/* non-fatal */});
}

// ---------------------------------------------------------------------------
// Memory retrieval observability
// ---------------------------------------------------------------------------

/** Handle returned by `withMemory()` for recording retrieval results. */
export class MemorySpan {
  /** The memory store name passed to `withMemory()`. */
  readonly storeName: string;
  /** The query or key used for the retrieval. */
  readonly query: string;
  /** Timestamp (ms) when the span was created. */
  readonly startTime: number;

  private _resultCount = 0;
  private _hit: boolean | undefined;

  constructor(storeName: string, query: string) {
    this.storeName = storeName;
    this.query = query;
    this.startTime = Date.now();
  }

  /**
   * Record the retrieval outcome.
   *
   * @param resultCount - Number of results returned (default: 0).
   * @param hit - `true` for a cache/exact hit, `false` for a miss, `undefined` if N/A.
   *
   * @example
   * m.record(results.length, true);
   */
  record(resultCount = 0, hit?: boolean): void {
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
  _getHit(): boolean | undefined { return this._hit; }
}

/**
 * Track a memory retrieval with store name, query, result count, and latency.
 *
 * Emits a `MEMORY_RETRIEVAL` event on completion.
 *
 * @param storeName - Name of the memory store (e.g. `'pinecone'`, `'chroma'`, `'redis'`).
 * @param query - The query string or cache key.
 * @param fn - Async callback that performs the retrieval.
 * @returns Whatever the callback returns.
 *
 * @example
 * const docs = await withMemory('pinecone', 'user preferences', async (m) => {
 *   const results = await vectorDb.query('user preferences', { topK: 5 });
 *   m.record(results.length, true);
 *   return results;
 * });
 */
export async function withMemory<T>(
  storeName: string,
  query: string,
  fn: (span: MemorySpan) => Promise<T>,
  emitter?: Emitter,
): Promise<T> {
  const span = new MemorySpan(storeName, query);

  const _emitEvent = (error?: unknown) => {
    if (!emitter) {
      _emitMemoryWithGlobal(span, error);
      return;
    }
    _emitMemoryEvent_impl(span, error, emitter);
  };

  try {
    const result = await fn(span);
    _emitEvent();
    return result;
  } catch (error) {
    _emitEvent(error);
    throw error;
  }
}

function _emitMemoryEvent_impl(
  span: MemorySpan,
  error: unknown,
  emitter: Emitter,
): void {
  const errorStr = error != null
    ? (error instanceof Error ? error.message : String(error))
    : undefined;

  emitter.emit({
    event_id: generateId('evt_'),
    event_type: 'MEMORY_RETRIEVAL' as const,
    timestamp: nowIso(),
    session_id: '',
    agent_id: undefined,
    store_name: span.storeName,
    query: span.query,
    result_count: span._getResultCount(),
    hit: span._getHit(),
    duration_ms: span.durationMs,
    model: '',
    provider: '',
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    stream: false,
    config_applied: false,
    ...(errorStr != null ? { error: errorStr } : {}),
  } as Parameters<typeof emitter.emit>[0], '');
}

function _emitMemoryWithGlobal(span: MemorySpan, error: unknown): void {
  import('../index.js').then(({ getInstance }) => {
    try {
      const sdk = getInstance();
      _emitMemoryEvent_impl(span, error, (sdk as unknown as { _emitter: Emitter })._emitter);
    } catch {
      // SDK not initialized — memory span silently dropped
    }
  }).catch(() => {/* non-fatal */});
}
