---
title: "Sessions & Windows"
description: "Session IDs, window types, lifecycle events, session TTL, and session metadata in the TypeScript SDK."
weight: 32
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
- The TypeScript SDK does NOT have a WindowType enum — use plain strings
- SESSION_CRASHED is NOT emitted automatically — emit it manually if needed
- SESSION_ENDED IS emitted automatically in withSession() finally block
- clearStaleSessions() is SYNCHRONOUS — it reads from the in-memory store
- getSessionId() reads from AsyncLocalStorage — returns the innermost active session
-->

> **AI Agent Quick Reference** — Open a daily session and get the session ID:
> ```typescript
> import { init, withSession, getSessionId } from "@syrin/sdk";
> const sdk = await init({ apiKey: "syrin_pk_..." }); // ← await
> const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;
> await withSession(sessionId, async () => {
>   const id = getSessionId(); // "u:alice:2026-04-24"
>   await client.chat.completions.create({ ... });
> });
> ```
> Common mistakes: (1) expecting a `WindowType` enum — TypeScript SDK doesn't have one, build the string yourself; (2) expecting `SESSION_CRASHED` to fire automatically on error — it does not in TypeScript; (3) not calling `clearStaleSessions()` in long-running servers — the session store grows indefinitely without it.

## Sessions: Where Your LLM Calls Go to Live Together

A session is a named group of LLM calls, log entries, and lifecycle events that belong together — typically one user's interaction with your agent in a given time window. Sessions give the dashboard its timeline view: everything Alice did today, in order, with costs and latencies.

---

## Session ID Formats

| Source | Example |
|--------|---------|
| Auto-generated | `ses_a1b2c3d4e5f6` |
| Manual | `"order-12345-chat"` |
| User + DAY | `"u:alice:2026-04-24"` |
| User + HOUR | `"u:alice:2026-04-24T14"` |
| User + WEEK | `"u:alice:2026-W17"` |
| User + MONTH | `"u:alice:2026-04"` |
| User + FOREVER | `"u:alice"` |

Deterministic session IDs are computed from UTC timestamps. The same user on the same day always gets the same session ID — safe to call from any replica without coordination.

---

## Window Types

The TypeScript SDK has no `WindowType` enum. Pass plain strings when computing session IDs:

| String | Alias | Reset Period | Session ID Example |
|--------|-------|--------------|-------------------|
| `"day"` | `"daily"` | UTC midnight | `u:alice:2026-04-24` |
| `"hour"` | `"hourly"` | Top of each hour | `u:alice:2026-04-24T14` |
| `"week"` | `"weekly"` | Monday 00:00 UTC | `u:alice:2026-W17` |
| `"month"` | `"monthly"` | 1st of month 00:00 UTC | `u:alice:2026-04` |
| `"forever"` | `"persistent"` | Never | `u:alice` |

### When to use each window

| Window | Use when |
|--------|----------|
| `"day"` | Most agents — one session per user per day is a natural conversation boundary |
| `"hour"` | High-frequency chatbots with many quick interactions |
| `"week"` | Low-frequency agents, weekly report generation |
| `"month"` | Monthly billing or review workflows |
| `"forever"` | User profiles, persistent assistants |

The `"day"` window is the right default for most agents.

---

## Computing Deterministic Session IDs

```typescript
import { withSession } from "@syrin/sdk";

function sessionIdForUser(userId: string, window: string = "day"): string {
  const now = new Date();
  switch (window) {
    case "day":
    case "daily":
      return `u:${userId}:${now.toISOString().slice(0, 10)}`;
    case "hour":
    case "hourly":
      return `u:${userId}:${now.toISOString().slice(0, 13)}`;
    case "week":
    case "weekly": {
      const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil(
        ((now.getTime() - startOfYear.getTime()) / 86_400_000 + startOfYear.getUTCDay() + 1) / 7
      );
      return `u:${userId}:${now.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    }
    case "month":
    case "monthly":
      return `u:${userId}:${now.toISOString().slice(0, 7)}`;
    case "forever":
    case "persistent":
      return `u:${userId}`;
    default:
      throw new Error(`Unknown window: ${window}`);
  }
}

const sessionId = sessionIdForUser("alice", "day");  // "u:alice:2026-04-24"

await withSession(sessionId, async () => {
  await client.chat.completions.create({ ... });
});
```

---

## Session Lifecycle Events

| Event | When |
|-------|------|
| `SESSION_STARTED` | Emitted automatically when `withSession()` block is entered |
| `SESSION_ENDED` | Always emitted in `finally` branch of `withSession()` |
| `SESSION_CRITERIA` | When `successCriteria` is provided to `sdk.sessions.start()` |
| `SESSION_CRASHED` | **Not automatic** — emit manually if you want crash visibility |

```typescript
// To surface crash events on the dashboard:
await withSession(sessionId, async () => {
  try {
    await runAgent();
  } catch (err) {
    sdk.emit("SESSION_CRASHED", {
      exception_type:    err instanceof Error ? err.constructor.name : "Error",
      exception_message: err instanceof Error ? err.message.slice(0, 500) : String(err),
    });
    throw err;  // re-throw so the caller handles it
  }
});
```

---

## Session TTL (Long-Running Servers)

The SDK keeps all sessions in an in-memory `SessionStore`. Without cleanup, the store grows indefinitely in long-running HTTP servers.

**Option 1: Pass `sessionTtlMs` to `init()`** — auto-eviction on the next access:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  sessionTtlMs: 3_600_000,  // evict sessions older than 1 hour
});
```

