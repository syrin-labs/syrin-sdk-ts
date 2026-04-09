/**
 * Syrin SDK — Configuration management
 */

import type { SyrinConfig } from '@/types';

const SDK_VERSION = '0.1.0';

const DEFAULTS: Omit<SyrinConfig, 'apiKey'> = {
  backendUrl: 'https://api.syrin.ai',
  otelExporter: 'none',
  otelEndpoint: 'http://localhost:4318',
  debug: false,
  captureContent: false,
  offline: false,
  batchSize: 100,
  idleFlushMs: 10_000,
  toolValidation: false,
  sessionTtlMs: undefined,
};

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
  if (process.env['SYRIN_BACKEND_URL']) {
    env.backendUrl = process.env['SYRIN_BACKEND_URL'];
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
  if (process.env['SYRIN_TOOL_VALIDATION']) {
    env.toolValidation =
      process.env['SYRIN_TOOL_VALIDATION'] === 'true' ||
      process.env['SYRIN_TOOL_VALIDATION'] === '1';
  }
  if (process.env['SYRIN_SESSION_TTL_MS']) {
    const parsed = parseInt(process.env['SYRIN_SESSION_TTL_MS'], 10);
    if (!isNaN(parsed)) env.sessionTtlMs = parsed;
  }

  return env;
}

export function createConfig(
  options: Partial<SyrinConfig> & { apiKey?: string }
): SyrinConfig {
  const envConfig = fromEnv();

  const merged: Partial<SyrinConfig> = {
    ...DEFAULTS,
    ...envConfig,
    ...options,
  };

  // Validate apiKey
  if (!merged.apiKey) {
    throw new Error(
      '[Syrin] apiKey is required. Set SYRIN_API_KEY env var or pass apiKey to init().'
    );
  }

  // Validate otelExporter
  const validExporters = ['none', 'console', 'otlp'];
  if (merged.otelExporter && !validExporters.includes(merged.otelExporter)) {
    throw new Error(
      `[Syrin] Invalid otelExporter: "${merged.otelExporter}". Must be one of: ${validExporters.join(', ')}`
    );
  }

  // Strip trailing slash from backendUrl
  if (merged.backendUrl) {
    merged.backendUrl = merged.backendUrl.replace(/\/+$/, '');
  }

  // Enforce HTTPS for non-local backends
  const resolvedUrl = merged.backendUrl ?? '';
  const isLocal =
    resolvedUrl.startsWith('http://localhost') ||
    resolvedUrl.startsWith('http://127.0.0.1');
  if (!resolvedUrl.startsWith('https://') && !isLocal) {
    throw new Error(
      `[Syrin] backendUrl must use HTTPS (got: "${resolvedUrl}"). ` +
      'Use http://localhost or http://127.0.0.1 for local development.'
    );
  }

  return merged as SyrinConfig;
}

export { SDK_VERSION };
