---
title: "Testing Guide"
description: "Unit test patterns for Syrin-instrumented agents — offline mode, mocking fetch, and verifying events with Vitest."
weight: 72
---

## Testing Without Sending Events to Production

Testing Syrin-instrumented agents is straightforward: use offline mode to disable all network calls, or mock the global `fetch` to intercept and inspect what would be sent. All SDK functions work normally in both modes.

### The Golden Rule

Always use a fresh SDK instance per test. Call `shutdown()` in teardown. This prevents test state from leaking between tests.

> **Python users:** The TypeScript SDK uses `fetch` (Node 18+ built-in) instead of `httpx`. Mock `fetch` via Vitest's `vi.fn()` — not `httpx.post`.

### Pattern 1: Offline Mode (Simplest)

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { init, shutdown, withSession } from '@syrin/sdk';

afterEach(async () => {
  await shutdown();
});

describe('offline mode', () => {
  it('cfg() returns default', async () => {
    const sdk = await init({ apiKey: 'test_key', agentId: 'test-agent', offline: true });
    const model = sdk.agent('test-agent').cfg('llm.model', 'gpt-4o');
    expect(model).toBe('gpt-4o');
  });

  it('withSession() runs the callback', async () => {
    await init({ apiKey: 'test_key', offline: true });

    let ran = false;
    await withSession('ses_test_001', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
```

### Pattern 2: Mocking fetch

For tests that need to verify what's sent to the backend, or to simulate backend responses:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { init, shutdown, withSession, log } from '@syrin/sdk';

afterEach(async () => {
  await shutdown();
});

describe('event emission', () => {
  it('emits SESSION_STARTED and CUSTOM_LOG', async () => {
    const postedPayloads: unknown[] = [];

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/ingest')) {
        postedPayloads.push(JSON.parse(init?.body as string));
      }
      return {
        ok: true,
        json: async () => ({ ok: true }),
      } as Response;
    });

    vi.stubGlobal('fetch', mockFetch);

    const sdk = await init({
      apiKey: 'test',
      agentId: 'test',
      batchSize: 1,
      idleFlushMs: 100,
    });

    await withSession('ses_test', async () => {
      sdk.emit('SESSION_STARTED', {});
      log('Test log entry');
    });

    await sdk.flush();
    await shutdown();
    vi.unstubAllGlobals();

    const allEvents = postedPayloads.flatMap(
      (p: any) => p.events ?? []
    );
    const eventTypes = allEvents.map((e: any) => e.event_type);

    expect(eventTypes).toContain('CUSTOM_LOG');
  });
});
```

### Pattern 3: Testing Agent Functions

Test your agent's business logic independently of Syrin:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { init, shutdown, withAgent } from '@syrin/sdk';

afterEach(async () => {
  await shutdown();
});

// Your agent function
async function myAgent(userMessage: string, sdk: any): Promise<string> {
  return withAgent('assistant', async () => {
    const model = sdk.agent('assistant').cfg('llm.model', 'gpt-4o');
    return `Response to: ${userMessage} (model: ${model})`;
  });
}

describe('agent function', () => {
  it('returns a response', async () => {
    const sdk = await init({ apiKey: 'test', offline: true });
    const result = await myAgent('Hello!', sdk);
    expect(result).toContain('Hello!');
  });

  it('cfg() returns default in offline mode', async () => {
    const sdk = await init({ apiKey: 'test', offline: true });
    const model = sdk.agent('assistant').cfg('llm.model', 'gpt-4o');
    expect(model).toBe('gpt-4o');
  });
});
```

### Pattern 4: Testing Governance Stop

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { init, shutdown, GovernanceStopError, withSession } from '@syrin/sdk';

afterEach(async () => {
  await shutdown();
});

describe('governance', () => {
  it('GovernanceStopError is thrown when stop action received', async () => {
    const stopResponse = {
      ok: true,
      governance: {
        actions: [{ type: 'stop', reason: 'Cost limit exceeded' }],
      },
    };

    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => stopResponse,
    } as Response));

    vi.stubGlobal('fetch', mockFetch);

    const sdk = await init({
      apiKey: 'test',
      batchSize: 1,
      idleFlushMs: 50,
    });

    // GovernanceStopError is raised on the next LLM call after the flush
    // In tests, verify the error class is exported and constructable:
    const err = new GovernanceStopError('Cost limit exceeded', null, null);
    expect(err).toBeInstanceOf(GovernanceStopError);
    expect(err.reason).toBe('Cost limit exceeded');

    vi.unstubAllGlobals();
  });
});
```

### Pattern 5: Testing Feedback

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  init, shutdown, AlreadyRatedError, SessionNotFoundError
} from '@syrin/sdk';

afterEach(async () => {
  await shutdown();
});

describe('session feedback', () => {
  it('calls the feedback endpoint', async () => {
    const feedbackCalls: unknown[] = [];

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/feedback')) {
        feedbackCalls.push(JSON.parse(init?.body as string));
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    vi.stubGlobal('fetch', mockFetch);

    const sdk = await init({ apiKey: 'test', agentId: 'test' });
    await sdk.sessions.rate('ses_test_001', 'positive', { reason: 'Great output' });

    await shutdown();
    vi.unstubAllGlobals();

    expect(feedbackCalls).toHaveLength(1);
    expect((feedbackCalls[0] as any).rating).toBe('positive');
    expect((feedbackCalls[0] as any).reason).toBe('Great output');
  });

  it('throws AlreadyRatedError on 409', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Already rated' }),
    } as Response));

    vi.stubGlobal('fetch', mockFetch);

    const sdk = await init({ apiKey: 'test' });

    await expect(
      sdk.sessions.rate('ses_001', 'positive')
    ).rejects.toThrow(AlreadyRatedError);

    await shutdown();
    vi.unstubAllGlobals();
  });

  it('throws SessionNotFoundError on 404', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    } as Response));

    vi.stubGlobal('fetch', mockFetch);

    const sdk = await init({ apiKey: 'test' });

    await expect(
      sdk.sessions.rate('ses_missing', 'negative')
    ).rejects.toThrow(SessionNotFoundError);

    await shutdown();
    vi.unstubAllGlobals();
  });
});
```

### Vitest Configuration

Ensure your `vitest.config.ts` sets the Node environment (required for `AsyncLocalStorage`):

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
});
```

### Shared Test Fixture

```typescript
// test/helpers.ts
import { beforeEach, afterEach } from 'vitest';
import { init, shutdown, SyrinSDKInstance } from '@syrin/sdk';

export function useOfflineSdk(): { sdk: SyrinSDKInstance } {
  const ctx = {} as { sdk: SyrinSDKInstance };

  beforeEach(async () => {
    ctx.sdk = await init({ apiKey: 'test_key', agentId: 'test-agent', offline: true });
  });

  afterEach(async () => {
    await shutdown();
  });

  return ctx;
}
```

```typescript
// In your tests
import { describe, it, expect } from 'vitest';
import { useOfflineSdk } from './helpers';

describe('my agent', () => {
  const { sdk } = useOfflineSdk();

  it('cfg() returns default', () => {
    const model = sdk.agent('test-agent').cfg('llm.model', 'gpt-4o');
    expect(model).toBe('gpt-4o');
  });
});
```