**Option 2: Call `clearStaleSessions()` on a schedule:**

```typescript
import { clearStaleSessions } from "@syrin/sdk";

setInterval(() => {
  const removed = clearStaleSessions(60 * 60 * 1000);  // 1 hour in ms
  if (removed > 0) console.log(`[Syrin] Cleared ${removed} stale sessions`);
}, 30 * 60 * 1000);  // run every 30 minutes
```

Or via the SDK instance:

```typescript
setInterval(() => sdk.clearStaleSessions(3_600_000), 1_800_000);
```

`clearStaleSessions` is synchronous and returns the number of sessions removed.

---

## Getting the Current Session ID

```typescript
import { getSessionId, withSession } from "@syrin/sdk";

// Inside a withSession block — returns the active session ID
await withSession("u:alice:2026-04-24", async () => {
  const sessionId = getSessionId();  // "u:alice:2026-04-24"
  console.log(sessionId);
});

// Outside a withSession block — returns the SDK's default session ID
const sessionId = getSessionId();  // "ses_a1b2c3..."
```

`getSessionId()` reads from `AsyncLocalStorage` — correctly resolves the innermost active session in nested or concurrent calls.

---

## Session Metadata

Attach arbitrary metadata to the `SESSION_STARTED` event:

```typescript
await withSession(sessionId, async () => {
  sdk.emit("SESSION_STARTED", {
    plan: "premium",
    ab_variant: "control",
    region: "us-east-1",
    app_version: "2.3.1",
  }, sessionId);

  const response = await client.chat.completions.create({ ... });
});
```

---

## Success Criteria

Record expected outcomes for a session — useful for automated quality measurement:

```typescript
const { sessionId, feedback } = await sdk.sessions.start({
  sessionId: `u:alice:${new Date().toISOString().slice(0, 10)}`,
  successCriteria: [
    "User's destination identified",
    "At least 3 hotel options presented",
    "Flights checked and presented",
    "Total trip cost estimated",
  ],
});

await withSession(sessionId, async () => {
  const result = await runTravelAgent(userRequest);

  if (allCriteriaMet(result)) {
    await sdk.sessions.rate(sessionId, "positive");
  } else {
    await sdk.sessions.rate(sessionId, "negative", { reason: "Some criteria not met" });
  }
});
```

When `successCriteria` is provided, a `SESSION_CRITERIA` event is emitted and the criteria are stored on the session for dashboard display.

---

## Multi-Server Session Continuity

Deterministic session IDs mean any replica of your service handling requests for the same user on the same day produces the same session ID — no session state needs to be shared between processes:

```typescript
// Replica 1 — handles alice's first request
await withSession(`u:alice:${new Date().toISOString().slice(0, 10)}`, async () => {
  await client.chat.completions.create({ ... });
});
// Session: "u:alice:2026-04-24"

// Replica 2 — handles alice's second request (different process, same day)
await withSession(`u:alice:${new Date().toISOString().slice(0, 10)}`, async () => {
  await client.chat.completions.create({ ... });
});
// Session: "u:alice:2026-04-24" — same! Events merge in the dashboard automatically.
```

---

## Session vs. Run vs. Trace

| Scope | Set via | Represents |
|-------|---------|------------|
| Session | `withSession(sessionId, ...)` | A user's interaction window across multiple agent runs |
| Run | `withAgent(agentId, ...)` | A single agent execution |
| Trace | Auto-generated | The full distributed call tree spanning all nested agent runs |

---

## Common Patterns

### HTTP Request Handler

```typescript
import express from "express";
import { init, withSession } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "chat-bot" });
const client = new OpenAI();
const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { userId, messages } = req.body;
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  await withSession(sessionId, async () => {
    const response = await client.chat.completions.create({ model: "gpt-4o", messages });
    res.json({ sessionId, content: response.choices[0].message.content });
  });
});
```

### Batch Job

```typescript
const batchSessionId = `batch:nightly-report:${new Date().toISOString().slice(0, 10)}`;

await withSession(batchSessionId, async () => {
  for (const item of items) {
    await client.chat.completions.create({ ... });
  }
});
```

### Explicit Session ID for Backend Correlation

```typescript
// Tie the Syrin session to your order ID for easy cross-system lookup
async function handleOrderChat(orderId: string, message: string): Promise<string> {
  return withSession(`order-${orderId}`, async () => {
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: message }],
    });
    return response.choices[0].message.content ?? "";
  });
}
```
