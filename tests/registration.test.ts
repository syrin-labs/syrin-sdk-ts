/**
 * Tests: SyrinCore.buildSchema() + SyrinCore.register()
 *
 * Covers:
 *  1. buildSchema returns llm and prompt sections (always present)
 *  2. buildSchema llm section contains model, temperature, max_tokens fields
 *  3. buildSchema prompt section contains system_prompt field
 *  4. buildSchema all built-in llm fields have null defaults
 *  5. register POSTs to correct URL with schema in body
 *  6. register applies configDelta to ConfigStore
 *  7. register with no agentId is a no-op (no fetch call)
 *  8. register when fetch throws does not propagate the error
 *  9. register is called during init()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyrinCore } from '@/core/engine';
import { ConfigStore } from '@/config/store';
import type { ICallTarget, SchemaField } from '@/core/call-types';
import type { SyrinConfig } from '@/types';

// ---------------------------------------------------------------------------
// Mock openai for tests that trigger init()
// ---------------------------------------------------------------------------

vi.mock('openai', () => {
  class MockCompletions {}
  (MockCompletions.prototype as Record<string, unknown>)['create'] = vi.fn();
  class MockChat {
    completions = new MockCompletions();
  }
  class MockOpenAI {
    chat = new MockChat();
    constructor(_opts?: unknown) {}
  }
  return { default: MockOpenAI };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4399',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4318',
    debug: false,
    captureContent: false,
    offline: true,
    batchSize: 50,
    idleFlushMs: 60000,
    toolValidation: false,
    agentId: 'test-agent',
    sessionId: 'ses_test',
    ...overrides,
  };
}

function makeCore(configOverrides: Partial<SyrinConfig> = {}): {
  core: SyrinCore & { _configStore: ConfigStore };
  configStore: ConfigStore;
} {
  const config = makeConfig(configOverrides);
  const sessionStore = {
    getOrCreate: vi.fn().mockResolvedValue({ callCount: 0, cumulativeCostUsd: 0, callIndex: 0 }),
    popGovernanceActions: vi.fn().mockReturnValue([]),
    popInjectedMessages: vi.fn().mockReturnValue([]),
    getEffectiveConfig: vi.fn().mockReturnValue({}),
    recordCall: vi.fn(),
    incrementCallIndex: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    setLocalConfig: vi.fn(),
    getToolValidation: vi.fn(),
    deleteSession: vi.fn(),
    clearStaleSessions: vi.fn().mockReturnValue(0),
  } as unknown as ICallTarget['sessionStore'];

  const emitter = {
    emit: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const otelBridge = {
    recordSpan: vi.fn(),
    setup: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  const checkpointClient = {
    save: vi.fn(),
    getById: vi.fn().mockResolvedValue(null),
    listForSession: vi.fn().mockReturnValue([]),
  };

  const core = new SyrinCore(
    config,
    sessionStore,
    emitter as never,
    otelBridge as never,
    checkpointClient as never,
  );

  const configStore = new ConfigStore();
  (core as unknown as Record<string, unknown>)['_configStore'] = configStore;

  return { core: core as SyrinCore & { _configStore: ConfigStore }, configStore };
}

// ---------------------------------------------------------------------------
// 1–4: buildSchema() tests
// ---------------------------------------------------------------------------

describe('SyrinCore.buildSchema()', () => {
  it('returns llm and prompt sections', () => {
    const { core } = makeCore();
    const schema = core.buildSchema();

    expect(schema).toMatchObject({ agent_id: 'test-agent' });
    const sections = (schema as { global: Record<string, unknown> }).global;
    expect(sections['llm']).toBeDefined();
    expect(sections['prompt']).toBeDefined();
  });

  it('llm section contains model, temperature, max_tokens fields', () => {
    const { core } = makeCore();
    const schema = core.buildSchema() as { global: Record<string, { fields: SchemaField[] }> };
    const fieldNames = schema.global['llm'].fields.map((f) => f.name);

    expect(fieldNames).toContain('model');
    expect(fieldNames).toContain('temperature');
    expect(fieldNames).toContain('max_tokens');
    expect(fieldNames).toContain('top_p');
    expect(fieldNames).toContain('frequency_penalty');
    expect(fieldNames).toContain('presence_penalty');
  });

  it('prompt section contains system_prompt field', () => {
    const { core } = makeCore();
    const schema = core.buildSchema() as { global: Record<string, { fields: SchemaField[] }> };
    const fieldNames = schema.global['prompt'].fields.map((f) => f.name);

    expect(fieldNames).toContain('system_prompt');
  });

  it('all built-in llm fields have null defaults', () => {
    const { core } = makeCore();
    const schema = core.buildSchema() as { global: Record<string, { fields: SchemaField[] }> };
    const llmFields = schema.global['llm'].fields;

    for (const field of llmFields) {
      expect(field.default).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 5–8: register() tests
// ---------------------------------------------------------------------------

describe('SyrinCore.register()', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /agents/:agentId/register with schema in body', async () => {
    const { core } = makeCore({ agentId: 'my-agent' });

    fetchSpy.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ configDelta: {} }),
    });

    await core.register();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('http://localhost:4399/api/v1/agents/my-agent/register');
    expect(options.method).toBe('POST');
    expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer syrin_test');

    const body = JSON.parse(options.body as string) as {
      agent_id: string;
      sdk: { language: string; version: string };
      schema: { agent_id: string };
    };
    expect(body.agent_id).toBe('my-agent');
    expect(body.sdk.language).toBe('typescript');
    expect(typeof body.sdk.version).toBe('string');
    expect(body.schema).toBeDefined();
    expect(body.schema.agent_id).toBe('my-agent');
  });

  it('applies configDelta to the ConfigStore', async () => {
    const { core, configStore } = makeCore({ agentId: 'delta-agent' });

    fetchSpy.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        configDelta: {
          'llm.temperature': 0.3,
          'llm.max_tokens': 2000,
        },
      }),
    });

    await core.register();

    expect(configStore.get('llm', 'temperature')).toBe(0.3);
    expect(configStore.get('llm', 'max_tokens')).toBe(2000);
  });

  it('is a no-op when agentId is not set', async () => {
    const { core } = makeCore({ agentId: undefined });

    await core.register();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not propagate error when fetch throws', async () => {
    const { core } = makeCore({ agentId: 'throwing-agent' });

    fetchSpy.mockRejectedValue(new Error('Network unreachable'));

    await expect(core.register()).resolves.toBeUndefined();
  });

  it('does not propagate error when fetch times out (AbortError)', async () => {
    const { core } = makeCore({ agentId: 'timeout-agent' });

    const abortErr = new DOMException('signal timed out', 'TimeoutError');
    fetchSpy.mockRejectedValue(abortErr);

    await expect(core.register()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. register is called during init()
// ---------------------------------------------------------------------------

describe('init() calls register()', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('calls /agents/:agentId/register during init()', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if ((url as string).includes('/register')) {
        return Promise.resolve({
          ok: true,
          json: vi.fn().mockResolvedValue({ configDelta: {} }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({ ok: true }),
      });
    });

    const { init, shutdown } = await import('@/index');
    const sdk = await init({
      apiKey: 'syrin_test',
      agentId: 'init-agent',
      backendUrl: 'http://localhost:4399',
      offline: true,
      otelExporter: 'none',
    });

    const registerCalls = fetchSpy.mock.calls.filter(([url]: [string]) =>
      url.includes('/register')
    );
    expect(registerCalls.length).toBeGreaterThanOrEqual(1);
    expect(registerCalls[0][0]).toContain('/api/v1/agents/init-agent/register');

    await sdk.shutdown();
  });
});
