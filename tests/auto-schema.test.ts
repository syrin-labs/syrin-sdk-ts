import { describe, it, expect } from 'vitest';
import { discoverParams, PARAM_TYPE_MAP, UNIVERSAL_BLOCKLIST } from '@/utils/auto-schema';

describe('discoverParams', () => {
  it('returns an array', () => {
    expect(Array.isArray(discoverParams(['temperature', 'max_tokens']))).toBe(true);
  });

  it('each field has name, type, default', () => {
    for (const f of discoverParams(['temperature', 'max_tokens', 'model'])) {
      expect(f).toHaveProperty('name');
      expect(f).toHaveProperty('type');
      expect(f).toHaveProperty('default');
    }
  });

  it('unknown params are excluded', () => {
    const names = discoverParams(['some_future_weird_param', 'temperature']).map(f => f.name);
    expect(names).not.toContain('some_future_weird_param');
    expect(names).toContain('temperature');
  });

  it('temperature has float type and constraints', () => {
    const [f] = discoverParams(['temperature']);
    expect(f.type).toBe('float');
    expect(f.constraints).toEqual({ ge: 0.0, le: 2.0 });
  });

  it('max_tokens has int type', () => {
    const [f] = discoverParams(['max_tokens']);
    expect(f.type).toBe('int');
  });

  it('model has str type', () => {
    const [f] = discoverParams(['model']);
    expect(f.type).toBe('str');
  });

  it('max_completion_tokens is in the map', () => {
    const [f] = discoverParams(['max_completion_tokens']);
    expect(f).toBeDefined();
    expect(f.type).toBe('int');
  });

  it('reasoning_effort has enum constraint', () => {
    const [f] = discoverParams(['reasoning_effort']);
    expect(f.constraints?.enum).toEqual(['low', 'medium', 'high']);
  });

  it('empty input returns empty array', () => {
    expect(discoverParams([])).toEqual([]);
  });
});

describe('PARAM_TYPE_MAP', () => {
  it('contains core LLM params', () => {
    for (const p of ['temperature', 'model', 'max_tokens', 'top_p']) {
      expect(PARAM_TYPE_MAP).toHaveProperty(p);
    }
  });
});

describe('OpenAI adapter integration', () => {
  // v2: adapters are telemetry-only, configSchema() returns {}
  it('configSchema returns empty object (telemetry-only)', async () => {
    const { OpenAIAdapter } = await import('@/adapters/openai/adapter');
    const schema = new OpenAIAdapter().configSchema();
    expect(schema).toEqual({});
  });

  it('no fields are returned by configSchema (schema declared via cfg() instead)', async () => {
    const { OpenAIAdapter } = await import('@/adapters/openai/adapter');
    const schema = new OpenAIAdapter().configSchema();
    const allNames = Object.values(schema).flatMap(fields => fields.map(f => f.name));
    expect(allNames).toHaveLength(0);
  });
});

