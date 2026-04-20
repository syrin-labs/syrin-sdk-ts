/**
 * Heartbeat — keeps agent lastSeen fresh and signals graceful shutdown.
 * Parity with Python SDK's heartbeat thread in _sdk.py.
 */

export interface HeartbeatOptions {
  agentId: string | undefined;
  backendUrl: string;
  apiKey: string;
  offline: boolean;
  intervalMs: number;
  debug?: boolean;
}

export class Heartbeat {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private readonly _opts: HeartbeatOptions;

  constructor(opts: HeartbeatOptions) {
    this._opts = opts;
  }

  start(): void {
    if (this._opts.offline || !this._opts.agentId) return;

    this._timer = setInterval(() => {
      this._send(false).catch(() => {});
    }, this._opts.intervalMs);

    // Don't keep the process alive just for heartbeats
    if (this._timer.unref) this._timer.unref();
  }

  async stop(): Promise<void> {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._opts.offline || !this._opts.agentId) return;
    await this._send(true);
  }

  private async _send(stopped: boolean): Promise<void> {
    const { agentId, backendUrl, apiKey } = this._opts;
    if (!agentId) return;
    try {
      const resp = await fetch(`${backendUrl}/api/v1/agents/${agentId}/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ stopped }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok && this._opts.debug) {
        console.warn(`[Syrin] Heartbeat received non-2xx response: ${resp.status}`);
      }
    } catch (err) {
      if (this._opts.debug) {
        const raw = err instanceof Error ? err.message : String(err);
        const safe = raw.replaceAll(apiKey, '****');
        console.warn(`[Syrin] Heartbeat error: ${safe}`);
      }
    }
  }
}
