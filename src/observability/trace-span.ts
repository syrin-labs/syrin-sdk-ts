/**
 * Syrin SDK — TraceSpan
 *
 * Wraps a RunContext and provides a log() method for emitting TRACE_EVENT
 * entries to the Syrin dashboard. Transparently delegates all RunContext
 * property accesses so existing code using `ctx.runId`, `ctx.agentId` etc.
 * continues to work unchanged.
 *
 * @example
 * await withAgent("query-enhancer", async (span: TraceSpan) => {
 *   span.log("GUARDRAIL", "PII check", { blocked: false });
 *   span.log("BUDGET_PRE", "Estimated cost", { estimated_usd: 0.003 });
 *   const result = await chain.invoke({ input: "..." });
 *   span.log("BUDGET_POST", "Actual cost", { actual_usd: 0.002 });
 *   span.log("CUSTOM", "Pipeline stage", { stage: "enhancement" });
 * });
 */

import type { RunContext } from '@/types.js';
import { generateId, nowIso } from '@/utils/helpers.js';
import { getRegisteredEmitter } from '@/agent/emitter-registry.js';
import { sessionStorage } from '@/core/session.js';
import type { SyrinEvent } from '@/types.js';

/** Valid TRACE_EVENT trace types. Any string is accepted — unknown types still emit. */
export const TRACE_TYPES = new Set([
  'GUARDRAIL',
  'TOOL_CALL',
  'MEMORY',
  'CONTEXT_UPDATE',
  'BUDGET_PRE',
  'BUDGET_POST',
  'CHECKPOINT',
  'CUSTOM',
]);

export class TraceSpan {
  private readonly _ctx: RunContext;

  constructor(ctx: RunContext) {
    this._ctx = ctx;
  }

  // ── Transparent delegation to RunContext ──────────────────────────────────

  get agentId(): string | undefined { return this._ctx.agentId; }
  get runId(): string { return this._ctx.runId; }
  get workflowId(): string | undefined { return this._ctx.workflowId; }
  get swarmId(): string | undefined { return this._ctx.swarmId; }
  get parentRunId(): string | undefined { return this._ctx.parentRunId; }

  /**
   * The underlying RunContext — use when you need the raw object.
   * @internal
   */
  get context(): RunContext { return this._ctx; }

  // ── Core API ──────────────────────────────────────────────────────────────

  /**
   * Emit a TRACE_EVENT to the Syrin backend.
   *
   * @param traceType  Category of the event. Standard values: "GUARDRAIL",
   *   "TOOL_CALL", "MEMORY", "CONTEXT_UPDATE", "BUDGET_PRE", "BUDGET_POST",
   *   "CHECKPOINT", "CUSTOM". Any string is accepted (always fail-open).
   * @param label  Human-readable label shown in the dashboard.
   * @param data   Arbitrary JSON-serializable payload.
   *
   * This method never throws — it is always fail-open.
   */
  log(
    traceType: string,
    label = '',
    data: Record<string, unknown> = {},
  ): void {
    try {
      const emitter = getRegisteredEmitter();
      if (!emitter) return;

      const sessionId = sessionStorage.getStore() ?? emitter.sessionId;
      const normalizedType = traceType ? traceType.toUpperCase() : 'CUSTOM';

      const event = {
        event_id: generateId('evt_'),
        event_type: 'TRACE_EVENT',
        trace_type: normalizedType,
        label: label ?? '',
        timestamp: nowIso(),
        session_id: sessionId,
        agent_id: this._ctx.agentId ?? emitter.agentId ?? '',
        run_id: this._ctx.runId,
        workflow_id: this._ctx.workflowId ?? null,
        swarm_id: this._ctx.swarmId ?? null,
        parent_run_id: this._ctx.parentRunId ?? null,
        data: data ?? {},
        // Required numeric stubs for ingest protocol
        duration_ms: 0,
        model: '',
        provider: '',
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        stream: false,
        config_applied: false,
      } as unknown as SyrinEvent;

      emitter.emit(event, sessionId);
    } catch {
      // Always fail-open — never throw from log()
    }
  }
}
