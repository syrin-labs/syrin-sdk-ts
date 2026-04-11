/**
 * Tests: src/provider.ts
 *
 * Covers detectProvider() and PROVIDER_URL_MAP.
 */

import { describe, it, expect } from 'vitest';
import { detectProvider, PROVIDER_URL_MAP } from '@/utils/provider';

function clientWithBase(baseUrl: string): unknown {
  return { baseUrl };
}

describe('provider detection', () => {
  it('detects openrouter', () => {
    expect(detectProvider(clientWithBase('https://openrouter.ai/api/v1'))).toBe('openrouter');
  });

  it('detects togetherai', () => {
    expect(detectProvider(clientWithBase('https://api.together.ai/v1'))).toBe('togetherai');
  });

  it('detects groq', () => {
    expect(detectProvider(clientWithBase('https://api.groq.com/openai/v1'))).toBe('groq');
  });

  it('detects fireworks', () => {
    expect(detectProvider(clientWithBase('https://api.fireworks.ai/inference/v1'))).toBe('fireworks');
  });

  it('detects anthropic via openai sdk', () => {
    expect(detectProvider(clientWithBase('https://api.anthropic.com/v1'))).toBe('anthropic');
  });

  it('detects google', () => {
    expect(detectProvider(clientWithBase('https://generativelanguage.googleapis.com/v1beta'))).toBe('google');
  });

  it('detects mistral', () => {
    expect(detectProvider(clientWithBase('https://api.mistral.ai/v1'))).toBe('mistral');
  });

  it('detects cohere', () => {
    expect(detectProvider(clientWithBase('https://api.cohere.com/v1'))).toBe('cohere');
  });

  it('defaults to openai for standard endpoint', () => {
    expect(detectProvider(clientWithBase('https://api.openai.com/v1'))).toBe('openai');
    expect(detectProvider(clientWithBase(''))).toBe('openai');
  });

  it('handles null/undefined baseUrl', () => {
    expect(detectProvider({})).toBe('openai');
    expect(detectProvider({ baseUrl: null })).toBe('openai');
    expect(detectProvider({ baseUrl: undefined })).toBe('openai');
    expect(detectProvider(null)).toBe('openai');
    expect(detectProvider(undefined)).toBe('openai');
  });

  it('is case insensitive', () => {
    expect(detectProvider(clientWithBase('https://API.GROQ.COM/openai/v1'))).toBe('groq');
    expect(detectProvider(clientWithBase('HTTPS://OPENROUTER.AI/api/v1'))).toBe('openrouter');
  });

  it('matches partial URL', () => {
    expect(detectProvider(clientWithBase('https://api.groq.com/v1'))).toBe('groq');
    expect(detectProvider(clientWithBase('https://api.mistral.ai/v1/chat'))).toBe('mistral');
  });

  it('PROVIDER_URL_MAP has at least 8 entries', () => {
    expect(Object.keys(PROVIDER_URL_MAP).length).toBeGreaterThanOrEqual(8);
  });
});
