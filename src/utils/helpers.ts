/**
 * Syrin SDK — Utilities
 */

import { randomUUID } from 'crypto';

/**
 * Pricing per 1M tokens: { input: $/1M, output: $/1M }
 */
export const PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI GPT-4o family
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-2024-11-20': { input: 2.5, output: 10.0 },
  'gpt-4o-2024-08-06': { input: 2.5, output: 10.0 },
  'gpt-4o-2024-05-13': { input: 5.0, output: 15.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.6 },

  // OpenAI GPT-4 family
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gpt-4-turbo-2024-04-09': { input: 10.0, output: 30.0 },
  'gpt-4': { input: 30.0, output: 60.0 },
  'gpt-4-0613': { input: 30.0, output: 60.0 },
  'gpt-4-32k': { input: 60.0, output: 120.0 },

  // OpenAI GPT-3.5
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'gpt-3.5-turbo-0125': { input: 0.5, output: 1.5 },

  // OpenAI o1 family
  'o1': { input: 15.0, output: 60.0 },
  'o1-2024-12-17': { input: 15.0, output: 60.0 },
  'o1-preview': { input: 15.0, output: 60.0 },
  'o1-mini': { input: 3.0, output: 12.0 },
  'o1-mini-2024-09-12': { input: 3.0, output: 12.0 },

  // OpenAI o3 family
  'o3': { input: 10.0, output: 40.0 },
  'o3-mini': { input: 1.1, output: 4.4 },

  // Anthropic Claude 3.5 family (via openai compat)
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-5-sonnet-20240620': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0 },

  // Anthropic Claude 3 family
  'claude-3-opus-20240229': { input: 15.0, output: 75.0 },
  'claude-3-sonnet-20240229': { input: 3.0, output: 15.0 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },

  // Google Gemini (via openai compat)
  'gemini-1.5-pro': { input: 1.25, output: 5.0 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
};

/** Fallback pricing for unknown models */
const FALLBACK_PRICING = { input: 1.0, output: 3.0 };

/**
 * Estimate cost in USD for a given model and token counts.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = findPricing(model);
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

function findPricing(model: string): { input: number; output: number } {
  // Exact match first
  if (PRICING[model]) return PRICING[model];

  // Prefix match (handles versioned models like gpt-4o-2024-xx)
  const lower = model.toLowerCase();
  for (const [key, value] of Object.entries(PRICING)) {
    if (lower.startsWith(key.toLowerCase()) || key.toLowerCase().startsWith(lower)) {
      return value;
    }
  }

  // Partial match for families
  if (lower.includes('gpt-4o-mini')) return PRICING['gpt-4o-mini'];
  if (lower.includes('gpt-4o')) return PRICING['gpt-4o'];
  if (lower.includes('gpt-4-turbo')) return PRICING['gpt-4-turbo'];
  if (lower.includes('gpt-4')) return PRICING['gpt-4'];
  if (lower.includes('gpt-3.5')) return PRICING['gpt-3.5-turbo'];
  if (lower.includes('o1-mini')) return PRICING['o1-mini'];
  if (lower.includes('o1')) return PRICING['o1'];
  if (lower.includes('o3-mini')) return PRICING['o3-mini'];
  if (lower.includes('o3')) return PRICING['o3'];
  if (lower.includes('claude-3-5-sonnet')) return PRICING['claude-3-5-sonnet-20241022'];
  if (lower.includes('claude-3-5-haiku')) return PRICING['claude-3-5-haiku-20241022'];
  if (lower.includes('claude-3-opus')) return PRICING['claude-3-opus-20240229'];
  if (lower.includes('claude-3-sonnet')) return PRICING['claude-3-sonnet-20240229'];
  if (lower.includes('claude-3-haiku')) return PRICING['claude-3-haiku-20240307'];
  if (lower.includes('gemini-1.5-pro')) return PRICING['gemini-1.5-pro'];
  if (lower.includes('gemini-1.5-flash')) return PRICING['gemini-1.5-flash'];
  if (lower.includes('gemini')) return PRICING['gemini-2.0-flash'];

  return FALLBACK_PRICING;
}

const O1_O3_MODELS = ['o1', 'o1-preview', 'o1-mini', 'o3', 'o3-mini'];
const ANTHROPIC_MAX_TEMPERATURE = 1.0;

/**
 * Clamp temperature to valid range for a model.
 * o1/o3 models do not support temperature.
 * Anthropic models: 0-1.0.
 * OpenAI standard: 0-2.0.
 */
