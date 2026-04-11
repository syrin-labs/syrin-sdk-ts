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

  override configSchema(): Record<string, SchemaField[]> {
    return {
      llm: [
        // Same field names as OpenAI/Anthropic but different defaults
        { name: 'model', type: 'str', default: 'claude-3-opus' },
        { name: 'temperature', type: 'float', default: 0.5 },
        // Extra field not in OpenAI schema
        { name: 'top_k', type: 'int', default: null },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// 1. buildSchema with no adapters returns empty sections
// ---------------------------------------------------------------------------

describe('SyrinSDKCore.buildSchema()', () => {
  it('returns empty sections when no adapters are registered', () => {
    const { core } = makeCore();
    const schema = core.buildSchema();

    expect(schema).toMatchObject({ agent_id: 'test-agent' });
    const sections = (schema as { sections: Record<string, unknown> }).sections;
    expect(Object.keys(sections)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. buildSchema with OpenAI adapter returns llm section with 3 fields
  // -------------------------------------------------------------------------

  it('returns llm section with 3 fields after registering OpenAI adapter', async () => {
    const { core } = makeCore();

    // Manually register adapter without actually patching (use null module trick)
    const openaiAdapter = new OpenAIAdapter({} as never);
    // Override install to be a no-op for this unit test
    openaiAdapter.install = vi.fn().mockResolvedValue(undefined);
    openaiAdapter.isInstalled = vi.fn().mockReturnValue(true);
    await core.registerAdapter(openaiAdapter);

    const schema = core.buildSchema();
    const sections = (schema as { sections: Record<string, { fields: SchemaField[] }> }).sections;

    expect(sections['llm']).toBeDefined();

    const fieldNames = sections['llm'].fields.map((f) => f.name);
    expect(fieldNames).toContain('model');
    expect(fieldNames).toContain('temperature');
    expect(fieldNames).toContain('max_tokens');
  });

  // -------------------------------------------------------------------------
  // 3. buildSchema with LangGraph adapter returns llm + langgraph sections
  // -------------------------------------------------------------------------

  it('returns llm + langgraph sections after registering LangGraph adapter', async () => {
    const { core } = makeCore();

    const lgAdapter = new LangGraphAdapter();
    lgAdapter.install = vi.fn().mockResolvedValue(undefined);
    lgAdapter.isInstalled = vi.fn().mockReturnValue(true);
    await core.registerAdapter(lgAdapter);

    const schema = core.buildSchema();
    const sections = (schema as { sections: Record<string, { fields: SchemaField[] }> }).sections;

    expect(sections['llm']).toBeDefined();
    expect(sections['langgraph']).toBeDefined();

    const lgFieldNames = sections['langgraph'].fields.map((f) => f.name);
    expect(lgFieldNames).toContain('recursion_limit');
    expect(lgFieldNames).toContain('interrupt_before');
    expect(lgFieldNames).toContain('interrupt_after');
    expect(lgFieldNames).toContain('thread_id');
  });

  // -------------------------------------------------------------------------
  // 4. buildSchema deduplicates fields when two adapters declare same section
  // -------------------------------------------------------------------------

  it('deduplicates fields — first adapter wins', async () => {
    const { core } = makeCore();

    // Register OpenAI first (model default = null)
    const openaiAdapter = new OpenAIAdapter({} as never);
    openaiAdapter.install = vi.fn().mockResolvedValue(undefined);
    openaiAdapter.isInstalled = vi.fn().mockReturnValue(true);
    await core.registerAdapter(openaiAdapter);

    // Register duplicate adapter second (model default = 'claude-3-opus')
    const dupAdapter = new DuplicateLlmAdapter();
    dupAdapter.install = vi.fn().mockResolvedValue(undefined);
    dupAdapter.isInstalled = vi.fn().mockReturnValue(true);
    await core.registerAdapter(dupAdapter);

    const schema = core.buildSchema();
    const sections = (schema as { sections: Record<string, { fields: SchemaField[] }> }).sections;
    const llmFields = sections['llm'].fields;

    // 'model' from OpenAI (default=null) should win; 'top_k' from duplicate should be added
    const modelField = llmFields.find((f) => f.name === 'model');
    expect(modelField?.default).toBeNull(); // OpenAI's default wins

    // 'top_k' from duplicate should be present since it's not in OpenAI schema
    const topKField = llmFields.find((f) => f.name === 'top_k');
    expect(topKField).toBeDefined();
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

    expect(url).toBe('http://localhost:4399/agents/my-agent/register');
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
