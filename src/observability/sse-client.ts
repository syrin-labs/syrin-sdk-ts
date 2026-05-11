/**
 * Syrin SDK — SSE client for real-time config delivery.
 *
 * Connects to `GET /agents/{id}/stream` and handles:
 *   - `config_update` → applies config changes to all active sessions
 *   - `agent_status`  → debug logging
 *
 * Reconnect strategy:
 *   Exponential back-off up to SSE_MAX_RECONNECT_ATTEMPTS, then falls back
 *   to polling. The SDK always prefers SSE for lower latency and lower backend
 *   load.
 *
 * Why SSE instead of polling:
 *   Operator dashboard changes reach the agent in milliseconds rather than up
 *   to `configPollIntervalMs` seconds. SSE also reduces backend load.
 */

import type { SyrinConfig } from '@/types.js';
import type { SessionStore } from '@/core/session.js';
import {
  SSE_MAX_RECONNECT_ATTEMPTS,
  SSE_RECONNECT_BACKOFF_BASE_MS,
  SSE_RECONNECT_BACKOFF_MAX_MS,
  SSEEventName,
  agentStreamUrl,
} from '@/constants/index.js';
import { fireConfigChange } from '@/observability/hooks.js';

interface SSEFrame {
  event: string;
  data: string;
}

/** Parse a raw SSE text body into discrete event frames. */
function parseSSEFrames(text: string): SSEFrame[] {
  const frames: SSEFrame[] = [];
  const rawEvents = text.split(/\n\n/);

  for (const rawEvent of rawEvents) {
    if (!rawEvent.trim()) continue;

    let event = 'message';
    let data = '';

    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data += (data ? '\n' : '') + line.slice(5).trim();
      } else if (line.startsWith(':')) {
        // Comment / heartbeat — ignore
      }
    }

    if (data) {
      frames.push({ event, data });
    }
  }

  return frames;
}

export class SSEClient {
  private config: SyrinConfig;
  private sessionStore: SessionStore;
  private onConfigUpdate?: (updates: Record<string, unknown>) => void;
  private onFallbackToPolling?: () => void;
  private stopped = false;
  private connected = false;
  private abortController: AbortController | null = null;

  constructor(
    config: SyrinConfig,
    sessionStore: SessionStore,
    options?: {
      onConfigUpdate?: (updates: Record<string, unknown>) => void;
      onFallbackToPolling?: () => void;
    },
  ) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.onConfigUpdate = options?.onConfigUpdate;
    this.onFallbackToPolling = options?.onFallbackToPolling;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Start the SSE client.
   *
   * No-op when:
   * - `offline=true`
   * - No `agentId` is configured (SSE requires a named agent)
   * - Already started
   */
  start(): void {
    if (this.config.offline || !this.config.agentId) {
      if (this.config.debug && !this.config.agentId) {
        console.debug('[Syrin SDK] SSE: no agentId configured — SSE disabled (using polling fallback)');
      }
      this.onFallbackToPolling?.();
      return;
    }

    this.stopped = false;
    void this._runReconnectLoop();
  }

  /** Stop the SSE connection. */
  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async _runReconnectLoop(): Promise<void> {
    const agentId = this.config.agentId!;
    const url = agentStreamUrl(this.config.backendUrl, agentId);

    let attempts = 0;
    let backoff = SSE_RECONNECT_BACKOFF_BASE_MS;

    while (!this.stopped) {
      try {
        await this._connect(url);
        // Successful connection (stream ended normally — server closed it)
        attempts = 0;
        backoff = SSE_RECONNECT_BACKOFF_BASE_MS;
      } catch (err) {
        this.connected = false;
        attempts++;

        if (attempts >= SSE_MAX_RECONNECT_ATTEMPTS) {
          console.warn(
            `[Syrin SDK] SSE: exhausted ${SSE_MAX_RECONNECT_ATTEMPTS} reconnect attempts — ` +
            `falling back to polling. Last error: ${String(err)}`,
          );
          this.onFallbackToPolling?.();
          return;
        }

        const sleepMs = Math.min(backoff, SSE_RECONNECT_BACKOFF_MAX_MS);
        if (this.config.debug) {
          console.debug(
            `[Syrin SDK] SSE: reconnect attempt ${attempts}/${SSE_MAX_RECONNECT_ATTEMPTS} ` +
            `in ${sleepMs}ms (error: ${String(err)})`,
          );
        }

        await this._sleep(sleepMs);
        backoff = Math.min(backoff * 2, SSE_RECONNECT_BACKOFF_MAX_MS);
      }
    }
  }

  private async _connect(url: string): Promise<void> {
    this.abortController = new AbortController();

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      signal: this.abortController.signal,
    });

    if (response.status === 401) {
      throw new Error('SSE auth failed (401) — check API key');
    }
    if (response.status === 404) {
      throw new Error('Agent not registered (404) — retrying');
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error('No response body (SSE stream unavailable)');
    }

    this.connected = true;
    if (this.config.debug) {
      console.debug(`[Syrin SDK] SSE: connected to ${url}`);
    }

    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!this.stopped) {
        const chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });

        // Process complete events (terminated by double newline)
        const parts = buffer.split('\n\n');
        // Keep the last (incomplete) part in the buffer
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (part.trim()) {
            for (const frame of parseSSEFrames(part + '\n\n')) {
              this._dispatch(frame);
            }
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* ignore */ });
      this.connected = false;
    }
  }

  private _dispatch(frame: SSEFrame): void {
    if (frame.event === SSEEventName.CONFIG_UPDATE) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        if (this.config.debug) {
          console.debug('[Syrin SDK] SSE: could not parse config_update JSON:', frame.data.slice(0, 200));
        }
        return;
      }

      if (typeof payload !== 'object' || payload === null) return;

      if (this.config.debug) {
        console.debug('[Syrin SDK] SSE: config_update received:', Object.keys(payload));
      }

      // Apply to all active sessions
      for (const sessionId of this.sessionStore.getSessionIds()) {
        this.sessionStore.applyConfigUpdate(sessionId, payload);
        fireConfigChange(sessionId, payload);
      }

      this.onConfigUpdate?.(payload);

    } else if (frame.event === SSEEventName.AGENT_STATUS) {
      if (this.config.debug) {
        try {
          const payload: unknown = JSON.parse(frame.data);
          console.debug('[Syrin SDK] SSE: agent_status received:', payload);
        } catch { /* ignore */ }
      }
    } else if (frame.event === SSEEventName.EVENTS_INGESTED) {
      // Notification only — no action needed from SDK side
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
