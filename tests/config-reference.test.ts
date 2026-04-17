import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { init, shutdown, configReference, printConfigReference } from '@/index';
import type { SyrinSDKInstance } from '@/index';
import type { ConfigStore } from '@/config/store';

/** Helper: inject a cfg()-style field into ConfigStore compound namespace */
function injectCfg(
  sdk: SyrinSDKInstance,
  namespace: string,
  fieldName: string,
  defaultVal: unknown,
  options: { ge?: number; le?: number; label?: string } = {},
): void {
  const configStore = sdk['_core']['_configStore'] as ConfigStore | undefined;
  if (!configStore) return;
  const sectionsRef = (configStore as unknown as {
    _sections: Record<string, Record<string, { name: string; type: string; default: unknown; ge?: number; le?: number; label?: string }>>;
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

async function makeOfflineSdk(): Promise<SyrinSDKInstance> {
  const sdk = await init({ apiKey: 'syrin_test', offline: true, debug: false });
  // Populate llm section via cfg() pattern so configReference() has sections to show
  injectCfg(sdk, 'global.llm', 'temperature', null, { ge: 0, le: 2 });
  injectCfg(sdk, 'global.llm', 'model', null);
  injectCfg(sdk, 'global.llm', 'max_tokens', null);
  injectCfg(sdk, 'global.prompt', 'system_prompt', null);
  return sdk;
}

describe('configReference — structure', () => {
  let sdk: SyrinSDKInstance;
  beforeEach(async () => { sdk = await makeOfflineSdk(); });
  afterEach(async () => { await sdk.shutdown(); });

  it('returns an object', async () => {
    expect(typeof sdk.configReference()).toBe('object');
  });

  it('contains llm section', () => {
    expect(sdk.configReference()).toHaveProperty('llm');
  });

  it('each field has current, default, source, type', () => {
    const ref = sdk.configReference();
    for (const [section, fields] of Object.entries(ref)) {
      for (const [name, info] of Object.entries(fields as Record<string, unknown>)) {
        const i = info as Record<string, unknown>;
        expect(i, `${section}.${name} missing 'current'`).toHaveProperty('current');
        expect(i, `${section}.${name} missing 'default'`).toHaveProperty('default');
        expect(i, `${section}.${name} missing 'source'`).toHaveProperty('source');
        expect(i, `${section}.${name} missing 'type'`).toHaveProperty('type');
      }
    }
  });

  it('untouched field source is default', () => {
    const ref = sdk.configReference();
    expect((ref.llm as Record<string, Record<string, unknown>>).temperature.source).toBe('default');
  });

  it('untouched field current is null/undefined', () => {
    const ref = sdk.configReference();
    const current = (ref.llm as Record<string, Record<string, unknown>>).temperature.current;
    expect(current == null).toBe(true);
  });

  it('temperature has constraints', () => {
    const ref = sdk.configReference();
    const temp = (ref.llm as Record<string, Record<string, unknown>>).temperature;
    expect(temp.constraints).toMatchObject({ ge: 0, le: 2 });
  });

  it('prompt section present', () => {
    const ref = sdk.configReference();
    expect(ref).toHaveProperty('prompt');
  });
});

describe('configReference — source tracking', () => {
  let sdk: SyrinSDKInstance;
  beforeEach(async () => { sdk = await makeOfflineSdk(); });
  afterEach(async () => { await sdk.shutdown(); });

  it('remote update shows source=remote', () => {
    // Simulate backend pushing config_updates directly to session
    const session = sdk['_sessionStore'].getOrCreateSync?.(sdk.sessionId)
                  ?? sdk['_sessionStore']['sessions']?.get(sdk.sessionId);
    if (session) {
      session.activeConfig = session.activeConfig ?? {};
      session.activeConfig['temperature'] = 0.3;
    }
    const ref = sdk.configReference();
    const temp = (ref.llm as Record<string, Record<string, unknown>>).temperature;
    expect(temp.source).toBe('remote');
    expect(temp.current).toBeCloseTo(0.3);
  });

  it('user configure shows source=user', () => {
    sdk.configure({ temperature: 0.5 });
    const ref = sdk.configReference();
    const temp = (ref.llm as Record<string, Record<string, unknown>>).temperature;
    expect(temp.source).toBe('user');
    expect(temp.current).toBeCloseTo(0.5);
  });

  it('user wins over remote', () => {
    const session = sdk['_sessionStore']['sessions']?.get(sdk.sessionId);
    if (session) { session.activeConfig = { temperature: 0.3 }; }
    sdk.configure({ temperature: 0.9 });
    const ref = sdk.configReference();
    const temp = (ref.llm as Record<string, Record<string, unknown>>).temperature;
    expect(temp.source).toBe('user');
    expect(temp.current).toBeCloseTo(0.9);
  });

  it('two fields can have independent sources', () => {
    const session = sdk['_sessionStore']['sessions']?.get(sdk.sessionId);
    if (session) { session.activeConfig = { temperature: 0.3 }; }
    sdk.configure({ max_tokens: 500 });
    const ref = sdk.configReference();
    const llm = ref.llm as Record<string, Record<string, unknown>>;
    expect(llm.temperature.source).toBe('remote');
    expect(llm.max_tokens?.source ?? llm.maxTokens?.source).toBe('user');
  });

  it('configStore remote source tracked for cfg()-registered fields', () => {
    // Inject a langgraph section via cfg() pattern then set a value directly
    injectCfg(sdk, 'global.langgraph', 'recursion_limit', 25, { ge: 1 });
    // Set value directly in the ConfigStore (simulating remote update to compound namespace)
    const configStore = sdk['_core']['_configStore'];
    if (configStore) {
      (configStore as unknown as { _values: Record<string, Record<string, unknown>>; _fieldSources: Record<string, Record<string, string>> })
        ._values['global.langgraph'] = { recursion_limit: 10 };
      (configStore as unknown as { _values: Record<string, Record<string, unknown>>; _fieldSources: Record<string, Record<string, string>> })
        ._fieldSources['global.langgraph'] = { recursion_limit: 'remote' };
    }
    const ref = sdk.configReference();
    const lg = ref.langgraph as Record<string, Record<string, unknown>> | undefined;
    if (lg?.recursion_limit) {
      expect(lg.recursion_limit.source).toBe('remote');
      expect(lg.recursion_limit.current).toBe(10);
    }
  });
});

describe('configReference — module level', () => {
  let sdk: SyrinSDKInstance;
  beforeEach(async () => { sdk = await makeOfflineSdk(); });
  afterEach(async () => { await sdk.shutdown(); });

  it('module-level returns object when initialized', () => {
    expect(typeof configReference()).toBe('object');
  });
});

describe('configReference — before init', () => {
  it('module-level returns null/undefined before init', async () => {
    await shutdown();
    const result = configReference();
    expect(result == null).toBe(true);
  });
});

describe('printConfigReference', () => {
  let sdk: SyrinSDKInstance;
  let output: string[];
  beforeEach(async () => {
    sdk = await makeOfflineSdk();
    output = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await sdk.shutdown();
  });

  it('produces output', () => {
    sdk.printConfigReference();
    expect(output.length).toBeGreaterThan(0);
  });

  it('output contains llm section', () => {
    sdk.printConfigReference();
    expect(output.join('\n').toLowerCase()).toContain('llm');
  });

  it('output contains default badge for untouched field', () => {
    sdk.printConfigReference();
    expect(output.join('\n')).toContain('default');
  });

  it('output contains remote badge after remote update', () => {
    const session = sdk['_sessionStore']['sessions']?.get(sdk.sessionId);
    if (session) { session.activeConfig = { temperature: 0.3 }; }
    sdk.printConfigReference();
    expect(output.join('\n')).toContain('remote');
  });

  it('output contains user badge after configure', () => {
    sdk.configure({ temperature: 0.5 });
    sdk.printConfigReference();
    expect(output.join('\n')).toContain('user');
  });

  it('output contains current value after configure', () => {
    sdk.configure({ model: 'gpt-4o-mini' });
    sdk.printConfigReference();
    expect(output.join('\n')).toContain('gpt-4o-mini');
  });

  it('module-level printConfigReference works', () => {
    printConfigReference();
    expect(output.length).toBeGreaterThan(0);
  });
});