export function clampTemperature(value: number, model: string): number {
  const lower = model.toLowerCase();

  // o1/o3 don't support temperature — return as-is, interceptor should not inject
  if (O1_O3_MODELS.some((m) => lower === m || lower.startsWith(m + '-'))) {
    return value;
  }

  // Anthropic models via openai compat
  if (lower.startsWith('claude-')) {
    return Math.max(0, Math.min(ANTHROPIC_MAX_TEMPERATURE, value));
  }

  // Standard OpenAI: 0-2.0
  return Math.max(0, Math.min(2.0, value));
}

/**
 * Returns true if the given model does NOT support temperature parameter.
 */
export function isTemperatureUnsupported(model: string): boolean {
  const lower = model.toLowerCase();
  return O1_O3_MODELS.some((m) => lower === m || lower.startsWith(m + '-'));
}

/**
 * Detect the AI provider from a model name.
 */
export function detectProviderFromModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.startsWith('claude-')) return 'anthropic';
  if (lower.startsWith('gemini-') || lower.startsWith('models/gemini')) return 'google';
  if (lower.startsWith('mistral') || lower.startsWith('open-mixtral')) return 'mistral';
  if (lower.startsWith('llama')) return 'meta';
  if (lower.startsWith('command')) return 'cohere';
  if (
    lower.startsWith('gpt-') ||
    lower.startsWith('o1') ||
    lower.startsWith('o3') ||
    lower.startsWith('text-') ||
    lower.startsWith('davinci') ||
    lower.startsWith('babbage') ||
    lower.startsWith('curie') ||
    lower.startsWith('ada')
  ) {
    return 'openai';
  }
  return 'unknown';
}

/**
 * Generate a unique ID with a prefix.
 * e.g. generateId("ses_") => "ses_550e8400-e29b-41d4-a716-446655440000"
 */
export function generateId(prefix: string): string {
  return `${prefix}${randomUUID()}`;
}

/**
 * Return current UTC time as ISO 8601 string.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Rich telemetry helpers
// ---------------------------------------------------------------------------

import { createHash } from 'crypto';

const CONTEXT_SIZES: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-3.5-turbo': 16_385,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o3': 200_000,
  'o3-mini': 128_000,
};

const REFUSAL_PHRASES = [
  "i'm sorry, i can't",
  'i cannot assist',
  "i'm unable to",
  "i can't help with",
  "i won't be able to",
  'i apologize, but i',
  'as an ai, i cannot',
  "i'm not able to",
];

/** Return the first 16 hex chars of SHA-256(text). */
export function stableHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Hash the system message content, or undefined if absent. */
export function hashSystemPrompt(
  messages: Array<{ role?: string; content?: unknown }> | null | undefined
): string | undefined {
  if (!messages) return undefined;
  for (const m of messages) {
    if (m.role === 'system') return stableHash(String(m.content ?? ''));
  }
  return undefined;
}

/** Hash the set of tool names (order-independent). */
export function hashToolSet(
  tools: Array<Record<string, unknown>> | null | undefined
): string | undefined {
  if (!tools || tools.length === 0) return undefined;
  const names = tools
    .map((t) => ((t as { function?: { name?: string } })?.function?.name) ?? '')
    .sort();
  return stableHash(JSON.stringify(names));
}

/** Hash model + temperature + max_tokens for mutation detection. */
export function hashModelConfig(params: {
  model?: string;
  temperature?: number;
  max_tokens?: number;
}): string {
  return stableHash(JSON.stringify({
    model: params.model ?? null,
    temperature: params.temperature ?? null,
    max_tokens: params.max_tokens ?? null,
  }));
}

/** Count messages per role. */
export function countMessages(
  messages: Array<{ role?: string }> | null | undefined
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of messages ?? []) {
    const role = m.role ?? 'unknown';
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

/** Return context window size for a model, or null. */
export function contextSize(model: string): number | null {
  const lower = model.toLowerCase();
  for (const [key, size] of Object.entries(CONTEXT_SIZES)) {
    if (lower.startsWith(key)) return size;
  }
  return null;
}

/** Return true if the response content looks like a refusal. */
export function detectRefusal(content: string | null | undefined): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  return REFUSAL_PHRASES.some((phrase) => lower.includes(phrase));
}
