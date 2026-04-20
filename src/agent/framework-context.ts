/**
 * Syrin SDK — Framework Context
 *
 * Provides AsyncLocalStorage-based context propagation for framework adapters.
 * Allows adapter code to attach execution context that flows transparently
 * through async call chains.
 */

import { AsyncLocalStorage } from 'async_hooks';

// ---------------------------------------------------------------------------
// FrameworkContext — the context shape carried by adapters
// ---------------------------------------------------------------------------

export interface FrameworkContext {
  /** Active agent ID, if known */
  agentId: string | undefined;
  /** Syrin session ID */
  sessionId: string;
  /** Framework-level run / execution ID */
  runId: string;
  /** Workflow ID, if the run is part of a workflow */
  workflowId?: string;
  /** Swarm ID, if the run is part of a swarm */
  swarmId?: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const _storage = new AsyncLocalStorage<FrameworkContext>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current FrameworkContext set by the nearest enclosing
 * `withFrameworkContext` call in the async call chain, or `undefined` if
 * there is none.
 */
export function getFrameworkContext(): FrameworkContext | undefined {
  return _storage.getStore();
}

/**
 * Runs `fn` with `ctx` as the active FrameworkContext.
 * The context is automatically cleared (or the outer context restored)
 * when `fn` returns or throws — even across awaits.
 *
 * @param ctx  The context to activate.
 * @param fn   Synchronous or asynchronous callback.
 * @returns    Whatever `fn` returns.
 */
export function withFrameworkContext<T>(ctx: FrameworkContext, fn: () => T): T {
  return _storage.run(ctx, fn);
}
