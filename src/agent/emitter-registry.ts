/**
 * Syrin SDK — Shared emitter registry
 *
 * Breaks the circular dependency between index.ts (which creates the Emitter)
 * and agent/tool-context.ts + observability/trace-span.ts (which need to emit
 * events without importing from index.ts).
 *
 * Usage:
 *   index.ts:         setRegisteredEmitter(emitter, sessionId, agentId, config)
 *   tool-context.ts:  getRegisteredEmitter()
 */

import type { SyrinEvent } from '@/types.js';

export interface RegisteredEmitter {
  emit: (event: SyrinEvent, sessionId: string) => void;
  sessionId: string;
  agentId?: string;
}

let _registered: RegisteredEmitter | null = null;

/** @internal — Called by index.ts after the Emitter is wired up. */
export function setRegisteredEmitter(emitter: RegisteredEmitter): void {
  _registered = emitter;
}

/** @internal — Called by tool-context.ts and trace-span.ts. Returns null when SDK not initialized. */
export function getRegisteredEmitter(): RegisteredEmitter | null {
  return _registered;
}

/** @internal — Called by shutdown() to clean up. */
export function clearRegisteredEmitter(): void {
  _registered = null;
}
