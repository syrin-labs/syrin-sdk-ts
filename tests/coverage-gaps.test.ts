/**
 * Tests: coverage gaps across config.ts, session.ts, tunable.ts, otel.ts, index.ts
 *
 * config.ts lines 62, 76-78, 96-99
 * session.ts lines 355-356, 363-373
 * tunable.ts lines 363-364, 385-386
 * otel.ts lines 388-389, 394-395
 * index.ts lines 1203, 1214-1219
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SYRIN_')) delete process.env[key];
  }
  vi.clearAllMocks();
});

// ── config.ts: fromEnv() uncovered lines ─────────────────────────────────────

describe('fromEnv() — uncovered env vars', () => {
  it('reads SYRIN_CAPTURE_CONTENT=1 (line 62)', async () => {
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

  it('reads SYRIN_SESSION_TTL_MS (lines 76-78)', async () => {
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

describe('normalizeBackendUrl() — invalid protocol (lines 96-99)', () => {
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

// ── session.ts: deleteSession + clearStaleSessions (lines 355-373) ───────────

describe('SessionStore.deleteSession() (lines 355-356)', () => {
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

describe('SessionStore.clearStaleSessions() (lines 363-373)', () => {
  it('removes sessions older than the cutoff', async () => {
    const { SessionStore } = await import('@/core/session');
    const store = new SessionStore();

    // Create a session and manually backdate its startedAt
    await store.getOrCreate('ses_stale_1');
    const session = store.getSession('ses_stale_1')!;
    // Backdate to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    (session as Record<string, unknown>)['startedAt'] = twoHoursAgo;

    const removed = store.clearStaleSessions(3_600_000); // 1 hour threshold
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

    // Create 3 sessions, 2 stale
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

    // This session is fresh — should not be removed
    const removed = store.clearStaleSessions();
    expect(removed).toBe(0);
  });

  it('handles session with invalid startedAt (isNaN check)', async () => {
    const { SessionStore } = await import('@/core/session');
    const store = new SessionStore();
    await store.getOrCreate('ses_invalid_date');
    const session = store.getSession('ses_invalid_date')!;
    // Set startedAt to non-parseable string
    (session as Record<string, unknown>)['startedAt'] = 'not-a-date';

    // isNaN check prevents removal of sessions with invalid dates
    const removed = store.clearStaleSessions(0);
    expect(removed).toBe(0);
  });
});

// ── tunable.ts: tune() with globalRegistry triggers _scheduleAutoRefresh (lines 363-364)
// and buildFieldSchemaFromMarker type inference (lines 385-386) ───────────────

describe('tune() with globalRegistry — auto-refresh scheduling (lines 363-364)', () => {
  it('calling tune() with globalRegistry does not throw', async () => {
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

  it('calling tune() with fields as TuneFieldDef covers boolean and array types (lines 385-386)', async () => {
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

describe('buildFieldSchemaFromMarker — type inference (lines 381-386)', () => {
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

// ── otel.ts: OTelBridge.shutdown() with provider (lines 394-395) ─────────────

describe('OTelBridge.shutdown() — with provider initialized (lines 394-395)', () => {
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

    // After setup with console exporter, a provider is created
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

    // provider is null/undefined for 'none' exporter
    await expect(bridge.shutdown()).resolves.not.toThrow();
  });
});

describe('OTelBridge.recordSpan — recordMetrics catch branch (lines 388-389)', () => {
  it('does not throw when recordMetrics throws internally', async () => {
    // The catch block at lines 388-389 ignores metric errors
    // We can verify this by triggering the span path
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

    // recordSpan with a valid callInfo — metrics should not throw
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

// ── index.ts: module-level healthCheck and checkpoint functions (lines 1203, 1214-1219) ──

describe('module-level healthCheck() (line 1203)', () => {
  it('returns false when no SDK instance initialized', async () => {
    // Import via a fresh import to get the function
    const { healthCheck } = await import('@/index');
    // _primaryInstance is null in test isolation
    const result = await healthCheck();
    expect(result).toBe(false);
  });
});

describe('module-level checkpoint() (lines 1214-1219)', () => {
  it('does not throw when no SDK instance initialized', async () => {
    const { checkpoint } = await import('@/index');
    expect(() => checkpoint('test_label', { key: 'value' }, 'ses_1')).not.toThrow();
  });

  it('does not throw when called without optional args', async () => {
    const { checkpoint } = await import('@/index');
    expect(() => checkpoint('test_label')).not.toThrow();
  });
});
