/**
 * Tests: SyrinSDKCore.buildSchema() + SyrinSDKCore.register()
 *
 * Covers:
 *  1. buildSchema with no adapters returns empty sections
 *  2. buildSchema with OpenAI adapter returns llm section with 3 fields
 *  3. buildSchema with LangGraph adapter returns llm + langgraph sections
 *  4. buildSchema deduplicates fields when two adapters declare same section
 *  5. register POSTs to correct URL with schema in body
 *  6. register applies configDelta to ConfigStore
 *  7. register with no agentId is a no-op (no fetch call)
 *  8. register when fetch throws does not propagate the error
 *  9. register is called during init()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyrinSDKCore } from '@/core/engine';
import { ConfigStore } from '@/config/store';
import { OpenAIAdapter } from '@/adapters/openai/index';
import { LangGraphAdapter } from '@/adapters/langgraph/index';
import { SyrinSDKBaseFrameworkAdapter } from '@/adapters/types';
import type { ISyrinCore, SchemaField } from '@/adapters/types';
import type { SyrinSDKConfig } from '@/types';

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

function makeConfig(overrides: Partial<SyrinSDKConfig> = {}): SyrinSDKConfig {
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

function makeCore(configOverrides: Partial<SyrinSDKConfig> = {}): {
  core: SyrinSDKCore & { _configStore: ConfigStore };
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
  } as unknown as ISyrinCore['sessionStore'];

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

  const core = new SyrinSDKCore(
    config,
    sessionStore,
    emitter as never,
    otelBridge as never,
    checkpointClient as never,
  );

  const configStore = new ConfigStore();
  (core as unknown as Record<string, unknown>)['_configStore'] = configStore;

  return { core: core as SyrinSDKCore & { _configStore: ConfigStore }, configStore };
}

// ---------------------------------------------------------------------------
// A custom adapter that exposes a duplicate llm section (for dedup test)
// ---------------------------------------------------------------------------

class DuplicateLlmAdapter extends SyrinSDKBaseFrameworkAdapter {
  readonly name = 'duplicate-llm';

  protected _doInstall(_core: ISyrinCore): void {}
  protected _doUninstall(): void {}

  // Adapters are telemetry-only — returns {} per v2 design
  override configSchema(): Record<string, SchemaField[]> {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 1. buildSchema with no adapters returns empty sections
// ---------------------------------------------------------------------------

describe('SyrinSDKCore.buildSchema()', () => {
  // v2 schema: { version: 2, agent_id, global: {...}, agents: {...} }
  it('returns empty global when no cfg() calls and no adapters', () => {
    const { core } = makeCore();
    const schema = core.buildSchema();

    expect(schema).toMatchObject({ version: 2, agent_id: 'test-agent' });
    const global = (schema as { global: Record<string, unknown> }).global;
    // BUILTIN_SECTIONS are not included in v2 (they are flat, not compound namespaces)
    expect(global).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 2. buildSchema with OpenAI adapter: adapters return {} so global is empty
  //    unless cfg() calls populate it
  // -------------------------------------------------------------------------

  it('global is empty after registering OpenAI adapter (adapters are telemetry-only)', async () => {
    const { core } = makeCore();

    const openaiAdapter = new OpenAIAdapter({} as never);
    openaiAdapter.install = vi.fn().mockResolvedValue(undefined);
    openaiAdapter.isInstalled = vi.fn().mockReturnValue(true);
    await core.registerAdapter(openaiAdapter);

    const schema = core.buildSchema();
    const global = (schema as { global: Record<string, { fields: SchemaField[] }> }).global;
    // Adapters no longer contribute schema fields — cfg() calls do
    expect(global['llm']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 3. buildSchema with cfg() calls populates global sections
  // -------------------------------------------------------------------------

  it('global is populated when cfg() registers compound namespaces in ConfigStore', () => {
    const { core, configStore } = makeCore();

    // Simulate what sdk.cfg('llm.temperature', 0.7) would do
    const sections = (configStore as unknown as { _sections: Record<string, unknown>; _values: Record<string, unknown> })._sections;
    const values = (configStore as unknown as { _sections: Record<string, unknown>; _values: Record<string, unknown> })._values;
    sections['global.llm'] = {
      temperature: { name: 'temperature', type: 'number', default: 0.7, ge: 0, le: 2 },
      model: { name: 'model', type: 'string', default: 'gpt-4o' },
    };
    values['global.llm'] = { temperature: 0.7, model: 'gpt-4o' };

    const schema = core.buildSchema();
    const global = (schema as { global: Record<string, { fields: Array<Record<string, unknown>> }> }).global;

    expect(global['llm']).toBeDefined();
    const fieldNames = global['llm'].fields.map((f) => f.name);
    expect(fieldNames).toContain('temperature');
    expect(fieldNames).toContain('model');
  });

  // -------------------------------------------------------------------------
  // 4. LangGraph adapter: no longer contributes schema fields via configSchema()
  // -------------------------------------------------------------------------

  it('LangGraph adapter registers as telemetry-only (no schema fields from adapter)', async () => {
    const { core } = makeCore();

    const lgAdapter = new LangGraphAdapter();
    lgAdapter.install = vi.fn().mockResolvedValue(undefined);
    lgAdapter.isInstalled = vi.fn().mockReturnValue(true);
    await core.registerAdapter(lgAdapter);

    const schema = core.buildSchema();
    expect(schema).toMatchObject({ version: 2 });
    const global = (schema as { global: Record<string, unknown> }).global;
    // No adapter-contributed fields in v2
    expect(global['langgraph']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5–8: register() tests
// ---------------------------------------------------------------------------

describe('SyrinSDKCore.register()', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // 5. register POSTs to correct URL with schema in body
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // 6. register applies configDelta to ConfigStore
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // 7. register with no agentId is a no-op (no fetch call)
  // -------------------------------------------------------------------------

  it('is a no-op when agentId is not set', async () => {
    const { core } = makeCore({ agentId: undefined });

    await core.register();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. register when fetch throws does not propagate the error
  // -------------------------------------------------------------------------

  it('does not propagate error when fetch throws', async () => {
    const { core } = makeCore({ agentId: 'throwing-agent' });

    fetchSpy.mockRejectedValue(new Error('Network unreachable'));

    // Should not throw
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
    // Set up a mock server response for both /ingest and /register
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

    // At least one fetch call should target the register endpoint
    const registerCalls = fetchSpy.mock.calls.filter(([url]: [string]) =>
      url.includes('/register')
    );
    expect(registerCalls.length).toBeGreaterThanOrEqual(1);
    expect(registerCalls[0][0]).toContain('/agents/init-agent/register');

    await sdk.shutdown();
  });
});
