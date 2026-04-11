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
import type { RunContext } from '@/types.js';
import { generateId } from '@/utils/helpers.js';

export type { RunContext };

/** Module-level AsyncLocalStorage — read by the interceptor on every LLM call. */
export const agentStorage = new AsyncLocalStorage<RunContext>();

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
  fn: (ctx: RunContext) => Promise<T>,
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
  return agentStorage.run(ctx, () => fn(ctx));
}

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
  return agentStorage.run(ctx, () => fn(ctx));
}

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
  return agentStorage.run(ctx, () => fn(ctx));
}

/**
 * Get the current RunContext (or undefined if not inside any agent/workflow/swarm).
 */
export function getRunContext(): RunContext | undefined {
  return agentStorage.getStore();
}
