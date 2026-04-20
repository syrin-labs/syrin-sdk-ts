/**
 * Syrin SDK — Per-call skip context
 *
 * When inside a `withSkip()` scope, adapters will pass through calls without
 * any telemetry emission. Useful for health checks, warm-up calls, or any
 * invocation that should not be instrumented.
 */

import { AsyncLocalStorage } from 'async_hooks';

export const _skipStore = new AsyncLocalStorage<boolean>();

/**
 * Run `fn` with telemetry emission disabled for all LLM calls made inside it.
 *
 * @example
 * await withSkip(async () => {
 *   await openai.chat.completions.create({ ... }); // not instrumented
 * });
 */
export async function withSkip<T>(fn: () => Promise<T>): Promise<T> {
  return _skipStore.run(true, fn);
}
