/**
 * TraceSpan — returned by withAgent() and passed to the user callback.
 *
 * Provides span.log(traceType, label?, data?) for emitting structured
 * TRACE_EVENT entries to the Syrin dashboard.
 *
 * Also exposes RunContext fields (agentId, runId, traceId, etc.) so code
 * previously written to receive a RunContext keeps working.
 */

import type { RunContext } from '@/types.js';
import { generateId, nowIso } from '@/utils/helpers.js';

export type TraceType =
  | 'GUARDRAIL'
  | 'TOOL_CALL'
  | 'MEMORY'
  | 'CONTEXT_UPDATE'
  | 'BUDGET_PRE'
  | 'BUDGET_POST'
  | 'CHECKPOINT'
  | 'CUSTOM'
  | (string & Record<never, never>); // allow arbitrary strings

type EmitFn = (event: Record<string, unknown>, sessionId: string) => void;
type SessionIdFn = () => string;

export class TraceSpan implements RunContext {
  // ── RunContext fields (delegated) ──────────────────────────────────────
  readonly agentId?: string;
  readonly runId: string;
  readonly workflowId?: string;
  readonly swarmId?: string;
  readonly parentRunId?: string;
  readonly traceId: string;
  readonly callDepth: number;

  private readonly _emitFn: EmitFn;
  private readonly _getSessionId: SessionIdFn;

  constructor(ctx: RunContext, emitFn: EmitFn, getSessionId: SessionIdFn) {
    this.agentId = ctx.agentId;
    this.runId = ctx.runId;
    this.workflowId = ctx.workflowId;
    this.swarmId = ctx.swarmId;
    this.parentRunId = ctx.parentRunId;
    this.traceId = ctx.traceId;
    this.callDepth = ctx.callDepth;
    this._emitFn = emitFn;
    this._getSessionId = getSessionId;
  }

  /**
   * Emit a TRACE_EVENT to the Syrin dashboard.
   *
   * @param traceType  Category: "GUARDRAIL" | "TOOL_CALL" | "MEMORY" | "CONTEXT_UPDATE" |
   *                   "BUDGET_PRE" | "BUDGET_POST" | "CHECKPOINT" | "CUSTOM" | any string
   * @param label      Human-readable label shown in the dashboard timeline
   * @param data       Arbitrary JSON-serializable payload
   *
   * @example
   * span.log('GUARDRAIL', 'PII check passed', { blocked: false, checks: ['email', 'ssn'] });
   * span.log('BUDGET_PRE', 'Estimated cost', { estimated_usd: 0.003 });
   * span.log('CUSTOM', 'Pipeline stage', { stage: 'research', iteration: 2 });
   */
  log(traceType: TraceType, label = '', data: Record<string, unknown> = {}): void {
    try {
      const sessionId = this._getSessionId();
      const event: Record<string, unknown> = {
        event_id: generateId('evt_'),
        event_type: 'TRACE_EVENT',
        trace_type: (traceType ?? 'CUSTOM').toString().toUpperCase(),
        label: label ?? '',
        timestamp: nowIso(),
        session_id: sessionId,
        agent_id: this.agentId,
        run_id: this.runId,
        trace_id: this.traceId,
        data: data ?? {},
        // Required numeric stubs for ingest protocol
        model: '',
        provider: '',
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        stream: false,
        config_applied: false,
      };
      this._emitFn(event, sessionId);
    } catch {
      // fail-open: trace logging must never crash the user's app
    }
  }
}
