/**
 * Syrin SDK — Checkpoint storage.
 *
 * Checkpoints are snapshots of conversation state (messages + session metadata).
 * They are stored on the Syrin backend so they survive process restarts and can
 * be managed (triggered, restored) by the backend's governance engine.
 *
 * CheckpointClient is the primary store — it POSTs to /checkpoints on the backend
 * and falls back to an in-memory store for offline mode or when the backend is
 * unreachable.
 *
 * The in-memory fallback also acts as a local cache so that restore operations
 * (triggered by governance actions received in the same process lifetime) can
 * resolve without an extra network round-trip.
 */

import { generateId, nowIso } from '@/utils/helpers.js';
import type { SyrinSDKConfig } from '@/types.js';

export interface Checkpoint {
  checkpointId: string;
  sessionId: string;
  messages: Array<Record<string, unknown>>;
  activeConfig: Record<string, unknown>;
  callCount: number;
  cumulativeCostUsd: number;
  createdAt: string;
  label?: string;
  metadata: Record<string, unknown>;
}

export interface CreateCheckpointOptions {
  label?: string;
  metadata?: Record<string, unknown>;
  activeConfig?: Record<string, unknown>;
  callCount?: number;
  cumulativeCostUsd?: number;
}

// ---------------------------------------------------------------------------
// InMemoryCheckpointStore — used as a local cache and offline fallback
// ---------------------------------------------------------------------------

class InMemoryCheckpointStore {
  private readonly _maxPerSession: number;
  private readonly _store = new Map<string, Checkpoint[]>();

  constructor(maxPerSession = 10) {
    this._maxPerSession = maxPerSession;
  }

  put(cp: Checkpoint): void {
    if (!this._store.has(cp.sessionId)) {
      this._store.set(cp.sessionId, []);
    }
    const bucket = this._store.get(cp.sessionId)!;
    bucket.push(cp);
    if (bucket.length > this._maxPerSession) {
      bucket.shift(); // evict oldest
    }
  }

  getById(checkpointId: string): Checkpoint | undefined {
    for (const bucket of this._store.values()) {
      const found = bucket.find((cp) => cp.checkpointId === checkpointId);
      if (found) return found;
    }
    return undefined;
  }

  getLatest(sessionId: string): Checkpoint | undefined {
    const bucket = this._store.get(sessionId) ?? [];
    return bucket[bucket.length - 1];
  }

  listForSession(sessionId: string): Checkpoint[] {
    return [...(this._store.get(sessionId) ?? [])];
  }

  delete(checkpointId: string): boolean {
    for (const [, bucket] of this._store) {
      const idx = bucket.findIndex((cp) => cp.checkpointId === checkpointId);
      if (idx !== -1) {
        bucket.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  clearSession(sessionId: string): number {
    const count = (this._store.get(sessionId) ?? []).length;
    this._store.delete(sessionId);
    return count;
  }
}

// ---------------------------------------------------------------------------
// CheckpointClient — HTTP-backed, in-memory fallback
// ---------------------------------------------------------------------------

export class CheckpointClient {
  private readonly _cache = new InMemoryCheckpointStore();

  constructor(private readonly _config: SyrinSDKConfig) {}

  /**
   * Create and persist a checkpoint.
   * In online mode: POST to /checkpoints. Falls back to local cache on error.
   * In offline mode: local cache only.
   */
  async save(
    sessionId: string,
    messages: Array<Record<string, unknown>>,
    options: CreateCheckpointOptions = {}
  ): Promise<Checkpoint> {
    const cp: Checkpoint = {
      checkpointId: generateId('ckpt_'),
      sessionId,
      messages: [...messages],
      activeConfig: options.activeConfig ?? {},
      callCount: options.callCount ?? 0,
      cumulativeCostUsd: options.cumulativeCostUsd ?? 0,
      createdAt: nowIso(),
      label: options.label,
      metadata: options.metadata ?? {},
    };

    // Always put in local cache first (guarantees restore works in same process)
    this._cache.put(cp);

    if (!this._config.offline) {
      try {
        await fetch(`${this._config.backendUrl}/api/v1/checkpoints`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this._config.apiKey}`,
          },
          body: JSON.stringify(cp),
          signal: AbortSignal.timeout(this._config.httpTimeoutMs ?? 10_000),
        });
      } catch {
        // Backend unavailable — local cache is the source of truth for this session
        if (this._config.debug) {
          console.warn(`[Syrin] Could not persist checkpoint ${cp.checkpointId} to backend. Using local cache.`);
        }
      }
    }

    return cp;
  }

  /**
   * Retrieve a checkpoint by ID.
   * Checks local cache first, then fetches from backend.
   */
  async getById(checkpointId: string): Promise<Checkpoint | undefined> {
    // Local cache first (fast path — covers same-process restores)
    const cached = this._cache.getById(checkpointId);
    if (cached) return cached;

    if (this._config.offline) return undefined;

    try {
      const resp = await fetch(
        `${this._config.backendUrl}/api/v1/checkpoints/${encodeURIComponent(checkpointId)}`,
        {
          headers: { 'Authorization': `Bearer ${this._config.apiKey}` },
          signal: AbortSignal.timeout(this._config.httpTimeoutMs ?? 10_000),
        }
      );
      if (!resp.ok) return undefined;
      const data = (await resp.json()) as { ok: boolean; checkpoint?: Checkpoint };
      if (data.checkpoint) {
        this._cache.put(data.checkpoint); // warm local cache
        return data.checkpoint;
      }
    } catch {
      if (this._config.debug) {
        console.warn(`[Syrin] Could not fetch checkpoint ${checkpointId} from backend.`);
      }
    }

    return undefined;
  }

  /**
   * List all checkpoints for a session.
   * Returns local cache (fast, offline-safe). For a full list, fetch from backend.
   */
  listForSession(sessionId: string): Checkpoint[] {
    return this._cache.listForSession(sessionId);
  }

  /**
   * Get the most recent checkpoint for a session from local cache.
   */
  getLatest(sessionId: string): Checkpoint | undefined {
    return this._cache.getLatest(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Backward-compat alias — keep existing code that imports CheckpointManager working
// ---------------------------------------------------------------------------

/**
 * @deprecated Use CheckpointClient instead. CheckpointManager is an in-memory
 * only store kept for backward compatibility. Checkpoints are now persisted on
 * the Syrin backend via CheckpointClient.
 */
export class CheckpointManager {
  private readonly _inner = new InMemoryCheckpointStore();

  create(
    sessionId: string,
    messages: Array<Record<string, unknown>>,
    activeConfig: Record<string, unknown> = {},
    callCount = 0,
    cumulativeCostUsd = 0,
    options: CreateCheckpointOptions = {}
  ): Checkpoint {
    const cp: Checkpoint = {
      checkpointId: generateId('ckpt_'),
      sessionId,
      messages: [...messages],
      activeConfig: { ...activeConfig },
      callCount,
      cumulativeCostUsd,
      createdAt: nowIso(),
      label: options.label,
      metadata: options.metadata ?? {},
    };
    this._inner.put(cp);
    return cp;
  }

  getById(checkpointId: string): Checkpoint | undefined {
    return this._inner.getById(checkpointId);
  }

  getLatest(sessionId: string): Checkpoint | undefined {
    return this._inner.getLatest(sessionId);
  }

  listForSession(sessionId: string): Checkpoint[] {
    return this._inner.listForSession(sessionId);
  }

  delete(checkpointId: string): boolean {
    return this._inner.delete(checkpointId);
  }

  clearSession(sessionId: string): number {
    return this._inner.clearSession(sessionId);
  }
}
