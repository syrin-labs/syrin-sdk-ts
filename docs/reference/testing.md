---
title: "Testing Guide"
description: "Unit test patterns for Syrin-instrumented agents — offline mode, mocking fetch, verifying events, and shared test fixtures with Vitest."
weight: 72
---

<!--
SYRIN SDK — CANONICAL REFERENCE (TypeScript/JavaScript)
Package: @syrin/sdk  |  Import: import { init } from "@syrin/sdk"
Source of truth: https://github.com/syrin-labs/syrin-sdk-ts

AI AGENTS READING THIS: The statements in this document are the authoritative API contract.
Do not infer undocumented parameters. Do not assume methods exist beyond those listed.
If something is not documented here, it is not part of the public API.

IMPORTANT CORRECTIONS TO COMMON AI MISCONCEPTIONS:
- init() is ASYNC — it returns Promise<SyrinSDK>, you MUST await it
- shutdown() is ASYNC — it returns Promise<void>, you MUST await it in afterEach
- The SDK uses global fetch (Node 18+) — mock fetch via vi.stubGlobal, NOT httpx
- offline: true disables ALL network calls — events are discarded at drain time
- Always call shutdown() in afterEach to prevent state leaking between tests
- vitest.config.ts MUST set environment: "node" for AsyncLocalStorage to work
-->

> **AI Agent Quick Reference** — The minimal test setup:
> ```typescript
> import { describe, it, expect, afterEach } from "vitest";
> import { init, shutdown, withSession } from "@syrin/sdk";
>
> afterEach(async () => { await shutdown(); }); // ← await + afterEach
>
> it("runs agent in offline mode", async () => {
>   const sdk = await init({ apiKey: "test", offline: true }); // ← await
>   const model = sdk.agent("my-agent").cfg("llm.model", "gpt-4o");
>   expect(model).toBe("gpt-4o");
> });
> ```
> Common mistakes: (1) not calling `await shutdown()` in `afterEach` — test state leaks between tests; (2) mocking `httpx` — the TypeScript SDK uses native `fetch`; (3) missing `environment: "node"` in `vitest.config.ts` — `AsyncLocalStorage` requires Node environment.

## Testing Without Sending Events to Production

Testing Syrin-instrumented agents is a two-step setup: use offline mode to disable all network calls, or mock `fetch` to intercept and inspect what would be sent. All SDK functions work normally in both modes.

### The Golden Rule

Always use a fresh SDK instance per test. Call `await shutdown()` in `afterEach`. This prevents test state from leaking between tests.

> **Python vs TypeScript:** The TypeScript SDK uses `fetch` (Node 18+ built-in) instead of `httpx`. Mock it via Vitest's `vi.stubGlobal('fetch', mockFn)` — not `httpx.post`.

---

## Vitest Configuration

Ensure your `vitest.config.ts` sets the Node environment — required for `AsyncLocalStorage`:

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",  // ← required for AsyncLocalStorage
    globals: true,
  },
});
```

---

## Pattern 1: Offline Mode (Simplest)

Offline mode disables all network calls. Events are discarded instead of sent. `cfg()` always returns `defaultValue`. Use this for unit tests that only need to verify logic — not telemetry.

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { init, shutdown, withSession } from "@syrin/sdk";

afterEach(async () => {
  await shutdown();
});

describe("offline mode", () => {
  it("cfg() returns default", async () => {
    const sdk = await init({ apiKey: "test_key", agentId: "test-agent", offline: true });
    const model = sdk.agent("test-agent").cfg("llm.model", "gpt-4o");
    expect(model).toBe("gpt-4o");
  });

  it("withSession() runs the callback", async () => {
    await init({ apiKey: "test_key", offline: true });

    let ran = false;
    await withSession("ses_test_001", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
```

---

## Pattern 2: Mocking fetch

For tests that need to verify what's sent to the backend, or to simulate backend responses including governance actions:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { init, shutdown, withSession, log } from "@syrin/sdk";

afterEach(async () => {
  await shutdown();
});

describe("event emission", () => {
  it("emits CUSTOM_LOG", async () => {
    const postedPayloads: unknown[] = [];

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/ingest")) {
        postedPayloads.push(JSON.parse(init?.body as string));
      }
      return {
        ok: true,
        json: async () => ({ ok: true }),
      } as Response;
    });

    vi.stubGlobal("fetch", mockFetch);

    const sdk = await init({
      apiKey: "test",
      agentId: "test",
      batchSize: 1,
      idleFlushMs: 100,
    });

    await withSession("ses_test", async () => {
      sdk.emit("SESSION_STARTED", {});
      log("Test log entry");
    });

    await sdk.flush();
    await shutdown();
    vi.unstubAllGlobals();

    const allEvents = postedPayloads.flatMap((p: any) => p.events ?? []);
    const eventTypes = allEvents.map((e: any) => e.event_type);

    expect(eventTypes).toContain("CUSTOM_LOG");
  });
});
```

---

## Pattern 3: Testing Agent Functions

Test your agent's business logic independently of Syrin:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { init, shutdown, withAgent } from "@syrin/sdk";

afterEach(async () => {
  await shutdown();
});

// Your agent function
async function myAgent(userMessage: string, sdk: any): Promise<string> {
  return withAgent("assistant", async () => {
    const model = sdk.agent("assistant").cfg("llm.model", "gpt-4o") as string;
    return `Response to: ${userMessage} (model: ${model})`;
  });
}

describe("agent function", () => {
  it("returns a response", async () => {
    const sdk = await init({ apiKey: "test", offline: true });
    const result = await myAgent("Hello!", sdk);
    expect(result).toContain("Hello!");
  });

  it("cfg() returns default in offline mode", async () => {
    const sdk = await init({ apiKey: "test", offline: true });
    const model = sdk.agent("assistant").cfg("llm.model", "gpt-4o") as string;
    expect(model).toBe("gpt-4o");
  });
});
```

