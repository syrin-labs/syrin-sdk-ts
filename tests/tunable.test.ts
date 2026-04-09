/**
 * Tests: src/tunable.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TunableRegistry,
  tunable,
  TunableField,
  tune,
  getTune,
  TUNABLE_FIELD_MARKER,
  isTunableFieldMarker,
  globalRegistry,
} from '@/tunable';

describe('TunableField marker', () => {
  it('TunableField stores options on class metadata', () => {
    const marker = TunableField({ default: 10, ge: 1, le: 100, description: 'batch size' });
    expect(isTunableFieldMarker(marker)).toBe(true);
    const m = marker as Record<string, unknown>;
    expect(m['default']).toBe(10);
    expect(m['ge']).toBe(1);
    expect(m['le']).toBe(100);
    expect(m['description']).toBe('batch size');
  });

  it('TunableField with no options creates marker with no constraints', () => {
    const marker = TunableField();
    expect(isTunableFieldMarker(marker)).toBe(true);
  });

  it('TunableField constraints stored in schema', () => {
    const marker = TunableField({ default: 0.7, ge: 0.0, le: 2.0, enum: [0.5, 0.7, 1.0] });
    const m = marker as Record<string, unknown>;
    expect(m['ge']).toBe(0.0);
    expect(m['le']).toBe(2.0);
    expect(m['enum']).toEqual([0.5, 0.7, 1.0]);
  });
});

describe('@tunable class decorator', () => {
  let registry: TunableRegistry;

  beforeEach(() => {
    registry = new TunableRegistry();
  });

  it('tunable decorator patches constructor to register instance', () => {
    @tunable({ namespace: 'processor', registry })
    class DocumentProcessor {
      batchSize = TunableField({ default: 10 });
    }

    const proc = new DocumentProcessor();
    const values = registry.get('processor');
    expect(values).toBeDefined();
    expect('batchSize' in values).toBe(true);
  });

  it('tunable decorator registers annotated fields', () => {
    @tunable({ namespace: 'myagent', registry })
    class MyAgent {
      temperature = TunableField({ default: 0.7 });
      maxTokens = TunableField({ default: 512 });
      systemPrompt = 'hello'; // not tunable
    }

    const agent = new MyAgent();
    const values = registry.get('myagent');
    expect('temperature' in values).toBe(true);
    expect('maxTokens' in values).toBe(true);
    expect('systemPrompt' in values).toBe(false);
  });

  it('tunable decorator replaces TunableField marker with default value', () => {
    @tunable({ namespace: 'worker', registry })
    class Worker {
      batchSize = TunableField({ default: 42 });
    }

    const worker = new Worker();
    // The property should now be the default value, not the marker
    expect((worker as unknown as Record<string, unknown>)['batchSize']).toBe(42);
  });

  it('TunableField default replaces field value on instance', () => {
    @tunable({ namespace: 'worker2', registry })
    class Worker2 {
      value = TunableField({ default: 'hello' });
    }

    const w = new Worker2();
    expect((w as unknown as Record<string, unknown>)['value']).toBe('hello');
  });

  it('tunable multiple instances registered separately — each replaces previous', () => {
    @tunable({ namespace: 'multi', registry })
    class Multi {
      x = TunableField({ default: 1 });
    }

    const m1 = new Multi();
    const m2 = new Multi();
    // Second instance replaces first (same namespace)
    const values = registry.get('multi');
    expect('x' in values).toBe(true);
  });
});

describe('TunableRegistry — tune()', () => {
  let registry: TunableRegistry;

  beforeEach(() => {
    registry = new TunableRegistry();
  });

  it('tune with fields object registers entry', () => {
    const target = { temperature: 0.7, maxTokens: 512 };
    tune({
      target,
      namespace: 'openai_agent',
      fields: { temperature: 'number', maxTokens: 'number' },
      registry,
    });
    const values = registry.get('openai_agent');
    expect('temperature' in values).toBe(true);
    expect('maxTokens' in values).toBe(true);
  });

  it('tune applyUpdate immediate — property updated on target', () => {
    const target = { temperature: 0.7 };
    tune({
      target,
      namespace: 'agent_imm',
      fields: { temperature: 'number' },
      applyTiming: 'immediate',
      registry,
    });
    registry.applyUpdate('agent_imm', 'temperature', 0.3);
    expect(target.temperature).toBe(0.3);
  });

  it('tune applyUpdate beforeNextCall — value buffered not applied', () => {
    const target = { temperature: 0.7 };
    tune({
      target,
      namespace: 'agent_buf',
      fields: { temperature: 'number' },
      applyTiming: 'beforeNextCall',
      registry,
    });
    registry.applyUpdate('agent_buf', 'temperature', 0.3);
    // Should NOT have applied yet
    expect(target.temperature).toBe(0.7);
    const values = registry.get('agent_buf');
    expect(values['temperature']).toBe(0.3); // but visible via get()
  });

  it('applyPending flushes buffered values', () => {
    const target = { temperature: 0.7 };
    tune({
      target,
      namespace: 'agent_flush',
      fields: { temperature: 'number' },
      applyTiming: 'beforeNextCall',
      registry,
    });
    registry.applyUpdate('agent_flush', 'temperature', 0.3);
    expect(target.temperature).toBe(0.7); // not yet
    registry.applyPending('agent_flush');
    expect(target.temperature).toBe(0.3); // now applied
  });

  it('applyPending specific namespace — does not affect others', () => {
    const t1 = { x: 1 };
    const t2 = { y: 2 };
    tune({ target: t1, namespace: 'ns1', fields: { x: 'number' }, applyTiming: 'beforeNextCall', registry });
    tune({ target: t2, namespace: 'ns2', fields: { y: 'number' }, applyTiming: 'beforeNextCall', registry });
    registry.applyUpdate('ns1', 'x', 10);
    registry.applyUpdate('ns2', 'y', 20);
    registry.applyPending('ns1');
    expect(t1.x).toBe(10);
    expect(t2.y).toBe(2); // ns2 not flushed
  });

  it('tune with custom apply function — function called', () => {
    const target = { settings: {} as Record<string, unknown> };
    const apply = (t: object, key: string, value: unknown) => {
      (t as typeof target).settings[key] = value;
    };
    tune({
      target,
      namespace: 'custom_apply',
      fields: { temperature: 'number' },
      applyTiming: 'immediate',
      apply,
      registry,
    });
    registry.applyUpdate('custom_apply', 'temperature', 0.5);
    expect(target.settings['temperature']).toBe(0.5);
  });

  it('getTune returns current values', () => {
    const target = { temperature: 0.7, model: 'gpt-4o' };
    tune({
      target,
      namespace: 'gettune_agent',
      fields: { temperature: 'number', model: 'string' },
      registry,
    });
    const values = getTune('gettune_agent', registry);
    expect(values['temperature']).toBe(0.7);
    expect(values['model']).toBe('gpt-4o');
  });

  it('getTune unknown namespace returns empty', () => {
    const values = getTune('does_not_exist', registry);
    expect(values).toEqual({});
  });

  it('unregister removes entry', () => {
    const target = { x: 1 };
    tune({ target, namespace: 'ns_rem', fields: { x: 'number' }, registry });
    registry.unregister('ns_rem');
    expect(registry.get('ns_rem')).toEqual({});
  });

  it('clear resets registry', () => {
    const t1 = { a: 1 };
    const t2 = { b: 2 };
    tune({ target: t1, namespace: 'ns_a', fields: { a: 'number' }, registry });
    tune({ target: t2, namespace: 'ns_b', fields: { b: 'number' }, registry });
    registry.clear();
    expect(registry.get('ns_a')).toEqual({});
    expect(registry.get('ns_b')).toEqual({});
  });

  it('tune without fields or schema throws', () => {
    const target = { x: 1 };
    expect(() => tune({ target, namespace: 'bad_tune', registry })).toThrow();
  });

  it('tune dotted path resolves nested property', () => {
    const target = { config: { temperature: 0.7 } };
    const apply = (t: object, key: string, value: unknown) => {
      const parts = key.split('.');
      let obj = t as Record<string, unknown>;
      for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]] as Record<string, unknown>;
      }
      obj[parts[parts.length - 1]] = value;
    };
    tune({
      target,
      namespace: 'nested',
      fields: { 'config.temperature': 'number' },
      applyTiming: 'immediate',
      apply,
      registry,
    });
    registry.applyUpdate('nested', 'config.temperature', 0.3);
    expect(target.config.temperature).toBe(0.3);
  });

  it('exportSchemas contains all namespaces', () => {
    const t1 = { a: 1 };
    const t2 = { b: 'x' };
    tune({ target: t1, namespace: 'schema_ns1', fields: { a: 'number' }, registry });
    tune({ target: t2, namespace: 'schema_ns2', fields: { b: 'string' }, registry });
    const schemas = registry.exportSchemas();
    expect('schema_ns1' in schemas).toBe(true);
    expect('schema_ns2' in schemas).toBe(true);
  });

  it('tune overwrite same namespace updates entry', () => {
    const t1 = { x: 1 };
    const t2 = { x: 99 };
    tune({ target: t1, namespace: 'overwrite_ns', fields: { x: 'number' }, registry });
    tune({ target: t2, namespace: 'overwrite_ns', fields: { x: 'number' }, registry });
    registry.applyUpdate('overwrite_ns', 'x', 50);
    // t2 should be updated, t1 should not
    expect(t2.x).toBe(50);
  });
});
