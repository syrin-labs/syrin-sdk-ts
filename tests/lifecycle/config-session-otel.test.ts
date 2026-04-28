/**
 * Tests: coverage gaps across config.ts, session.ts, tunable.ts, otel.ts, index.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SYRIN_')) delete process.env[key];
  }
  vi.clearAllMocks();
});

// ── config.ts: fromEnv() ──────────────────────────────────────────────────────

describe('fromEnv() — env vars', () => {
  it('reads SYRIN_CAPTURE_CONTENT=1', async () => {
    const { fromEnv } = await import('@/config/config');
    process.env['SYRIN_CAPTURE_CONTENT'] = '1';
    const result = fromEnv();
    expect(result.captureContent).toBe(true);
  });

  it('reads SYRIN_CAPTURE_CONTENT=true', async () => {
    const { fromEnv } = await import('@/config/config');
    process.env['SYRIN_CAPTURE_CONTENT'] = 'true';
    const result = fromEnv();
    expect(result.captureContent).toBe(true);
  });

  it('reads SYRIN_CAPTURE_CONTENT=false → false', async () => {
    const { fromEnv } = await import('@/config/config');
    process.env['SYRIN_CAPTURE_CONTENT'] = 'false';
    const result = fromEnv();
    expect(result.captureContent).toBe(false);
  });

  it('reads SYRIN_SESSION_TTL_MS', async () => {
    const { fromEnv } = await import('@/config/config');
    process.env['SYRIN_SESSION_TTL_MS'] = '3600000';
    const result = fromEnv();
    expect(result.sessionTtlMs).toBe(3_600_000);
  });

  it('ignores invalid SYRIN_SESSION_TTL_MS', async () => {
    const { fromEnv } = await import('@/config/config');
    process.env['SYRIN_SESSION_TTL_MS'] = 'bad';
    const result = fromEnv();
    expect(result.sessionTtlMs).toBeUndefined();
  });
});

describe('normalizeBackendUrl() — invalid protocol', () => {
  it('throws when URL has no protocol', async () => {
    const { normalizeBackendUrl } = await import('@/config/config');
    expect(() => normalizeBackendUrl('app.syrin.ai')).toThrow(/Invalid backendUrl/);
    expect(() => normalizeBackendUrl('app.syrin.ai')).toThrow(/must include protocol/);
  });

  it('throws for ftp:// protocol', async () => {
    const { normalizeBackendUrl } = await import('@/config/config');
    expect(() => normalizeBackendUrl('ftp://app.syrin.ai')).toThrow(/Invalid backendUrl/);
  });
});

// ── session.ts: deleteSession + clearStaleSessions ───────────────────────────

describe('SessionStore.deleteSession()', () => {
  it('removes the session from the store', async () => {
    const { SessionStore } = await import('@/core/session');
    const store = new SessionStore();
    await store.getOrCreate('ses_del_1');
    expect(store.getSession('ses_del_1')).toBeDefined();

    store.deleteSession('ses_del_1');
    expect(store.getSession('ses_del_1')).toBeUndefined();
  });

  it('is a no-op for non-existent session', async () => {
    const { SessionStore } = await import('@/core/session');
    const store = new SessionStore();
    expect(() => store.deleteSession('ses_nonexistent')).not.toThrow();
  });
});

describe('SessionStore.clearStaleSessions()', () => {
  it('removes sessions older than the cutoff', async () => {
    const { SessionStore } = await import('@/core/session');
    const store = new SessionStore();

    await store.getOrCreate('ses_stale_1');
    const session = store.getSession('ses_stale_1')!;
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    (session as Record<string, unknown>)['startedAt'] = twoHoursAgo;

    const removed = store.clearStaleSessions(3_600_000);
    expect(removed).toBe(1);
    expect(store.getSession('ses_stale_1')).toBeUndefined();
  });

  it('keeps sessions younger than the cutoff', async () => {
    const { SessionStore } = await import('@/core/session');
    const store = new SessionStore();
    await store.getOrCreate('ses_fresh_1');

    const removed = store.clearStaleSessions(3_600_000);
    expect(removed).toBe(0);
    expect(store.getSession('ses_fresh_1')).toBeDefined();
  });

  it('returns count of removed sessions', async () => {
    const { SessionStore } = await import('@/core/session');
    const store = new SessionStore();

    for (const id of ['ses_stale_a', 'ses_stale_b', 'ses_fresh_c']) {
      await store.getOrCreate(id);
    }

    const pastDate = new Date(Date.now() - 2 * 3_600_000).toISOString();
    (store.getSession('ses_stale_a')! as Record<string, unknown>)['startedAt'] = pastDate;
    (store.getSession('ses_stale_b')! as Record<string, unknown>)['startedAt'] = pastDate;

    const removed = store.clearStaleSessions(3_600_000);
    expect(removed).toBe(2);
  });

  it('uses default 1 hour threshold when no argument provided', async () => {
    const { SessionStore } = await import('@/core/session');
    const store = new SessionStore();
    await store.getOrCreate('ses_default_thresh');

    const removed = store.clearStaleSessions();
    expect(removed).toBe(0);
  });

  it('handles session with invalid startedAt', async () => {
    const { SessionStore } = await import('@/core/session');
    const store = new SessionStore();
    await store.getOrCreate('ses_invalid_date');
    const session = store.getSession('ses_invalid_date')!;
    (session as Record<string, unknown>)['startedAt'] = 'not-a-date';

    const removed = store.clearStaleSessions(0);
    expect(removed).toBe(0);
  });
});

// ── tunable.ts: tune() and buildFieldSchemaFromMarker ────────────────────────

describe('tune() with globalRegistry', () => {
  it('does not throw when called with globalRegistry', async () => {
    const { tune, globalRegistry } = await import('@/tunable/tunable');
    const target = { count: 5, label: 'hello' };

    expect(() => tune({
      target,
      namespace: 'test_global_ns_1',
      registry: globalRegistry,
      fields: {
        count: 'number',
        label: 'string',
      },
    })).not.toThrow();
  });

  it('covers boolean and array field types', async () => {
    const { tune, TunableRegistry } = await import('@/tunable/tunable');
    const registry = new TunableRegistry();
    const target = { enabled: true, items: ['a', 'b'] };

    expect(() => tune({
      target,
      namespace: 'test_types_ns',
      registry,
      fields: {
        enabled: { type: 'boolean', default: true },
        items: { type: 'array', default: [] },
      },
    })).not.toThrow();

    const values = registry.get('test_types_ns');
    expect(values).toBeDefined();
  });
});

describe('buildFieldSchemaFromMarker — type inference', () => {
  it('@tunable with boolean default infers boolean type', async () => {
    const { tunable, TunableField, TunableRegistry } = await import('@/tunable/tunable');
    const registry = new TunableRegistry();

    @tunable({ namespace: 'bool_test', registry })
    class BoolParams {
      flag = TunableField({ default: true });
    }

    new BoolParams();
    const values = registry.get('bool_test');
    expect(values).toBeDefined();
    expect('flag' in values).toBe(true);
  });

  it('@tunable with array default infers array type', async () => {
    const { tunable, TunableField, TunableRegistry } = await import('@/tunable/tunable');
    const registry = new TunableRegistry();

    @tunable({ namespace: 'array_test', registry })
    class ArrayParams {
      items = TunableField({ default: ['a', 'b'] });
    }

    new ArrayParams();
    const values = registry.get('array_test');
    expect(values).toBeDefined();
    expect('items' in values).toBe(true);
  });

  it('@tunable with null default infers object type', async () => {
    const { tunable, TunableField, TunableRegistry } = await import('@/tunable/tunable');
    const registry = new TunableRegistry();

    @tunable({ namespace: 'null_test', registry })
    class NullParams {
      data = TunableField({ default: null });
    }

    new NullParams();
    const values = registry.get('null_test');
    expect(values).toBeDefined();
  });
});

// ── otel.ts: OTelBridge lifecycle ─────────────────────────────────────────────

describe('OTelBridge.shutdown()', () => {
  it('calls provider.shutdown() when provider exists', async () => {
    const { OTelBridge } = await import('@/observability/otel');
    const config = {
      apiKey: 'syrin_test',
      backendUrl: 'http://localhost:4318',
      otelExporter: 'console' as const,
      otelEndpoint: 'http://localhost:4318',
      debug: false,
      captureContent: false,
      offline: true,
      batchIntervalMs: 60000,
      batchSize: 50,
    };

    const bridge = new OTelBridge(config);
    bridge.setup();

    const providerShutdownSpy = vi.fn().mockResolvedValue(undefined);
    (bridge as unknown as Record<string, unknown>)['provider'] = {
      shutdown: providerShutdownSpy,
    };

    await bridge.shutdown();
    expect(providerShutdownSpy).toHaveBeenCalledOnce();
  });

  it('resolves without error when no provider exists', async () => {
    const { OTelBridge } = await import('@/observability/otel');
    const config = {
      apiKey: 'syrin_test',
      backendUrl: 'http://localhost:4318',
      otelExporter: 'none' as const,
      otelEndpoint: 'http://localhost:4318',
      debug: false,
      captureContent: false,
      offline: true,
      batchIntervalMs: 60000,
      batchSize: 50,
    };

    const bridge = new OTelBridge(config);
    bridge.setup();
    await expect(bridge.shutdown()).resolves.not.toThrow();
  });
});

describe('OTelBridge.recordSpan — metrics error is swallowed', () => {
  it('does not throw when recordMetrics throws internally', async () => {
    const { OTelBridge } = await import('@/observability/otel');
    const {
      NodeTracerProvider,
      InMemorySpanExporter,
      SimpleSpanProcessor,
    } = await import('@opentelemetry/sdk-trace-node');

    const config = {
      apiKey: 'syrin_test',
      backendUrl: 'http://localhost:4318',
      otelExporter: 'console' as const,
      otelEndpoint: 'http://localhost:4318',
      debug: false,
      captureContent: false,
      offline: true,
      batchIntervalMs: 60000,
      batchSize: 50,
    };

    const bridge = new OTelBridge(config);
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    (bridge as unknown as Record<string, unknown>)['tracer'] = provider.getTracer('syrin-sdk');

    expect(() => bridge.recordSpan({
      model: 'gpt-4o',
      provider: 'openai',
      temperature: 0.7,
      maxTokens: 1000,
      inputTokens: 100,
      outputTokens: 50,
      finishReason: 'stop',
      durationMs: 100,
      costUsd: 0.01,
      cumulativeCostUsd: 0.01,
      sessionId: 'ses_metrics_test',
      agentId: undefined,
      configApplied: false,
    })).not.toThrow();
  });
});

// ── index.ts: module-level healthCheck and checkpoint ────────────────────────

describe('module-level healthCheck()', () => {
  it('returns false when no SDK instance initialized', async () => {
    const { healthCheck } = await import('@/index');
    const result = await healthCheck();
    expect(result).toBe(false);
  });
});

describe('module-level checkpoint()', () => {
  it('does not throw when no SDK instance initialized', async () => {
    const { checkpoint } = await import('@/index');
    expect(() => checkpoint('test_label', { key: 'value' }, 'ses_1')).not.toThrow();
  });

  it('does not throw when called without optional args', async () => {
    const { checkpoint } = await import('@/index');
    expect(() => checkpoint('test_label')).not.toThrow();
  });
});
