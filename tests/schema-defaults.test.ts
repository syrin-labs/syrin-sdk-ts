/**
 * Tests: schemaDefaults / cfg() — v2 schema format
 *
 * In v2, adapters are telemetry-only and return {} from configSchema().
 * The schema is now populated exclusively via sdk.cfg() calls which register
 * compound namespaces (global.section, agents.id.section) in the ConfigStore.
 *
 * Covers:
 *  1. buildSchema() produces v2 format with version, global, agents keys
 *  2. cfg() populating ConfigStore appears in buildSchema() global sections
 *  3. Unknown field paths do not throw
 *  4. buildSchema() is non-throwing when ConfigStore is empty
 *  5. register() POSTs v2 schema body to the backend
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SyrinSDKCore } from '@/core/engine';
import { ConfigStore } from '@/config/store';
import { OpenAIAdapter } from '@/adapters/openai/index';
import type { ISyrinCore } from '@/adapters/types';
import type { SyrinSDKConfig } from '@/types';

vi.mock('openai', () => {
  class MockOpenAI { constructor(_?: unknown) {} }
  return { default: MockOpenAI };
});

function makeCore(schemaDefaults?: Record<string, unknown>): { core: SyrinSDKCore; configStore: ConfigStore } {
  const config: SyrinSDKConfig = {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4000',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4318',
    debug: false,
    captureContent: false,
    offline: true,
    batchSize: 50,
    idleFlushMs: 60_000,
    toolValidation: false,
    agentId: 'test-agent',
    sessionId: 'ses_test',
    schemaDefaults,
  };

  const sessionStore = {
    getOrCreate: vi.fn().mockResolvedValue({}),
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

  const emitter = { emit: vi.fn(), flush: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const otelBridge = { recordSpan: vi.fn(), setup: vi.fn(), shutdown: vi.fn() };
  const checkpointClient = { save: vi.fn(), getById: vi.fn(), listForSession: vi.fn().mockReturnValue([]) };

  const core = new SyrinSDKCore(config, sessionStore, emitter as never, otelBridge as never, checkpointClient as never);
  const configStore = new ConfigStore();
  (core as unknown as Record<string, unknown>)['_configStore'] = configStore;
  return { core, configStore };
}

async function makeOpenAICore(schemaDefaults?: Record<string, unknown>): Promise<{ core: SyrinSDKCore; configStore: ConfigStore }> {
  const { core, configStore } = makeCore(schemaDefaults);
  const adapter = new OpenAIAdapter({} as never);
  adapter.install = vi.fn().mockResolvedValue(undefined);
  adapter.isInstalled = vi.fn().mockReturnValue(true);
  await core.registerAdapter(adapter);
  return { core, configStore };
}

/** Helper to inject cfg()-style namespace into ConfigStore (mimics sdk.cfg() call) */
function injectCfg(
  configStore: ConfigStore,
  namespace: string, // e.g. 'global.llm'
  fieldName: string,
  defaultVal: unknown,
  options: { ge?: number; le?: number } = {},
): void {
  const sectionsRef = (configStore as unknown as {
    _sections: Record<string, Record<string, { name: string; type: string; default: unknown; ge?: number; le?: number }>>;
    _values: Record<string, Record<string, unknown>>;
  });
  if (!sectionsRef._sections[namespace]) {
    sectionsRef._sections[namespace] = {};
    sectionsRef._values[namespace] = {};
  }
  sectionsRef._sections[namespace][fieldName] = {
    name: fieldName,
    type: typeof defaultVal === 'number' ? 'number' : 'string',
    default: defaultVal,
    ...options,
  };
  sectionsRef._values[namespace][fieldName] = defaultVal;
}

type V2Schema = { version: number; agent_id: string; global: Record<string, { fields: Array<Record<string, unknown>> }>; agents: Record<string, unknown> };

describe('schemaDefaults / cfg() v2', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // 1. buildSchema() produces v2 format
  it('buildSchema returns v2 format with version=2, global, agents keys', async () => {
    const { core } = await makeOpenAICore();
    const schema = core.buildSchema() as V2Schema;
    expect(schema.version).toBe(2);
    expect(schema.agent_id).toBe('test-agent');
    expect(schema).toHaveProperty('global');
    expect(schema).toHaveProperty('agents');
  });

  // 2. cfg()-registered fields appear in global sections
  it('cfg()-style field in global.llm appears in buildSchema global', async () => {
    const { core, configStore } = await makeOpenAICore();
    injectCfg(configStore, 'global.llm', 'model', 'gpt-4o');
    const schema = core.buildSchema() as V2Schema;
    expect(schema.global['llm']).toBeDefined();
    const modelField = schema.global['llm'].fields.find(f => f['name'] === 'model');
    expect(modelField?.['default']).toBe('gpt-4o');
  });

  // 3. cfg()-style field with constraints appears correctly
  it('cfg()-style temperature with constraints appears in global schema', async () => {
    const { core, configStore } = await makeOpenAICore();
    injectCfg(configStore, 'global.llm', 'temperature', 0.7, { ge: 0, le: 2 });
    const schema = core.buildSchema() as V2Schema;
    const tempField = schema.global['llm']?.fields.find(f => f['name'] === 'temperature');
    expect(tempField?.['default']).toBe(0.7);
    expect(tempField?.['constraints']).toMatchObject({ ge: 0, le: 2 });
  });

  // 4. Unknown/empty ConfigStore does not throw
  it('does not throw when ConfigStore has no compound namespaces', async () => {
    const { core } = await makeOpenAICore({ 'nonexistent.field': 'value' });
    expect(() => core.buildSchema()).not.toThrow();
  });

  // 5. register() POSTs v2 schema body
  it('register() sends v2 schema body to backend', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const { core, configStore } = await makeOpenAICore();
    injectCfg(configStore, 'global.llm', 'model', 'gpt-4o');
    injectCfg(configStore, 'global.llm', 'temperature', 0.5, { ge: 0, le: 2 });
    await core.register();

    vi.unstubAllGlobals();

    expect(fetchSpy).toHaveBeenCalled();
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { schema: V2Schema };
    expect(body.schema.version).toBe(2);
    const modelField = body.schema.global['llm']?.fields.find((f) => f['name'] === 'model');
    expect(modelField?.['default']).toBe('gpt-4o');
  });
});
