/**
 * Integration test: Config sync from backend to CallInterceptor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigSync } from '@/core/config-sync.js';
import { CallInterceptor, getCallInterceptor } from '@/control/call-interceptor.js';

describe('ConfigSync — Remote Config Integration', () => {
  let configSync: ConfigSync;
  const testOpts = {
    agentId: 'test-agent-ts-1',
    backendUrl: 'http://localhost:4000',
    apiKey: 'syrin_21d9db6fe254b707745c1971a615c72c54f0562cd009215b',
    offline: false,
  };

  beforeEach(() => {
    configSync = new ConfigSync(testOpts);
  });

  afterEach(() => {
    configSync.stopPolling();
  });

  it.skip('fetches and applies config overrides on initialize (requires live backend at localhost:4000)', async () => {
    // This agent should have config from our earlier test
    await configSync.initialize();

    const interceptor = getCallInterceptor();
    const testParams = { model: 'gpt-3.5-turbo', temperature: 0.7 };
    const { modifiedParams } = interceptor.interceptLLMCall(testParams, 'test-session');

    // Should be overridden to gpt-4o with temp 0.2
    expect(modifiedParams.model).toBe('gpt-4o');
    expect(modifiedParams.temperature).toBe(0.2);
  });

  it.skip('polls for config updates (requires live backend at localhost:4000)', async () => {
    await configSync.initialize();

    // Start polling
    configSync.startPolling(2000);

    // Wait for a polling cycle
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Config should still be applied
    const interceptor = getCallInterceptor();
    const { modifiedParams } = interceptor.interceptLLMCall({ model: 'gpt-3.5-turbo' }, 'test-session');
    expect(modifiedParams.model).toBe('gpt-4o');
  });

  it('handles fetch errors gracefully', async () => {
    const syncWithBadUrl = new ConfigSync({
      ...testOpts,
      backendUrl: 'http://localhost:9999', // Non-existent port
    });

    // Should not throw
    await syncWithBadUrl.initialize();
    expect(true).toBe(true); // If we get here, it didn't crash
  });
});
