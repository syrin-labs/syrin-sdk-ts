/**
 * Syrin SDK — Provider Detection
 *
 * Detects which AI provider a client is talking to by inspecting the
 * client's base URL. This is used to tag events with the correct provider
 * field and to apply provider-specific rules (e.g. temperature clamping).
 */

// ---------------------------------------------------------------------------
// PROVIDER_URL_MAP — fragment → provider name
// ---------------------------------------------------------------------------

/**
 * Maps URL fragments (substrings to search for, case-insensitively) to
 * canonical provider identifiers.
 *
 * Order matters: the first matching fragment wins.
 */
export const PROVIDER_URL_MAP: Record<string, string> = {
  'openrouter.ai': 'openrouter',
  'together.ai': 'togetherai',
  'api.groq.com': 'groq',
  'api.fireworks.ai': 'fireworks',
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'google',
  'api.mistral.ai': 'mistral',
  'api.cohere.com': 'cohere',
};

// ---------------------------------------------------------------------------
// detectProvider
// ---------------------------------------------------------------------------

/**
 * Infer the provider name from an SDK client object by inspecting its
 * `baseUrl` (or `baseURL`) property.
 *
 * Falls back to `"openai"` when no match is found or the client has no
 * recognisable URL property.
 *
 * @param client  Any SDK client object (typed as `unknown` to avoid coupling).
 * @returns       A canonical provider identifier string.
 */
export function detectProvider(client: unknown): string {
  const raw = (client as Record<string, unknown> | null | undefined);

  // Support both camelCase and lowercase variants
  const baseUrl = raw?.['baseUrl'] ?? raw?.['baseURL'] ?? '';
  const base = String(baseUrl ?? '').toLowerCase();

  for (const [fragment, provider] of Object.entries(PROVIDER_URL_MAP)) {
    if (base.includes(fragment.toLowerCase())) {
      return provider;
    }
  }

  return 'openai';
}
