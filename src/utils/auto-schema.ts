/**
 * Syrin SDK — Auto-Schema
 *
 * Centralised safe-parameter definitions for LLM providers.
 * Adapters import discoverParams() instead of hardcoding their own field lists.
 * Adding a param to PARAM_TYPE_MAP automatically makes it available in all adapters.
 */
import type { SchemaField } from '@/adapters/types.js';

/** Params that should never be exposed for remote configuration. */
export const UNIVERSAL_BLOCKLIST = new Set([
  'apiKey', 'api_key', 'organization', 'baseURL', 'base_url', 'httpClient', 'http_client',
  'defaultHeaders', 'default_headers', 'defaultQuery', 'default_query',
  'extraHeaders', 'extra_headers', 'extraQuery', 'extra_query', 'extraBody', 'extra_body',
  'timeout', 'maxRetries', 'max_retries',
  'messages', 'input', 'prompt',
  'stream', 'streamOptions', 'stream_options',
  'tools', 'toolChoice', 'tool_choice', 'parallelToolCalls', 'parallel_tool_calls',
  'functions', 'functionCall', 'function_call',
  'user', 'store', 'metadata',
  'responseFormat', 'response_format', 'modalities', 'audio', 'prediction',
  'betas',
]);

/** Canonical type and constraint definitions for known-safe params. */
export const PARAM_TYPE_MAP: Record<string, { type: SchemaField['type']; constraints?: SchemaField['constraints'] }> = {
  model:                 { type: 'str' },
  temperature:           { type: 'float', constraints: { ge: 0.0, le: 2.0 } },
  max_tokens:            { type: 'int',   constraints: { ge: 1 } },
  max_completion_tokens: { type: 'int',   constraints: { ge: 1 } },
  top_p:                 { type: 'float', constraints: { ge: 0.0, le: 1.0 } },
  top_k:                 { type: 'int',   constraints: { ge: 0 } },
  frequency_penalty:     { type: 'float', constraints: { ge: -2.0, le: 2.0 } },
  presence_penalty:      { type: 'float', constraints: { ge: -2.0, le: 2.0 } },
  n:                     { type: 'int',   constraints: { ge: 1, le: 10 } },
  seed:                  { type: 'int' },
  logprobs:              { type: 'bool' },
  top_logprobs:          { type: 'int',   constraints: { ge: 0, le: 20 } },
  stop:                  { type: 'str' },
  reasoning_effort:      { type: 'str',   constraints: { enum: ['low', 'medium', 'high'] } },
};

/**
 * Return SchemaField defs for the requested param names.
 * Only names present in PARAM_TYPE_MAP and not in UNIVERSAL_BLOCKLIST are returned.
 */
export function discoverParams(paramNames: string[]): SchemaField[] {
  const result: SchemaField[] = [];
  for (const name of paramNames) {
    if (UNIVERSAL_BLOCKLIST.has(name)) continue;
    const entry = PARAM_TYPE_MAP[name];
    if (!entry) continue;
    const field: SchemaField = { name, type: entry.type, default: null };
    if (entry.constraints) field.constraints = entry.constraints;
    result.push(field);
  }
  return result;
}
