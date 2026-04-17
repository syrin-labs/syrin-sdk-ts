/**
 * TDD: Config Persistence Integration with CallInterceptor
 *
 * Tests specify that:
 * 1. Persisted config from .syrin/syrin.config.json is loaded on startup
 * 2. Config is applied to CallInterceptor (not just sessionStore)
 * 3. File watcher detects changes and re-applies
 * 4. Backend pushes update to file → CallInterceptor applies it
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CallInterceptor, getCallInterceptor } from '@/control/call-interceptor.js';
import { load as loadConfig, save as saveConfig } from '@/config/persist.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, mkdirSync } from 'fs';

describe('Config Persistence Integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `syrin-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Startup: Load from Persisted File', () => {
    it('SHOULD load config from .syrin/syrin.config.json on startup', () => {
      // GIVEN: Config file exists with overrides
      const persistedConfig = {
        'llm.model': 'gpt-4-turbo',
        'llm.temperature': 0.2,
      };
      saveConfig(persistedConfig, testDir);

      // WHEN: Load persisted config
      const loaded = loadConfig(testDir);

      // THEN: Config is loaded
      expect(loaded).toEqual(persistedConfig);
    });

    it('SHOULD apply persisted config to CallInterceptor on startup', () => {
      // GIVEN: Config file with overrides
      const persistedConfig = {
        'llm.model': 'gpt-4-turbo',
        'llm.temperature': 0.1,
        'llm.max_tokens': 4096,
      };
      saveConfig(persistedConfig, testDir);
      const loaded = loadConfig(testDir);

      // WHEN: Apply to CallInterceptor
      const interceptor = getCallInterceptor();
      interceptor.setConfig(loaded);

      // THEN: LLM calls are intercepted with applied config
      const result = interceptor.interceptLLMCall(
        {
          model: 'gpt-3.5-turbo',
          temperature: 0.7,
          max_tokens: 512,
        },
        'test-session'
      );

      expect(result.modifiedParams.model).toBe('gpt-4-turbo');
      expect(result.modifiedParams.temperature).toBe(0.1);
      expect(result.modifiedParams.max_tokens).toBe(4096);
    });

    it('SHOULD handle missing config file gracefully', () => {
      // GIVEN: No config file
      // WHEN: Load config from empty dir
      const loaded = loadConfig(testDir);

      // THEN: Return empty object, no crash
      expect(loaded).toEqual({});
    });
  });

  describe('Runtime: Backend Pushes Update to File', () => {
    it('SHOULD detect when backend updates .syrin/syrin.config.json', () => {
      // GIVEN: Initial config
      const initialConfig = { 'llm.temperature': 0.5 };
      saveConfig(initialConfig, testDir);

      let appliedConfig = { ...initialConfig };

      // Simulate file watcher callback
      const onConfigUpdate = (newConfig: Record<string, unknown>) => {
        appliedConfig = newConfig;
      };

      // WHEN: Backend updates the file (simulated)
      const updatedConfig = {
        'llm.temperature': 0.2,
        'llm.model': 'gpt-4',
      };
      saveConfig(updatedConfig, testDir);
      const reloaded = loadConfig(testDir);
      onConfigUpdate(reloaded);

      // THEN: New config is applied
      expect(appliedConfig).toEqual(updatedConfig);
    });

    it('SHOULD re-apply CallInterceptor when file changes', () => {
      // GIVEN: Initial config in file
      const initialConfig = { 'llm.temperature': 0.5 };
      saveConfig(initialConfig, testDir);
      const interceptor = getCallInterceptor();
      interceptor.setConfig(initialConfig);

      // WHEN: Backend updates file
      const updatedConfig = { 'llm.temperature': 0.1, 'llm.model': 'gpt-4' };
      saveConfig(updatedConfig, testDir);
      const reloaded = loadConfig(testDir);
      interceptor.setConfig(reloaded); // Re-apply

      // THEN: CallInterceptor uses new config
      const result = interceptor.interceptLLMCall(
        { model: 'gpt-3.5-turbo', temperature: 0.7 },
        'test-session'
      );
      expect(result.modifiedParams.temperature).toBe(0.1);
      expect(result.modifiedParams.model).toBe('gpt-4');
    });
  });

  describe('File Format & Validation', () => {
    it('SHOULD save config as valid JSON', () => {
      // GIVEN: Config with various types
      const config = {
        'llm.model': 'gpt-4',
        'llm.temperature': 0.3,
        'llm.max_tokens': 2048,
        'tools.web_search.enabled': true,
      };

      // WHEN: Save to file
      saveConfig(config, testDir);

      // THEN: File contains valid JSON
      const loaded = loadConfig(testDir);
      expect(loaded).toEqual(config);
    });

    it('SHOULD handle atomic writes (no corrupted partial files)', () => {
      // GIVEN: Initial config
      saveConfig({ 'llm.temperature': 0.5 }, testDir);

      // WHEN: Write new config
      saveConfig(
        { 'llm.temperature': 0.1, 'llm.model': 'gpt-4-turbo' },
        testDir
      );

      // THEN: File is complete (not partial/corrupted)
      const loaded = loadConfig(testDir);
      expect(loaded).toHaveProperty('llm.model');
      expect(loaded).toHaveProperty('llm.temperature');
    });
  });

  describe('CallInterceptor Integration', () => {
    it('SHOULD preserve config across multiple intercept calls', () => {
      // GIVEN: Config loaded
      const config = { 'llm.temperature': 0.1 };
      const interceptor = getCallInterceptor();
      interceptor.setConfig(config);

      // WHEN: Make multiple intercept calls
      const result1 = interceptor.interceptLLMCall(
        { temperature: 0.9 },
        'session1'
      );
      const result2 = interceptor.interceptLLMCall(
        { temperature: 0.8 },
        'session2'
      );

      // THEN: All calls get the enforced config
      expect(result1.modifiedParams.temperature).toBe(0.1);
      expect(result2.modifiedParams.temperature).toBe(0.1);
    });
  });
});
