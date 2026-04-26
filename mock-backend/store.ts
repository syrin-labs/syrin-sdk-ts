/**
 * In-memory store shared across all route handlers.
 * All mutations are synchronous — Node.js is single-threaded so no locking needed.
 */

import type { SyrinEvent } from '../src/types.js';

export const MAX_EVENTS = 10_000;
export const MAX_CHECKPOINT_BYTES = 1_048_576; // 1 MB

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface StoredEvent {
  receivedAt: string;
  event: SyrinEvent;
  sessionId: string;
}

const allEvents: StoredEvent[] = [];
let totalEventsReceived = 0;

export function storeEvents(events: SyrinEvent[], sessionId: string): void {
  const receivedAt = new Date().toISOString();
  for (const event of events) {
    allEvents.push({ receivedAt, event, sessionId });
  }
  // FIFO eviction — keep only the most recent MAX_EVENTS
  if (allEvents.length > MAX_EVENTS) {
    allEvents.splice(0, allEvents.length - MAX_EVENTS);
  }
  totalEventsReceived += events.length;
}

export function getAllEvents(): StoredEvent[] {
  return [...allEvents];
}

export function getEventCount(): number {
  return totalEventsReceived;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let pendingConfig: Record<string, unknown> = {};

export function setPendingConfig(updates: Record<string, unknown>): void {
  pendingConfig = { ...pendingConfig, ...updates };
}

export function popPendingConfig(): Record<string, unknown> {
  const config = { ...pendingConfig };
  pendingConfig = {};
  return config;
}

export function clearPendingConfig(): void {
  pendingConfig = {};
}

export function peekPendingConfig(): Record<string, unknown> {
  return { ...pendingConfig };
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export interface PendingGovernance {
  actions: Array<Record<string, unknown>>;
  loop_detected?: boolean;
  drift_score?: number;
  incident_id?: string;
}

let pendingGovernance: PendingGovernance | null = null;

export function setPendingGovernance(gov: PendingGovernance): void {
  pendingGovernance = gov;
}

export function popPendingGovernance(): PendingGovernance | null {
  const gov = pendingGovernance;
  pendingGovernance = null;
  return gov;
}

export function clearPendingGovernance(): void {
  pendingGovernance = null;
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

const checkpointStore = new Map<string, Record<string, unknown>>();

export function saveCheckpoint(id: string, body: Record<string, unknown>): void {
  checkpointStore.set(id, body);
}

export function getCheckpoint(id: string): Record<string, unknown> | undefined {
  return checkpointStore.get(id);
}

export function listCheckpoints(sessionId?: string): Record<string, unknown>[] {
  const all = [...checkpointStore.values()];
  return sessionId ? all.filter((cp) => cp['session_id'] === sessionId) : all;
}

export function deleteCheckpoint(id: string): boolean {
  return checkpointStore.delete(id);
}
