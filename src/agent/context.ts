/**
 * Syrin SDK — Multi-agent support
 *
 * Uses Node.js AsyncLocalStorage so that each async task/branch automatically
 * inherits its parent's RunContext without any manual thread-local management.
 *
 * Key insight: AsyncLocalStorage propagates into child tasks created with
 * Promise.all / Promise.allSettled / asyncio equivalents, meaning parallel
 * swarms just work.
 *
 * Abstractions
 *   withAgent(agentId, fn)    — scope a single agent
 *   withWorkflow(id, fn)      — scope a sequential workflow
 *   withSwarm(id, fn)         — scope parallel agents
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { RunContext, SyrinEvent, SyrinEventBase } from '@/types.js';
import { generateId, nowIso } from '@/utils/helpers.js';
import { TraceSpan } from './trace-span.js';

export type { RunContext };

/** Module-level AsyncLocalStorage — read by the interceptor on every LLM call. */
export const agentStorage = new AsyncLocalStorage<RunContext>();

// ---------------------------------------------------------------------------
// Lifecycle emitter wiring
// ---------------------------------------------------------------------------

type LifecycleEmitter = { emit(event: SyrinEvent, sessionId: string): void };
let _lifecycleEmitter: LifecycleEmitter | null = null;

/** Called by SDK init() to wire in the emitter for lifecycle events. */
export function _setLifecycleEmitter(e: LifecycleEmitter | null): void {
  _lifecycleEmitter = e;
}