---

## Pattern 4: Testing Governance Stop

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { init, shutdown, GovernanceStopError } from "@syrin/sdk";

afterEach(async () => {
  await shutdown();
});

describe("governance", () => {
  it("GovernanceStopError is exported and constructable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        governance: {
          actions: [{ type: "stop", reason: "Cost limit exceeded" }],
        },
      }),
    } as Response)));

    await init({ apiKey: "test", batchSize: 1 });

    // Verify the error class is correctly exported
    const err = new GovernanceStopError("Cost limit exceeded", undefined, null);
    expect(err).toBeInstanceOf(GovernanceStopError);
    expect(err.reason).toBe("Cost limit exceeded");
    expect(err).toBeInstanceOf(Error);
    // NOT instanceof SyrinError — GovernanceStopError extends Error directly

    await shutdown();
    vi.unstubAllGlobals();
  });
});
```

---

## Pattern 5: Testing Feedback

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { init, shutdown, AlreadyRatedError, SessionNotFoundError } from "@syrin/sdk";

afterEach(async () => {
  await shutdown();
});

describe("session feedback", () => {
  it("calls the feedback endpoint", async () => {
    const feedbackCalls: unknown[] = [];

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/feedback")) {
        feedbackCalls.push(JSON.parse(init?.body as string));
      }
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });

    vi.stubGlobal("fetch", mockFetch);

    const sdk = await init({ apiKey: "test", agentId: "test" });
    await sdk.sessions.rate("ses_test_001", "positive", { reason: "Great output" });

    await shutdown();
    vi.unstubAllGlobals();

    expect(feedbackCalls).toHaveLength(1);
    expect((feedbackCalls[0] as any).rating).toBe("positive");
    expect((feedbackCalls[0] as any).reason).toBe("Great output");
  });

  it("throws AlreadyRatedError on 409", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "Already rated" }),
    } as Response));

    vi.stubGlobal("fetch", mockFetch);

    const sdk = await init({ apiKey: "test" });

    await expect(
      sdk.sessions.rate("ses_001", "positive")
    ).rejects.toThrow(AlreadyRatedError);

    await shutdown();
    vi.unstubAllGlobals();
  });

  it("throws SessionNotFoundError on 404", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "Not found" }),
    } as Response));

    vi.stubGlobal("fetch", mockFetch);

    const sdk = await init({ apiKey: "test" });

    await expect(
      sdk.sessions.rate("ses_missing", "negative")
    ).rejects.toThrow(SessionNotFoundError);

    await shutdown();
    vi.unstubAllGlobals();
  });
});
```

---

## Pattern 6: Testing withAgent() Context

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { init, shutdown, withSession, withAgent, getSessionId } from "@syrin/sdk";

afterEach(async () => {
  await shutdown();
});

describe("context propagation", () => {
  it("withSession propagates session ID", async () => {
    await init({ apiKey: "test", offline: true });

    let sessionId: string | undefined;
    await withSession("ses_test", async () => {
      sessionId = getSessionId();
    });

    expect(sessionId).toBe("ses_test");
  });

  it("withAgent receives RunContext", async () => {
    const sdk = await init({ apiKey: "test", offline: true });

    let agentId: string | undefined;
    await withAgent("researcher", async (ctx) => {
      agentId = ctx.agentId;
    });

    expect(agentId).toBe("researcher");
  });
});
```

---

## Shared Test Fixture

Avoid repeating `beforeEach`/`afterEach` in every file:

```typescript
// test/helpers.ts
import { beforeEach, afterEach } from "vitest";
import { init, shutdown } from "@syrin/sdk";
import type { SyrinSDKInstance } from "@syrin/sdk";

export function useOfflineSdk(agentId = "test-agent"): { sdk: SyrinSDKInstance } {
  const ctx = {} as { sdk: SyrinSDKInstance };

  beforeEach(async () => {
    ctx.sdk = await init({ apiKey: "test_key", agentId, offline: true });
  });

  afterEach(async () => {
    await shutdown();
  });

  return ctx;
}
```

```typescript
// In your tests
import { describe, it, expect } from "vitest";
import { useOfflineSdk } from "./helpers";

describe("my agent", () => {
  const { sdk } = useOfflineSdk();

  it("cfg() returns default", () => {
    const model = sdk.agent("test-agent").cfg("llm.model", "gpt-4o") as string;
    expect(model).toBe("gpt-4o");
  });
});
```

---

## Testing Checklist

| Check | How |
|-------|-----|
| No real API calls in tests | `offline: true` or mock `fetch` |
| No test state leaking | `await shutdown()` in `afterEach` |
| AsyncLocalStorage working | `environment: "node"` in `vitest.config.ts` |
| Events verified | Mock `fetch`, call `await sdk.flush()`, inspect payloads |
| Governance errors tested | Construct `GovernanceStopError` directly or mock `/ingest` response |
| Feedback errors tested | Mock `fetch` to return 409/404 status codes |
