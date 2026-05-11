/**
 * LLM provider name string constants.
 *
 * Used in telemetry payloads, cost calculations, and temperature clamping.
 *
 * @example
 * ```ts
 * import { Provider } from '@/constants/index.js';
 * if (provider === Provider.ANTHROPIC) { maxTemp = 1.0; }
 * ```
 */
export const Provider = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
} as const;

export type ProviderName = typeof Provider[keyof typeof Provider];
