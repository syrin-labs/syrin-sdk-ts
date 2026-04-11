/**
 * Tests: src/config-store.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigStore } from '@/config/store';
import type { FieldSchema } from '@/config/store';

describe('ConfigStore — built-in sections', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('builtin llm section exists', () => {
    const section = store.getSection('llm');
    expect(section).toBeDefined();
    expect('temperature' in section).toBe(true);
    expect('max_tokens' in section).toBe(true);
    expect('model' in section).toBe(true);
    expect('top_p' in section).toBe(true);
    expect('stream' in section).toBe(true);
  });

  it('builtin langgraph section exists', () => {
    const section = store.getSection('langgraph');
    expect(section).toBeDefined();
    expect('recursion_limit' in section).toBe(true);
    expect('interrupt_before' in section).toBe(true);
    expect('max_concurrency' in section).toBe(true);
  });

  it('builtin mastra section exists', () => {
    const section = store.getSection('mastra');
    expect(section).toBeDefined();
    expect('model' in section).toBe(true);
    expect('temperature' in section).toBe(true);
    expect('max_steps' in section).toBe(true);
  });

  it('builtin vercel_ai section exists', () => {
    const section = store.getSection('vercel_ai');
    expect(section).toBeDefined();
    expect('model' in section).toBe(true);
    expect('temperature' in section).toBe(true);
    expect('tool_choice' in section).toBe(true);
  });
});

describe('ConfigStore — get / set', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('get unknown namespace returns null', () => {
    expect(store.get('nonexistent', 'field')).toBeNull();
  });

  it('get unknown field returns null', () => {
    expect(store.get('llm', 'nonexistent_field')).toBeNull();
  });

  it('set and get value', () => {
    store.set('llm', 'temperature', 0.9);
    expect(store.get('llm', 'temperature')).toBe(0.9);
  });

  it('set value persists across multiple gets', () => {
    store.set('llm', 'model', 'gpt-4o-mini');
    expect(store.get('llm', 'model')).toBe('gpt-4o-mini');
    expect(store.get('llm', 'model')).toBe('gpt-4o-mini');
  });

  it('getSection returns empty object for unknown namespace', () => {
    const section = store.getSection('unknown_ns');
    expect(section).toEqual({});
  });
});

describe('ConfigStore — registerSection', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('registerSection creates custom namespace', () => {
    const customFields: Record<string, FieldSchema> = {
      batch_size: { name: 'batch_size', type: 'number', default: 10, ge: 1, le: 100 },
      mode: { name: 'mode', type: 'string', default: 'fast', enum: ['fast', 'slow'] },
    };
    store.registerSection('my_agent', customFields);
    const section = store.getSection('my_agent');
    expect('batch_size' in section).toBe(true);
    expect('mode' in section).toBe(true);
    expect(section['batch_size']).toBe(10);
    expect(section['mode']).toBe('fast');
  });
});

describe('ConfigStore — applyUpdates', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('applyUpdates valid value', () => {
    const rejected = store.applyUpdates({ 'llm.temperature': 0.5 });
    expect(rejected).toEqual({});
    expect(store.get('llm', 'temperature')).toBe(0.5);
  });

  it('applyUpdates wrong type returns rejection', () => {
    const rejected = store.applyUpdates({ 'llm.temperature': 'hot' });
    expect(Object.keys(rejected)).toContain('llm.temperature');
    expect(store.get('llm', 'temperature')).toBeNull();
  });

  it('applyUpdates out of range returns rejection', () => {
    // temperature max is 2.0
    const rejected = store.applyUpdates({ 'llm.temperature': 5.0 });
    expect(Object.keys(rejected)).toContain('llm.temperature');
    expect(store.get('llm', 'temperature')).toBeNull();
  });

  it('applyUpdates invalid enum returns rejection', () => {
    const customFields: Record<string, FieldSchema> = {
      mode: { name: 'mode', type: 'string', default: 'fast', enum: ['fast', 'slow'] },
    };
    store.registerSection('my_agent', customFields);
    const rejected = store.applyUpdates({ 'my_agent.mode': 'turbo' });
    expect(Object.keys(rejected)).toContain('my_agent.mode');
  });

  it('applyUpdates partial rejection — bad field rejected, others applied', () => {
    const rejected = store.applyUpdates({
      'llm.temperature': 0.7,
      'llm.max_tokens': 'bad_value',
    });
    expect(Object.keys(rejected)).toContain('llm.max_tokens');
    expect(Object.keys(rejected)).not.toContain('llm.temperature');
    expect(store.get('llm', 'temperature')).toBe(0.7);
  });

  it('applyUpdates null resets to default', () => {
    store.set('llm', 'temperature', 0.9);
    expect(store.get('llm', 'temperature')).toBe(0.9);
    const rejected = store.applyUpdates({ 'llm.temperature': null });
    expect(rejected).toEqual({});
    expect(store.get('llm', 'temperature')).toBeNull(); // default for temperature is null
  });

  it('applyUpdates unknown namespace silently ignored', () => {
    const rejected = store.applyUpdates({ 'unknown_ns.field': 'value' });
    expect(rejected).toEqual({});
  });
});

describe('ConfigStore — validateValue', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('validateValue valid returns null', () => {
    const err = store.validateValue('llm', 'temperature', 0.7);
    expect(err).toBeNull();
  });

  it('validateValue wrong type returns message', () => {
    const err = store.validateValue('llm', 'temperature', 'not_a_number');
    expect(err).toBeTruthy();
    expect(typeof err).toBe('string');
  });

  it('validateValue out of range returns message', () => {
    const errLow = store.validateValue('llm', 'temperature', -1.0);
    expect(errLow).toBeTruthy();

    const errHigh = store.validateValue('llm', 'temperature', 3.0);
    expect(errHigh).toBeTruthy();
  });

  it('validateValue null is valid (reset to default)', () => {
    const err = store.validateValue('llm', 'temperature', null);
    expect(err).toBeNull();
  });

  it('validateValue unknown namespace/field returns null (no schema = no constraints)', () => {
    const err = store.validateValue('unknown', 'field', 'anything');
    expect(err).toBeNull();
  });
});

describe('ConfigStore — snapshot and restore', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('snapshot and restoreSnapshot', () => {
    store.set('llm', 'temperature', 0.5);
    store.set('llm', 'model', 'gpt-4o');
    store.set('langgraph', 'recursion_limit', 50);

    const snap = store.snapshot();
    expect(snap['llm.temperature']).toBe(0.5);
    expect(snap['llm.model']).toBe('gpt-4o');
    expect(snap['langgraph.recursion_limit']).toBe(50);

    // Mutate
    store.set('llm', 'temperature', 1.5);
    store.set('llm', 'model', 'gpt-3.5-turbo');

    // Restore
    store.restoreSnapshot(snap);
    expect(store.get('llm', 'temperature')).toBe(0.5);
    expect(store.get('llm', 'model')).toBe('gpt-4o');
    expect(store.get('langgraph', 'recursion_limit')).toBe(50);
  });
});

describe('ConfigStore — exportSchema', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('exportSchema contains all sections', () => {
    const schema = store.exportSchema();
    expect('llm' in schema).toBe(true);
    expect('langgraph' in schema).toBe(true);
    expect('mastra' in schema).toBe(true);
    expect('vercel_ai' in schema).toBe(true);
  });

  it('exportSchema includes custom registered sections', () => {
    const customFields: Record<string, FieldSchema> = {
      batch_size: { name: 'batch_size', type: 'number', default: 10 },
    };
    store.registerSection('custom', customFields);
    const schema = store.exportSchema();
    expect('custom' in schema).toBe(true);
  });

  it('getFieldSchema returns schema for known field', () => {
    const schema = store.getFieldSchema('llm', 'temperature');
    expect(schema).toBeDefined();
    expect(schema!.type).toBe('number');
    expect(schema!.ge).toBe(0.0);
    expect(schema!.le).toBe(2.0);
  });

  it('getFieldSchema returns null for unknown', () => {
    expect(store.getFieldSchema('unknown', 'field')).toBeNull();
    expect(store.getFieldSchema('llm', 'unknown_field')).toBeNull();
  });
});
