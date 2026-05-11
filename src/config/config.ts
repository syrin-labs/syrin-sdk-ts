/**
 * Syrin SDK — Configuration management.
 *
 * All defaults are sourced from constants/ — never hardcode values here.
 */

import type { SyrinConfig } from '@/types.js';
import {
  DEFAULT_BACKEND_URL,
  DEFAULT_BATCH_SIZE,
  DEFAULT_IDLE_FLUSH_MS,
  SDK_VERSION,
} from '@/constants/index.js';

export { SDK_VERSION };

const DEFAULTS: Omit<SyrinConfig, 'apiKey'> = {
  backendUrl: DEFAULT_BACKEND_URL,
  otelExporter: 'none',
  otelEndpoint: 'http://localhost:4318',
  debug: false,
  captureContent: false,
  offline: false,
  batchSize: DEFAULT_BATCH_SIZE,
  idleFlushMs: DEFAULT_IDLE_FLUSH_MS,
  toolValidation: false,
  sessionTtlMs: undefined,
  // configPollIntervalMs is intentionally NOT in DEFAULTS — it is an
  // internal fallback, not a user-facing option.
  configPollIntervalMs: 0,
};

/** Read config from environment variables. */
export function fromEnv(): Partial<SyrinConfig> {
  const env: Partial<SyrinConfig> = {};

  if (process.env['SYRIN_API_KEY']) {
    env.apiKey = process.env['SYRIN_API_KEY'];
  }
  if (process.env['SYRIN_AGENT_ID']) {
    env.agentId = process.env['SYRIN_AGENT_ID'];
  }
  if (process.env['SYRIN_SESSION_ID']) {
    env.sessionId = process.env['SYRIN_SESSION_ID'];
  }
  if (process.env['SYRIN_BACKEND_URL'] || process.env['SYRIN_URL']) {
    env.backendUrl = (process.env['SYRIN_BACKEND_URL'] ?? process.env['SYRIN_URL'])!;
  }
  if (process.env['SYRIN_OTEL_EXPORTER']) {
    env.otelExporter = process.env['SYRIN_OTEL_EXPORTER'] as SyrinConfig['otelExporter'];
  }
  if (process.env['SYRIN_OTEL_ENDPOINT']) {
    env.otelEndpoint = process.env['SYRIN_OTEL_ENDPOINT'];
  }
  if (process.env['SYRIN_DEBUG']) {
    env.debug = process.env['SYRIN_DEBUG'] === 'true' || process.env['SYRIN_DEBUG'] === '1';
  }
  if (process.env['SYRIN_CAPTURE_CONTENT']) {
    env.captureContent =
      process.env['SYRIN_CAPTURE_CONTENT'] === 'true' ||
      process.env['SYRIN_CAPTURE_CONTENT'] === '1';
  }
  if (process.env['SYRIN_OFFLINE']) {
    env.offline =
      process.env['SYRIN_OFFLINE'] === 'true' || process.env['SYRIN_OFFLINE'] === '1';
  }
  if (process.env['SYRIN_BATCH_SIZE']) {
    const parsed = parseInt(process.env['SYRIN_BATCH_SIZE'], 10);
    if (!isNaN(parsed)) env.batchSize = parsed;
  }
  if (process.env['SYRIN_IDLE_FLUSH_MS']) {
    const parsed = parseInt(process.env['SYRIN_IDLE_FLUSH_MS'], 10);
    if (!isNaN(parsed)) env.idleFlushMs = parsed;
  }
  if (process.env['SYRIN_SESSION_TTL_MS']) {
    const parsed = parseInt(process.env['SYRIN_SESSION_TTL_MS'], 10);
    if (!isNaN(parsed)) env.sessionTtlMs = parsed;
  }

  return env;
}

/**
 * Normalise a backend URL to a clean base URL without `/api/v1` suffix.
 *
 * Accepts both:
 *   - `https://app.syrin.ai`
 *   - `https://app.syrin.ai/api/v1`
 *
 * @throws {Error} If the URL is invalid or uses an insecure protocol.
 */
export function normalizeBackendUrl(url: string): string {
  url = url.trim();

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error(
      `[Syrin SDK] Invalid backendUrl: '${url}' — must include protocol (http:// or https://).`,
    );
  }

  const isLocal =
    url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1');
  if (!url.startsWith('https://') && !isLocal) {
    throw new Error(
      `[Syrin SDK] backendUrl must use HTTPS (got: '${url}'). ` +
      'Use http://localhost or http://127.0.0.1 for local development.',
    );
  }

  // Strip /api/v1 suffix if present
  url = url.replace(/\/api\/v1\/?$/, '');

  // Strip trailing slashes
  url = url.replace(/\/+$/, '');

  return url;
}

/** Merge env vars + user options + defaults into a validated SyrinConfig. */
export function createConfig(
  options: Partial<SyrinConfig> & { apiKey?: string },
): SyrinConfig {
  const envConfig = fromEnv();

  const merged: Partial<SyrinConfig> = {
    ...DEFAULTS,
    ...envConfig,
    ...options,
  };

  if (!merged.apiKey) {
    throw new Error(
      '[Syrin SDK] apiKey is required. Set SYRIN_API_KEY env var or pass apiKey to init().',
    );
  }

  const validExporters = ['none', 'console', 'otlp'];
  if (merged.otelExporter && !validExporters.includes(merged.otelExporter)) {
    throw new Error(
      `[Syrin SDK] Invalid otelExporter: "${merged.otelExporter}". Must be one of: ${validExporters.join(', ')}`,
    );
  }

  // Normalise the backend URL (strip /api/v1, trailing slash, enforce HTTPS)
  if (merged.backendUrl) {
    merged.backendUrl = normalizeBackendUrl(merged.backendUrl);
  }

  return merged as SyrinConfig;
}