function _getSessionId(): string {
  try {
    // Attempt to read from agentStorage store (may have session_id in some setups)
    // but in practice session ID lives in sessionStorage — return 'unknown' as fallback
    return agentStorage.getStore()?.runId ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function _emitLifecycle(event: SyrinEvent, sessionId: string): void {
  try {
    _lifecycleEmitter?.emit(event, sessionId);
  } catch {
    // fail-open: SDK crash must never block user call
  }
}

/**
 * Build a lifecycle SyrinEvent from a RunContext.
 * DRY helper used by withAgent, withWorkflow, withSwarm.
 */
function _buildLifecycleEvent(
  eventType: SyrinEvent['event_type'],
  ctx: RunContext,
  durationMs = 0,
): SyrinEvent {
  const base: SyrinEventBase & { event_type: SyrinEvent['event_type'] } = {
    event_id: generateId('evt_'),
    event_type: eventType,
    timestamp: nowIso(),
    session_id: _getSessionId(),
    agent_id: ctx.agentId ?? undefined,
    run_id: ctx.runId,
    workflow_id: ctx.workflowId ?? undefined,
    swarm_id: ctx.swarmId ?? undefined,
    parent_run_id: ctx.parentRunId ?? undefined,
    trace_id: ctx.traceId,
    call_depth: ctx.callDepth,
    duration_ms: durationMs,
    model: '',
    provider: '',
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    stream: false,
    config_applied: false,
  };
  // Cast is safe: all lifecycle events share the SyrinEventBase shape;
  // the discriminant is set correctly from the `eventType` parameter.
  return base as SyrinEvent;
}

// ---------------------------------------------------------------------------
// withAgent
// ---------------------------------------------------------------------------

/**
 * Run `fn` with a specific agent_id active for all LLM calls inside.
 *
 * @example
 * await withAgent("researcher", async () => {
 *   await openai.chat.completions.create({ ... });
 * });
 */
export async function withAgent<T>(
  agentId: string,
  fn: (span: TraceSpan) => Promise<T>,
  options?: { runId?: string; workflowId?: string; swarmId?: string; traceId?: string }
): Promise<T> {
  const parent = agentStorage.getStore();
  const ctx: RunContext = {
    agentId,
    runId: options?.runId ?? generateId('run_'),
    workflowId: options?.workflowId ?? parent?.workflowId,
    swarmId: options?.swarmId ?? parent?.swarmId,
    parentRunId: parent?.runId,
    traceId: options?.traceId ?? parent?.traceId ?? generateId('trc_'),
    callDepth: parent ? parent.callDepth + 1 : 0,
  };

  const sessionId = ctx.runId; // use runId as proxy session key for lifecycle events
  _emitLifecycle(_buildLifecycleEvent('AGENT_RUN_STARTED', ctx, 0), sessionId);

  const span = new TraceSpan(
    ctx,
    (event, sid) => { _emitLifecycle(event as unknown as SyrinEvent, sid); },
    _getSessionId,
  );

  const t0 = performance.now();
  try {
    return await agentStorage.run(ctx, () => fn(span));
  } finally {
    const durationMs = Math.round(performance.now() - t0);
    _emitLifecycle(_buildLifecycleEvent('AGENT_RUN_ENDED', ctx, durationMs), sessionId);
  }
}

// ---------------------------------------------------------------------------
// withWorkflow
// ---------------------------------------------------------------------------

/**
 * Run `fn` within a named workflow (groups sequential agents).
 * Agents nested inside automatically inherit the workflowId.
 *
 * @example
 * await withWorkflow("research-pipeline", async (wf) => {
 *   await withAgent("researcher", async () => { ... });
 *   await withAgent("writer", async () => { ... });
 * });
 */
export async function withWorkflow<T>(
  workflowId: string | undefined,
  fn: (ctx: RunContext) => Promise<T>,
  options?: { runId?: string; traceId?: string }
): Promise<T> {
  const parent = agentStorage.getStore();
  const ctx: RunContext = {
    workflowId: workflowId ?? generateId('wf_'),
    runId: options?.runId ?? generateId('run_'),
    parentRunId: parent?.runId,
    traceId: options?.traceId ?? parent?.traceId ?? generateId('trc_'),
    callDepth: parent ? parent.callDepth + 1 : 0,
  };

  const sessionId = ctx.runId;
  _emitLifecycle(_buildLifecycleEvent('WORKFLOW_STARTED', ctx, 0), sessionId);

  const t0 = performance.now();
  try {
    return await agentStorage.run(ctx, () => fn(ctx));
  } finally {
    const durationMs = Math.round(performance.now() - t0);
    _emitLifecycle(_buildLifecycleEvent('WORKFLOW_ENDED', ctx, durationMs), sessionId);
  }
}

// ---------------------------------------------------------------------------
// withSwarm
// ---------------------------------------------------------------------------

/**
 * Run `fn` within a named swarm (groups parallel agents).
 * All agents spawned inside inherit the swarmId.
 *
 * @example
 * await withSwarm("parallel-research", async (swarm) => {
 *   await Promise.all([
 *     withAgent("agent-a", async () => { ... }),
 *     withAgent("agent-b", async () => { ... }),
 *   ]);
 * });
 */
export async function withSwarm<T>(
  swarmId: string | undefined,
  fn: (ctx: RunContext) => Promise<T>,
  options?: { runId?: string; traceId?: string }
): Promise<T> {
  const parent = agentStorage.getStore();
  const ctx: RunContext = {
    swarmId: swarmId ?? generateId('swarm_'),
    runId: options?.runId ?? generateId('run_'),
    parentRunId: parent?.runId,
    traceId: options?.traceId ?? parent?.traceId ?? generateId('trc_'),
    callDepth: parent ? parent.callDepth + 1 : 0,
  };

  const sessionId = ctx.runId;
  _emitLifecycle(_buildLifecycleEvent('SWARM_STARTED', ctx, 0), sessionId);

  const t0 = performance.now();
  try {
    return await agentStorage.run(ctx, () => fn(ctx));
  } finally {
    const durationMs = Math.round(performance.now() - t0);
    _emitLifecycle(_buildLifecycleEvent('SWARM_ENDED', ctx, durationMs), sessionId);
  }
}

/**
 * Get the current RunContext (or undefined if not inside any agent/workflow/swarm).
 */
export function getRunContext(): RunContext | undefined {
  return agentStorage.getStore();
}
