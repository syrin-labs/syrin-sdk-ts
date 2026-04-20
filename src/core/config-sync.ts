/**
 * Config Sync — Fetches and applies remote config overrides from the backend.
 *
 * On startup, fetches pending config overrides and applies them via CallInterceptor.
 * Optionally polls for updates and re-applies when changes arrive.
 *
 * The backend serves config overrides via:
 *   GET /agents/:agent_id/overrides (poll endpoint)
 *   GET /agents/:agent_id/stream (SSE stream with config_update events)
 */

import { getCallInterceptor } from '@/control/call-interceptor.js';
import { getLogger } from '@/observability/logger.js';
import type { CompleteControlConfig } from '@/control/complete-control-schema.js';
import type { ConfigStore } from '@/config/store.js';
import type { SessionStore } from '@/core/session.js';

export interface ConfigSyncOptions {
  agentId: string | undefined;
  backendUrl: string;
  apiKey: string;
  offline: boolean;
  pollIntervalMs?: number;
  /**
   * ConfigStore instance to update when remote config is fetched.
   * Framework adapters (LangChain, LangGraph, etc.) read from ConfigStore via
   * adapter.getConfig(namespace), so it must be kept in sync with remote overrides.
   */
  configStore?: ConfigStore;
  /**
   * SessionStore instance to update when remote config is fetched.
   * engine.beforeCall() reads effectiveConfig from SessionStore, so this ensures
   * Tier-1 adapters (OpenAI, Anthropic) apply the polled config immediately.
   */
  sessionStore?: SessionStore;
  /**
   * Session ID to target when updating the SessionStore.
   * Defaults to the primary session if not provided.
   */
  sessionId?: string;
}

export class ConfigSync {
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly _opts: ConfigSyncOptions;
  private _lastKnownConfig: Record<string, unknown> = {};

  constructor(opts: ConfigSyncOptions) {
    this._opts = opts;
  }

  /**
   * Fetch and apply config overrides on startup.
   * Called immediately after creating ConfigSync.
   */
  async initialize(): Promise<void> {
    if (this._opts.offline || !this._opts.agentId) {
      return;
    }

    const logger = getLogger();
    try {
      const config = await this._fetchConfig();
      if (config && Object.keys(config).length > 0) {
        this._applyConfig(config);
        logger.info('Config sync: applied startup overrides', { agentId: this._opts.agentId }, {
          configKeys: Object.keys(config),
        });
      }
    } catch (err) {
      logger.warn('Config sync: failed to fetch startup config', { agentId: this._opts.agentId }, { error: String(err) });
    }
  }

  /**
   * Start polling for config updates.
   * Called after initialize() if polling is enabled.
   */
  startPolling(intervalMs: number = 30_000): void {
    if (this._opts.offline || !this._opts.agentId || intervalMs <= 0) {
      return;
    }

    const logger = getLogger();
    this._pollTimer = setInterval(() => {
      this._pollOnce().catch((err) => {
        logger.warn('Config sync: polling failed', { agentId: this._opts.agentId }, { error: String(err) });
      });
    }, intervalMs);

    // Don't keep the process alive just for polling
    if (this._pollTimer.unref) {
      this._pollTimer.unref();
    }

    logger.debug('Config sync: polling started', { agentId: this._opts.agentId }, { intervalMs });
  }

  /**
   * Stop polling for config updates.
   */
  stopPolling(): void {
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Single poll cycle — fetch and apply if changed.
   */
  private async _pollOnce(): Promise<void> {
    const config = await this._fetchConfig();
    if (!config) return;

    // Only apply if config has changed
    const configKey = JSON.stringify(config);
    const lastKey = JSON.stringify(this._lastKnownConfig);
    if (configKey === lastKey) {
      return;
    }

    this._applyConfig(config);
    const logger = getLogger();
    logger.debug('Config sync: config updated from polling', { agentId: this._opts.agentId }, {
      configKeys: Object.keys(config),
    });
  }

  /**
   * Fetch config overrides from backend.
   */
  private async _fetchConfig(): Promise<Record<string, unknown> | null> {
    if (!this._opts.agentId) return null;

    try {
      const resp = await fetch(`${this._opts.backendUrl}/api/v1/agents/${this._opts.agentId}/overrides`, {
        headers: { Authorization: `Bearer ${this._opts.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });

      if (resp.ok) {
        const data = (await resp.json()) as { ok: boolean; overrides: Record<string, unknown> };
        if (data.ok && data.overrides) {
          return data.overrides;
        }
      }
    } catch {
      // Non-fatal — fetch failures don't crash the SDK
    }

    return null;
  }

  /**
   * Apply config overrides to all three consumers:
   *   1. CallInterceptor — governance / hard limits (existing)
   *   2. ConfigStore    — framework adapters (LangChain _buildConfig, etc.)
   *   3. SessionStore   — engine.beforeCall() effectiveConfig for Tier-1 adapters
   */
  private _applyConfig(config: Record<string, unknown>): void {
    this._lastKnownConfig = config;

    // 1. CallInterceptor — governance / parameter hard-limits
    const interceptor = getCallInterceptor();
    try {
      interceptor.setConfig(config as Partial<CompleteControlConfig>);
    } catch (err) {
      const logger = getLogger();
      logger.warn('Config sync: failed to apply config to interceptor', { agentId: this._opts.agentId }, { error: String(err) });
    }

    // 2. ConfigStore — framework adapters read config via adapter.getConfig(namespace)
    if (this._opts.configStore) {
      try {
        this._opts.configStore.applyUpdates(config, 'remote');
      } catch (err) {
        const logger = getLogger();
        logger.warn('Config sync: failed to apply config to ConfigStore', { agentId: this._opts.agentId }, { error: String(err) });
      }
    }

    // 3. SessionStore — engine.beforeCall() reads sessionStore.getEffectiveConfig()
    if (this._opts.sessionStore && this._opts.sessionId) {
      try {
        this._opts.sessionStore.applyConfigUpdate(this._opts.sessionId, config);
      } catch (err) {
        const logger = getLogger();
        logger.warn('Config sync: failed to apply config to SessionStore', { agentId: this._opts.agentId }, { error: String(err) });
      }
    }
  }
}
