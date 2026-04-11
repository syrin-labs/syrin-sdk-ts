/**
 * Tests: Config persistence — parity with Python SDK's _config_persist.py
 *
 * Covers:
 *  1. load() returns {} when file does not exist
 *  2. save() then load() round-trips the config
 *  3. save() writes to .syrin/syrin.config.json
 *  4. load() returns {} when file contains invalid JSON
 *  5. save() is non-fatal when the directory cannot be created
 *  6. Multiple save() calls overwrite (not merge) the file
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';

// We test the module against a temporary directory
const TEST_DIR = join(tmpdir(), `syrin-test-${Date.now()}`);

describe('ConfigPersist', () => {
  let load: (dir?: string) => Record<string, unknown>;
  let save: (overrides: Record<string, unknown>, dir?: string) => void;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const mod = await import('@/config/persist') as typeof import('@/config/persist');
    load = (dir = TEST_DIR) => mod.load(dir);
    save = (overrides, dir = TEST_DIR) => mod.save(overrides, dir);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  // 1. load() returns {} when no file exists
  it('returns {} when config file does not exist', () => {
    const result = load();
    expect(result).toEqual({});
  });

  // 2. save() + load() round-trips
  it('round-trips config through save() and load()', () => {
    const config = { 'llm.temperature': 0.3, 'llm.model': 'gpt-4o', 'prompt.system_prompt': 'Hi' };
    save(config);
    const loaded = load();
    expect(loaded).toEqual(config);
  });

  // 3. File is at the correct path
  it('writes to <dir>/.syrin/syrin.config.json', () => {
    save({ 'llm.temperature': 0.5 });
    const expectedPath = join(TEST_DIR, '.syrin', 'syrin.config.json');
    expect(existsSync(expectedPath)).toBe(true);
  });

  // 4. load() returns {} for invalid JSON
  it('returns {} when the file contains invalid JSON', () => {
    const { writeFileSync, mkdirSync: mkdir } = require('fs') as typeof import('fs');
    mkdir(join(TEST_DIR, '.syrin'), { recursive: true });
    writeFileSync(join(TEST_DIR, '.syrin', 'syrin.config.json'), 'not json!!!', 'utf8');

    const result = load();
    expect(result).toEqual({});
  });

  // 5. save() is non-fatal on write error (read-only dir)
  it('does not throw when save fails due to filesystem error', () => {
    // Pass an impossible path — non-fatal
    expect(() => save({ 'llm.temperature': 0.7 }, '/dev/null/impossible')).not.toThrow();
  });

  // 6. Second save() overwrites first
  it('overwrites on second save()', () => {
    save({ 'llm.temperature': 0.3 });
    save({ 'llm.model': 'gpt-4o' });
    const result = load();
    // Second save should contain only the new keys (overwrite, not merge)
    expect(result).toEqual({ 'llm.model': 'gpt-4o' });
    expect(result['llm.temperature']).toBeUndefined();
  });
});
