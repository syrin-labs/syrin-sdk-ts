/**
 * Tests: src/utils/helpers.ts
 *
 * Covers: estimateCost, generateId, clampTemperature, isTemperatureUnsupported,
 *         stableHash, hashSystemPrompt, hashToolSet, hashModelConfig,
 *         countMessages, contextSize, detectRefusal, detectProviderFromModel
 */

import { describe, it, expect } from 'vitest';
import {
  estimateCost,
  generateId,
  nowIso,
  clampTemperature,
  isTemperatureUnsupported,
  detectProviderFromModel,
  stableHash,
  hashSystemPrompt,
  hashToolSet,
  hashModelConfig,
  countMessages,
  contextSize,
  detectRefusal,
  PRICING,
} from '@/utils/helpers';

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

describe('estimateCost — known models', () => {
  it('calculates cost for gpt-4o', () => {
    // gpt-4o: input $2.5/1M, output $10/1M
    // 1000 input + 500 output = (1000*2.5 + 500*10) / 1_000_000 = 0.0075
    const cost = estimateCost('gpt-4o', 1000, 500);
    expect(cost).toBeCloseTo(0.0075, 6);
  });

  it('calculates cost for gpt-4o-mini', () => {
    // input $0.15/1M, output $0.6/1M
    const cost = estimateCost('gpt-4o-mini', 1_000_000, 0);
    expect(cost).toBeCloseTo(0.15, 6);
  });

  it('calculates cost for claude-3-5-sonnet-20241022', () => {
    // input $3/1M, output $15/1M
    const cost = estimateCost('claude-3-5-sonnet-20241022', 1000, 1000);
    expect(cost).toBeCloseTo((1000 * 3 + 1000 * 15) / 1_000_000, 9);
  });

  it('calculates cost for o1', () => {
    // input $15/1M, output $60/1M
    const cost = estimateCost('o1', 2000, 500);
    expect(cost).toBeCloseTo((2000 * 15 + 500 * 60) / 1_000_000, 9);
  });

  it('calculates cost for gemini-2.5-pro', () => {
    // input $1.25/1M, output $10/1M
    const cost = estimateCost('gemini-2.5-pro', 500_000, 500_000);
    expect(cost).toBeCloseTo((500_000 * 1.25 + 500_000 * 10) / 1_000_000, 6);
  });

  it('calculates cost for claude-sonnet-4-5', () => {
    const cost = estimateCost('claude-sonnet-4-5', 1000, 0);
    expect(cost).toBeCloseTo(1000 * 3 / 1_000_000, 9);
  });

  it('returns positive cost for claude-opus-4-7', () => {
    const cost = estimateCost('claude-opus-4-7', 1000, 1000);
    expect(cost).toBeGreaterThan(0);
  });

  it('uses fallback pricing for completely unknown model', () => {
    // fallback: input $1/1M, output $3/1M
    const cost = estimateCost('unknown-model-xyz-9999', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(4.0, 6); // 1 + 3
  });

  it('returns 0 cost for 0 tokens', () => {
    expect(estimateCost('gpt-4o', 0, 0)).toBe(0);
  });

  it('partial match — gpt-4o-custom-variant uses gpt-4o pricing', () => {
    const knownCost = estimateCost('gpt-4o', 1000, 1000);
    const cost = estimateCost('gpt-4o-custom-variant', 1000, 1000);
    expect(cost).toBeCloseTo(knownCost, 9);
  });
});

describe('estimateCost — Gemini family prefix matching', () => {
  it('gemini-2.0-flash matches correctly', () => {
    const cost = estimateCost('gemini-2.0-flash', 1_000_000, 0);
    expect(cost).toBeCloseTo(PRICING['gemini-2.0-flash'].input, 6);
  });

  it('gemini-1.5-flash returns positive cost', () => {
    const cost = estimateCost('gemini-1.5-flash', 100_000, 100_000);
    expect(cost).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// generateId
// ---------------------------------------------------------------------------

describe('generateId', () => {
  it('returns a string', () => {
    const id = generateId('evt_');
    expect(typeof id).toBe('string');
  });

  it('starts with the given prefix', () => {
    expect(generateId('ses_')).toMatch(/^ses_/);
    expect(generateId('run_')).toMatch(/^run_/);
    expect(generateId('wf_')).toMatch(/^wf_/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId('id_')));
    expect(ids.size).toBe(100);
  });

  it('works with empty prefix', () => {
    const id = generateId('');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// nowIso
// ---------------------------------------------------------------------------

describe('nowIso', () => {
  it('returns a valid ISO 8601 string', () => {
    const ts = nowIso();
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it('is approximately the current time', () => {
    const before = Date.now();
    const ts = nowIso();
    const after = Date.now();
    const parsed = new Date(ts).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after + 10); // small tolerance
  });
});

// ---------------------------------------------------------------------------
// clampTemperature
// ---------------------------------------------------------------------------

describe('clampTemperature — OpenAI standard (0-2.0)', () => {
  it('passes through values in range', () => {
    expect(clampTemperature(0.7, 'gpt-4o')).toBe(0.7);
    expect(clampTemperature(0.0, 'gpt-4o')).toBe(0);
    expect(clampTemperature(2.0, 'gpt-4o')).toBe(2.0);
  });

  it('clamps values above 2.0 to 2.0', () => {
    expect(clampTemperature(3.0, 'gpt-4o')).toBe(2.0);
    expect(clampTemperature(9.9, 'gpt-4o-mini')).toBe(2.0);
  });

  it('clamps negative values to 0', () => {
    expect(clampTemperature(-0.5, 'gpt-4o')).toBe(0);
  });
});

describe('clampTemperature — Anthropic (0-1.0)', () => {
  it('clamps claude models at 1.0', () => {
    expect(clampTemperature(1.5, 'claude-3-5-sonnet-20241022')).toBe(1.0);
    expect(clampTemperature(2.0, 'claude-sonnet-4-6')).toBe(1.0);
  });

  it('passes through valid values for claude', () => {
    expect(clampTemperature(0.5, 'claude-3-opus-20240229')).toBe(0.5);
    expect(clampTemperature(1.0, 'claude-haiku-4-5')).toBe(1.0);
  });

  it('clamps negative values to 0 for claude', () => {
    expect(clampTemperature(-1, 'claude-3-5-haiku-20241022')).toBe(0);
  });
});

describe('clampTemperature — o1/o3 models (no-op)', () => {
  it('returns value unchanged for o1', () => {
    // o1 does not support temperature — value returned as-is (interceptor should not inject)
    expect(clampTemperature(0.7, 'o1')).toBe(0.7);
    expect(clampTemperature(1.5, 'o1-mini')).toBe(1.5);
    expect(clampTemperature(2.0, 'o3')).toBe(2.0);
    expect(clampTemperature(0.5, 'o3-mini')).toBe(0.5);
  });

  it('returns value unchanged for o1-preview', () => {
    expect(clampTemperature(0.9, 'o1-preview')).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// isTemperatureUnsupported
// ---------------------------------------------------------------------------

describe('isTemperatureUnsupported', () => {
  it('returns true for o1', () => {
    expect(isTemperatureUnsupported('o1')).toBe(true);
  });

  it('returns true for o1-mini', () => {
    expect(isTemperatureUnsupported('o1-mini')).toBe(true);
  });

  it('returns true for o3', () => {
    expect(isTemperatureUnsupported('o3')).toBe(true);
  });

  it('returns true for o3-mini', () => {
    expect(isTemperatureUnsupported('o3-mini')).toBe(true);
  });

  it('returns true for o1 versioned suffix', () => {
    expect(isTemperatureUnsupported('o1-2024-12-17')).toBe(true);
  });

  it('returns false for gpt-4o', () => {
    expect(isTemperatureUnsupported('gpt-4o')).toBe(false);
  });

  it('returns false for claude models', () => {
    expect(isTemperatureUnsupported('claude-3-5-sonnet-20241022')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectProviderFromModel
// ---------------------------------------------------------------------------

describe('detectProviderFromModel', () => {
  it('detects openai from gpt- prefix', () => {
    expect(detectProviderFromModel('gpt-4o')).toBe('openai');
    expect(detectProviderFromModel('gpt-3.5-turbo')).toBe('openai');
  });

  it('detects openai from o1/o3 prefix', () => {
    expect(detectProviderFromModel('o1')).toBe('openai');
    expect(detectProviderFromModel('o3-mini')).toBe('openai');
  });

  it('detects anthropic from claude- prefix', () => {
    expect(detectProviderFromModel('claude-3-5-sonnet-20241022')).toBe('anthropic');
    expect(detectProviderFromModel('claude-sonnet-4-6')).toBe('anthropic');
  });

  it('detects google from gemini- prefix', () => {
    expect(detectProviderFromModel('gemini-2.5-pro')).toBe('google');
    expect(detectProviderFromModel('gemini-1.5-flash')).toBe('google');
  });

  it('detects google from models/gemini prefix', () => {
    expect(detectProviderFromModel('models/gemini-2.0-flash')).toBe('google');
  });

  it('returns unknown for unrecognized model', () => {
    expect(detectProviderFromModel('totally-unknown-model')).toBe('unknown');
  });

  it('detects mistral', () => {
    expect(detectProviderFromModel('mistral-large')).toBe('mistral');
  });
});

// ---------------------------------------------------------------------------
// stableHash
// ---------------------------------------------------------------------------

describe('stableHash', () => {
  it('returns a 16-character hex string', () => {
    const hash = stableHash('hello world');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic (same input → same output)', () => {
    expect(stableHash('test')).toBe(stableHash('test'));
    expect(stableHash('hello')).toBe(stableHash('hello'));
  });

  it('is sensitive to input changes', () => {
    expect(stableHash('hello')).not.toBe(stableHash('Hello'));
    expect(stableHash('abc')).not.toBe(stableHash('abd'));
  });

  it('handles empty string', () => {
    const hash = stableHash('');
    expect(hash).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// hashSystemPrompt
// ---------------------------------------------------------------------------

describe('hashSystemPrompt', () => {
  it('returns undefined when messages is null', () => {
    expect(hashSystemPrompt(null)).toBeUndefined();
  });

  it('returns undefined when no system message', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    expect(hashSystemPrompt(messages)).toBeUndefined();
  });

  it('returns a hash for the system message content', () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hello' },
    ];
    const hash = hashSystemPrompt(messages);
    expect(hash).toBeDefined();
    expect(hash).toHaveLength(16);
  });

  it('is consistent across calls', () => {
    const messages = [{ role: 'system', content: 'same prompt' }];
    expect(hashSystemPrompt(messages)).toBe(hashSystemPrompt(messages));
  });

  it('differs for different system prompts', () => {
    const m1 = [{ role: 'system', content: 'prompt A' }];
    const m2 = [{ role: 'system', content: 'prompt B' }];
    expect(hashSystemPrompt(m1)).not.toBe(hashSystemPrompt(m2));
  });
});

// ---------------------------------------------------------------------------
// hashToolSet
// ---------------------------------------------------------------------------

describe('hashToolSet', () => {
  it('returns undefined for empty array', () => {
    expect(hashToolSet([])).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(hashToolSet(null)).toBeUndefined();
  });

  it('returns a hash for a non-empty tool set', () => {
    const tools = [
      { function: { name: 'search' } },
      { function: { name: 'calculate' } },
    ];
    const hash = hashToolSet(tools);
    expect(hash).toBeDefined();
    expect(hash).toHaveLength(16);
  });

  it('is order-independent (same tools, different order → same hash)', () => {
    const tools1 = [{ function: { name: 'a' } }, { function: { name: 'b' } }];
    const tools2 = [{ function: { name: 'b' } }, { function: { name: 'a' } }];
    expect(hashToolSet(tools1)).toBe(hashToolSet(tools2));
  });

  it('differs for different tool sets', () => {
    const t1 = [{ function: { name: 'search' } }];
    const t2 = [{ function: { name: 'calculate' } }];
    expect(hashToolSet(t1)).not.toBe(hashToolSet(t2));
  });
});

// ---------------------------------------------------------------------------
// hashModelConfig
// ---------------------------------------------------------------------------

describe('hashModelConfig', () => {
  it('returns a 16-char hex hash', () => {
    const hash = hashModelConfig({ model: 'gpt-4o', temperature: 0.7, max_tokens: 1024 });
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic', () => {
    const params = { model: 'gpt-4o', temperature: 0.7, max_tokens: 1024 };
    expect(hashModelConfig(params)).toBe(hashModelConfig(params));
  });

  it('differs when temperature changes', () => {
    const h1 = hashModelConfig({ model: 'gpt-4o', temperature: 0.7 });
    const h2 = hashModelConfig({ model: 'gpt-4o', temperature: 0.3 });
    expect(h1).not.toBe(h2);
  });

  it('handles partial params (undefined fields)', () => {
    const hash = hashModelConfig({});
    expect(hash).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// countMessages
// ---------------------------------------------------------------------------

describe('countMessages', () => {
  it('counts messages by role', () => {
    const messages = [
      { role: 'user' },
      { role: 'assistant' },
      { role: 'user' },
      { role: 'system' },
    ];
    const counts = countMessages(messages);
    expect(counts['user']).toBe(2);
    expect(counts['assistant']).toBe(1);
    expect(counts['system']).toBe(1);
  });

  it('returns empty object for empty array', () => {
    expect(countMessages([])).toEqual({});
  });

  it('handles null/undefined gracefully', () => {
    expect(countMessages(null)).toEqual({});
    expect(countMessages(undefined)).toEqual({});
  });

  it('uses "unknown" for missing role', () => {
    const counts = countMessages([{ role: undefined as unknown as string }]);
    expect(counts['unknown']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// contextSize
// ---------------------------------------------------------------------------

describe('contextSize', () => {
  it('returns 128000 for gpt-4o', () => {
    expect(contextSize('gpt-4o')).toBe(128_000);
  });

  it('returns 200000 for o1', () => {
    expect(contextSize('o1')).toBe(200_000);
  });

  it('returns 2000000 for gemini-1.5-pro', () => {
    expect(contextSize('gemini-1.5-pro')).toBe(2_000_000);
  });

  it('returns 200000 for claude-3-sonnet (prefix match on claude-3)', () => {
    expect(contextSize('claude-3-sonnet-20240229')).toBe(200_000);
  });

  it('returns null for unknown model', () => {
    expect(contextSize('unknown-model-9999')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectRefusal
// ---------------------------------------------------------------------------

describe('detectRefusal', () => {
  it('returns false for null/undefined content', () => {
    expect(detectRefusal(null)).toBe(false);
    expect(detectRefusal(undefined)).toBe(false);
    expect(detectRefusal('')).toBe(false);
  });

  it('returns true for known refusal phrases', () => {
    expect(detectRefusal("I'm sorry, I can't help with that.")).toBe(true);
    expect(detectRefusal('I cannot assist with this request.')).toBe(true);
    expect(detectRefusal("I'm unable to provide that information.")).toBe(true);
    expect(detectRefusal("I can't help with that topic.")).toBe(true);
  });

  it('returns false for normal responses', () => {
    expect(detectRefusal('Sure, here is what you need...')).toBe(false);
    expect(detectRefusal('The answer is 42.')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(detectRefusal("I'M SORRY, I CAN'T")).toBe(true);
  });
});
