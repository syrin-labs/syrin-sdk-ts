/**
 * Tests: schemaDefaults — parity with Python SDK's schema_defaults option
 *
 * Covers:
 *  1. buildSchema() without schemaDefaults leaves field defaults as-is
 *  2. buildSchema() with schemaDefaults patches matching field defaults
 *  3. schemaDefaults patches across multiple sections (llm + prompt)
 *  4. schemaDefaults for unknown field path is silently ignored
 *  5. schemaDefaults passed to init() appears in the registered schema body
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SyrinSDKCore } from '@/core/engine';
import { OpenAIAdapter } from '@/adapters/openai/index';
import type { ISyrinCore, SchemaField } from '@/adapters/types';
import type { SyrinSDKConfig } from '@/types';

vi.mock('openai', () => {
  class MockOpenAI { constructor(_?: unknown) {} }
  return { default: MockOpenAI };
});

function makeCore(schemaDefaults?: Record<string, unknown>): SyrinSDKCore {
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

  return new SyrinSDKCore(config, sessionStore, emitter as never, otelBridge as never, checkpointClient as never);
}

async function makeOpenAICore(schemaDefaults?: Record<string, unknown>): Promise<SyrinSDKCore> {
  const core = makeCore(schemaDefaults);
  const adapter = new OpenAIAdapter({} as never);
  adapter.install = vi.fn().mockResolvedValue(undefined);
  adapter.isInstalled = vi.fn().mockReturnValue(true);
  await core.registerAdapter(adapter);
  return core;
}

type Schema = { sections: Record<string, { fields: SchemaField[] }> };

describe('schemaDefaults', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // 1. Without schemaDefaults, model default is null (as defined by the adapter)
  it('leaves field defaults as-is when schemaDefaults is not provided', async () => {
    const core = await makeOpenAICore();
    const schema = core.buildSchema() as Schema;
    const modelField = schema.sections['llm'].fields.find((f) => f.name === 'model');
    expect(modelField?.default).toBeNull();
  });

  // 2. With schemaDefaults, matching fields get patched
  it('patches llm.model default from schemaDefaults', async () => {
    const core = await makeOpenAICore({ 'llm.model': 'gpt-4o-mini' });
    const schema = core.buildSchema() as Schema;
    const modelField = schema.sections['llm'].fields.find((f) => f.name === 'model');
    expect(modelField?.default).toBe('gpt-4o-mini');
  });

  // 3. Patches across multiple sections
  it('patches llm.temperature and prompt.system_prompt from schemaDefaults', async () => {
    const core = await makeOpenAICore({
      'llm.temperature': 0.2,
      'prompt.system_prompt': 'You are a concise assistant.',
    });
    const schema = core.buildSchema() as Schema;

    const tempField = schema.sections['llm']?.fields.find((f) => f.name === 'temperature');
    expect(tempField?.default).toBe(0.2);

    const promptField = schema.sections['prompt']?.fields.find((f) => f.name === 'system_prompt');
    expect(promptField?.default).toBe('You are a concise assistant.');
  });

  // 4. Unknown field path in schemaDefaults is silently ignored
  it('ignores unknown field paths in schemaDefaults', async () => {
    const core = await makeOpenAICore({ 'nonexistent.field': 'value' });
    // Should not throw
    expect(() => core.buildSchema()).not.toThrow();
  });

  // 5. schemaDefaults appears in registration POST body
  it('patched defaults appear in the body sent to /register', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const core = await makeOpenAICore({ 'llm.model': 'gpt-4o', 'llm.temperature': 0.5 });
    await core.register();

    vi.unstubAllGlobals();

    expect(fetchSpy).toHaveBeenCalled();
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { schema: Schema };
    const modelField = body.schema.sections['llm']?.fields.find((f) => f.name === 'model');
    expect(modelField?.default).toBe('gpt-4o');
  });
});
