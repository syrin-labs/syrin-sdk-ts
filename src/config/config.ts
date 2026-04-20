/**
 * Syrin SDK — Configuration management
 */

import type { SyrinSDKConfig } from '@/types.js';

const SDK_VERSION = '1.0.0';

const DEFAULTS: Omit<SyrinSDKConfig, 'apiKey'> = {
  backendUrl: 'https://api.syrin.ai',
  otelExporter: 'none',
  otelEndpoint: 'http://localhost:4318',
  debug: false,
  captureContent: false,
  offline: false,
  batchSize: 100,
  idleFlushMs: 10_000,
  httpTimeoutMs: 10_000,
  heartbeatTimeoutMs: 5_000,
  pollTimeoutMs: 10_000,
  heartbeatIntervalMs: 30_000,
  maxQueueSize: 1000,
  configHistoryMaxlen: 50,
  configAuditMaxlen: 1000,
  toolValidation: false,
  sessionTtlMs: undefined,
  configPollIntervalMs: 0,
};

/** Regex for valid identifiers: alphanumeric, hyphen, underscore, dot, colon, @ */
const IDENTIFIER_RE = /^[\w\-.:@]+$/;

/**
 * Validate that an identifier (agentId or sessionId) meets length and character constraints.
 *
 * @param value - The identifier string to validate.
 * @param fieldName - Human-readable field name for error messages.
 * @throws Error if the identifier is invalid.
 */
function validateIdentifier(value: string, fieldName: string): void {
  if (value.length > 128) {
    throw new Error(`[Syrin] ${fieldName} must be 128 characters or less (got ${value.length})`);
  }
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(
      `[Syrin] ${fieldName} must only contain alphanumeric characters, hyphens, underscores, dots, colons, or @ (got: "${value}")`
    );
  }
}

export function fromEnv(): Partial<SyrinSDKConfig> {
  const env: Partial<SyrinSDKConfig> = {};

  if (process.env['SYRIN_API_KEY']) {
    env.apiKey = process.env['SYRIN_API_KEY'];
  }
  if (process.env['SYRIN_AGENT_ID']) {
    env.agentId = process.env['SYRIN_AGENT_ID'];
  } else if (process.env['SYRIN_NAME']) {
    // Legacy alias — prefer SYRIN_AGENT_ID
    env.agentId = process.env['SYRIN_NAME'];
  }
  if (process.env['SYRIN_SESSION_ID']) {
    env.sessionId = process.env['SYRIN_SESSION_ID'];
  }
  if (process.env['SYRIN_BACKEND_URL']) {
    env.backendUrl = process.env['SYRIN_BACKEND_URL'];
  }
  if (process.env['SYRIN_OTEL_EXPORTER']) {
    env.otelExporter = process.env['SYRIN_OTEL_EXPORTER'] as SyrinSDKConfig['otelExporter'];
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
  if (process.env['SYRIN_CONFIG_POLL_INTERVAL_MS']) {
    const parsed = parseInt(process.env['SYRIN_CONFIG_POLL_INTERVAL_MS'], 10);
    if (!isNaN(parsed)) env.configPollIntervalMs = parsed;
  }
  if (process.env['SYRIN_HTTP_TIMEOUT_MS']) {
    const parsed = parseInt(process.env['SYRIN_HTTP_TIMEOUT_MS'], 10);
    if (!isNaN(parsed)) env.httpTimeoutMs = parsed;
  }
  if (process.env['SYRIN_HEARTBEAT_TIMEOUT_MS']) {
    const parsed = parseInt(process.env['SYRIN_HEARTBEAT_TIMEOUT_MS'], 10);
    if (!isNaN(parsed)) env.heartbeatTimeoutMs = parsed;
  }
  if (process.env['SYRIN_POLL_TIMEOUT_MS']) {
    const parsed = parseInt(process.env['SYRIN_POLL_TIMEOUT_MS'], 10);
    if (!isNaN(parsed)) env.pollTimeoutMs = parsed;
  }
  if (process.env['SYRIN_HEARTBEAT_INTERVAL_MS']) {
    const parsed = parseInt(process.env['SYRIN_HEARTBEAT_INTERVAL_MS'], 10);
    if (!isNaN(parsed)) env.heartbeatIntervalMs = parsed;
  }
  if (process.env['SYRIN_MAX_QUEUE_SIZE']) {
    const parsed = parseInt(process.env['SYRIN_MAX_QUEUE_SIZE'], 10);
    if (!isNaN(parsed)) env.maxQueueSize = parsed;
  }
  if (process.env['SYRIN_CONFIG_HISTORY_MAXLEN']) {
    const parsed = parseInt(process.env['SYRIN_CONFIG_HISTORY_MAXLEN'], 10);
    if (!isNaN(parsed)) env.configHistoryMaxlen = parsed;
  }
  if (process.env['SYRIN_CONFIG_AUDIT_MAXLEN']) {
    const parsed = parseInt(process.env['SYRIN_CONFIG_AUDIT_MAXLEN'], 10);
    if (!isNaN(parsed)) env.configAuditMaxlen = parsed;
  }

  return env;
}

export function createConfig(
  options: Partial<SyrinSDKConfig> & { apiKey?: string }
): SyrinSDKConfig {
  const envConfig = fromEnv();

  const merged: Partial<SyrinSDKConfig> = {
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

  // Validate agentId and sessionId if provided
  if (merged.agentId) {
    validateIdentifier(merged.agentId, 'agentId');
  }
  if (merged.sessionId) {
    validateIdentifier(merged.sessionId, 'sessionId');
  }

  // Validate otelExporter
  const validExporters = ['none', 'console', 'otlp'];
  if (merged.otelExporter && !validExporters.includes(merged.otelExporter)) {
    throw new Error(
      `[Syrin] Invalid otelExporter: "${merged.otelExporter}". Must be one of: ${validExporters.join(', ')}`
    );
  }

  // Warn when captureContent=true (PII risk)
  if (merged.captureContent) {
    console.warn(
      '[Syrin WARNING] captureContent=true: prompts and completions will be transmitted ' +
      'to the Syrin backend. This may include PII. Ensure your DPA covers this data.'
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

  return merged as SyrinSDKConfig;
}

export { SDK_VERSION };
