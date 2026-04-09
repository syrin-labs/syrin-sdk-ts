/**
 * Tests: src/config.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConfig, fromEnv } from '../src/config.js';
import type { SyrinConfig } from '../src/types.js';

describe('createConfig', () => {
  const baseOptions = { apiKey: 'syrin_test_key' };

  it('creates a valid config with all required fields present', () => {
    const config = createConfig(baseOptions);

    expect(config.apiKey).toBe('syrin_test_key');
    expect(config.backendUrl).toBeDefined();
    expect(config.otelExporter).toBeDefined();
    expect(config.debug).toBe(false);
    expect(config.captureContent).toBe(false);
    expect(config.offline).toBe(false);
    expect(typeof config.idleFlushMs).toBe('number');
    expect(typeof config.batchSize).toBe('number');
  });

  it('applies defaults for unspecified fields', () => {
    const config = createConfig(baseOptions);

    expect(config.backendUrl).toBe('https://api.syrin.ai');
    expect(config.otelExporter).toBe('none');
    expect(config.otelEndpoint).toBe('http://localhost:4318');
    expect(config.debug).toBe(false);
    expect(config.captureContent).toBe(false);
    expect(config.offline).toBe(false);
    expect(config.idleFlushMs).toBe(10_000);
    expect(config.batchSize).toBe(100);
  });

  it('overrides defaults with provided options', () => {
    const config = createConfig({
      apiKey: 'syrin_test_key',
      debug: true,
      idleFlushMs: 1000,
      batchSize: 10,
      otelExporter: 'console',
      captureContent: true,
      offline: true,
    });

    expect(config.debug).toBe(true);
    expect(config.idleFlushMs).toBe(1000);
    expect(config.batchSize).toBe(10);
    expect(config.otelExporter).toBe('console');
    expect(config.captureContent).toBe(true);
    expect(config.offline).toBe(true);
  });

  it('reads SYRIN_API_KEY from environment', () => {
    process.env['SYRIN_API_KEY'] = 'syrin_from_env';
    try {
      // Don't pass apiKey explicitly — should pick up from env
      const config = createConfig({} as Parameters<typeof createConfig>[0]);
      expect(config.apiKey).toBe('syrin_from_env');
    } finally {
      delete process.env['SYRIN_API_KEY'];
    }
  });

  it('reads SYRIN_BACKEND_URL from environment', () => {
    process.env['SYRIN_BACKEND_URL'] = 'https://custom-backend.example.com';
    try {
      const config = createConfig(baseOptions);
      expect(config.backendUrl).toBe('https://custom-backend.example.com');
    } finally {
      delete process.env['SYRIN_BACKEND_URL'];
    }
  });

  it('throws when backendUrl uses HTTP for a non-local host', () => {
    expect(() =>
      createConfig({ apiKey: 'syrin_test', backendUrl: 'http://custom-backend.example.com' })
    ).toThrow(/backendUrl must use HTTPS/);
  });

  it('allows http://localhost backendUrl', () => {
    expect(() =>
      createConfig({ apiKey: 'syrin_test', backendUrl: 'http://localhost:4318' })
    ).not.toThrow();
  });

  it('allows http://127.0.0.1 backendUrl', () => {
    expect(() =>
      createConfig({ apiKey: 'syrin_test', backendUrl: 'http://127.0.0.1:4318' })
    ).not.toThrow();
  });

  it('reads SYRIN_DEBUG from environment', () => {
    process.env['SYRIN_DEBUG'] = 'true';
    try {
      const config = createConfig(baseOptions);
      expect(config.debug).toBe(true);
    } finally {
      delete process.env['SYRIN_DEBUG'];
    }
  });

  it('throws when apiKey is missing and not in environment', () => {
    delete process.env['SYRIN_API_KEY'];
    expect(() => createConfig({} as Parameters<typeof createConfig>[0])).toThrow(/apiKey/);
  });

  it('throws when otelExporter is invalid', () => {
    expect(() =>
      createConfig({
        apiKey: 'syrin_test',
        otelExporter: 'invalid' as SyrinConfig['otelExporter'],
      })
    ).toThrow(/otelExporter/);
  });

  it('strips trailing slash from backendUrl', () => {
    const config = createConfig({
      apiKey: 'syrin_test',
      backendUrl: 'https://api.syrin.ai/',
    });
    expect(config.backendUrl).toBe('https://api.syrin.ai');
  });

  it('strips multiple trailing slashes from backendUrl', () => {
    const config = createConfig({
      apiKey: 'syrin_test',
      backendUrl: 'https://api.syrin.ai///',
    });
    expect(config.backendUrl).toBe('https://api.syrin.ai');
  });

  it('accepts all valid otelExporter values', () => {
    const valid: SyrinConfig['otelExporter'][] = ['none', 'console', 'otlp'];
    for (const exporter of valid) {
      expect(() =>
        createConfig({ apiKey: 'syrin_test', otelExporter: exporter })
      ).not.toThrow();
    }
  });

  it('allows agentId and sessionId to be set', () => {
    const config = createConfig({
      apiKey: 'syrin_test',
      agentId: 'agent_123',
      sessionId: 'ses_456',
    });
    expect(config.agentId).toBe('agent_123');
    expect(config.sessionId).toBe('ses_456');
  });
});

describe('fromEnv', () => {
  afterEach(() => {
    // Clean up all SYRIN env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SYRIN_')) delete process.env[key];
    }
  });

  it('returns empty object when no SYRIN_ env vars set', () => {
    const result = fromEnv();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('reads SYRIN_OFFLINE=1', () => {
    process.env['SYRIN_OFFLINE'] = '1';
    const result = fromEnv();
    expect(result.offline).toBe(true);
  });

  it('reads SYRIN_IDLE_FLUSH_MS', () => {
    process.env['SYRIN_IDLE_FLUSH_MS'] = '20000';
    const result = fromEnv();
    expect(result.idleFlushMs).toBe(20000);
  });

  it('reads SYRIN_BATCH_SIZE', () => {
    process.env['SYRIN_BATCH_SIZE'] = '25';
    const result = fromEnv();
    expect(result.batchSize).toBe(25);
  });

  it('ignores invalid integer values for SYRIN_BATCH_SIZE', () => {
    process.env['SYRIN_BATCH_SIZE'] = 'not-a-number';
    const result = fromEnv();
    expect(result.batchSize).toBeUndefined();
  });
});
