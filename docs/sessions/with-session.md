---
title: "withSession()"
description: "Scope all LLM calls to a named session using Node's AsyncLocalStorage. One function call — everything inside is attributed."
weight: 30
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
- withSession() is ASYNC — it returns Promise<T>, you MUST await it
- withSession() does NOT automatically emit SESSION_CRASHED — emit manually
- withSession() DOES emit SESSION_ENDED automatically in the finally branch
- LLM calls WITHOUT withSession() are still captured — they land in the default session
- Nested withSession() calls are safe — inner wins, outer restored on exit
- AsyncLocalStorage prevents cross-contamination between concurrent withSession() calls
-->

> **AI Agent Quick Reference** — The minimal withSession pattern:
> ```typescript
> import { init, withSession } from "@syrin/sdk";
> const sdk = await init({ apiKey: "syrin_pk_..." }); // ← await
> await withSession("u:alice:2026-04-27", async () => { // ← await
>   await client.chat.completions.create({ ... }); // attributed to u:alice:2026-04-27
> });
> ```
> Common mistakes: (1) forgetting `await` on `withSession()` — it returns a Promise; (2) passing a sync function (`() => { ... }`) instead of `async () => { ... }` — `withSession` expects `() => Promise<T>`; (3) expecting `SESSION_CRASHED` to fire automatically on error — emit it manually.

## One Function. Everything Scoped.

`withSession()` is the primary way to open a session in the TypeScript SDK. Pass a session ID and an async function — every LLM call inside that function is automatically attributed to the session. No classes, no context managers, no decorators.

```typescript
import { init, withSession } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });
const client = new OpenAI();

await withSession("u:alice:2026-04-27", async () => {
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "What is the capital of France?" }],
  });
  console.log(response.choices[0].message.content);
  // → Paris is the capital of France.
});

// Open app.syrin.ai → Sessions to see:
//   Session: u:alice:2026-04-27
//   ● SESSION_STARTED     14:32:00
//   ● LLM_CALL            gpt-4o  in=14  out=8  $0.0001  423ms
//   ● SESSION_ENDED       14:32:00
```

---

## Function Signature

```typescript
function withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | `string` | The session ID to activate for the duration of `fn` |
| `fn` | `() => Promise<T>` | Async callback — all SDK calls inside are scoped to `sessionId` |

Returns `Promise<T>` — resolves to whatever `fn` returns. Errors propagate normally; `SESSION_ENDED` is always emitted in the `finally` branch regardless.

---

## How to Get the Current Session ID Inside the Block

```typescript
import { withSession, getSessionId } from "@syrin/sdk";

await withSession("u:alice:2026-04-24", async () => {
  const sessionId = getSessionId();  // "u:alice:2026-04-24"
  console.log(`Running in session: ${sessionId}`);
  await client.chat.completions.create({ ... });
});

// Outside: returns the SDK's default session ID
const defaultId = getSessionId();  // "ses_a1b2c3..."
```

`getSessionId()` reads from `AsyncLocalStorage` — resolves the innermost active session in nested or concurrent calls.

---

## Session ID Strategies

The session ID is a plain string. Three common strategies:

### 1. Deterministic from user + window (most common)

```typescript
// One session per user per day
const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

// One session per user per hour
const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 13)}`;

// One permanent session per user
const sessionId = `u:${userId}`;
```

### 2. Correlated with your data model

```typescript
const sessionId = `order-${orderId}`;
const sessionId = `ticket-${ticketId}`;
const sessionId = `conv-${conversationId}`;
```

### 3. Auto-generated per invocation

```typescript
import { randomUUID } from "crypto";

const sessionId = `ses_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
```

---

## What Happens When the Block Throws

Errors propagate to the caller — `withSession` does not swallow them. `SESSION_ENDED` is emitted in the `finally` branch regardless.

> **Python vs TypeScript difference:** The Python SDK emits `SESSION_CRASHED` automatically on unhandled exceptions. The TypeScript SDK does not. Emit it manually if you want crash visibility on the dashboard:

```typescript
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

## Backed by AsyncLocalStorage — No Cross-Contamination

`withSession` uses Node.js built-in `AsyncLocalStorage`. Each call creates a new storage context that flows through all async continuations — but never bleeds into sibling or parent contexts.

Hundreds of concurrent `withSession` calls on the same Node.js process will never interfere with each other:

```typescript
// These run concurrently. Each user's LLM calls stay in their own session.
await Promise.all([
  withSession(`u:alice:${today}`, () => handleRequest(aliceMessages)),
  withSession(`u:bob:${today}`,   () => handleRequest(bobMessages)),
  withSession(`u:carol:${today}`, () => handleRequest(carolMessages)),
]);

// Alice's calls land in Alice's session. Bob's in Bob's. No locking, no coordination.
```

---

## Common Patterns

### Pattern 1: Express Request Handler

```typescript
import express from "express";
import OpenAI from "openai";
import { init, withSession, getSessionId } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "chat-bot" });
const openai = new OpenAI();
const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { userId, messages } = req.body as { userId: string; messages: OpenAI.ChatCompletionMessageParam[] };
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  await withSession(sessionId, async () => {
    const response = await openai.chat.completions.create({ model: "gpt-4o", messages });
    res.json({ sessionId: getSessionId(), content: response.choices[0].message.content });
  });
});
```

### Pattern 2: Agent Scoping Inside withSession

```typescript
import { withSession, withAgent } from "@syrin/sdk";

await withSession(`u:${userId}:${today}`, async () => {
  await withAgent("researcher", async (ctx) => {
    // session_id = "u:alice:2026-04-27", agent_id = "researcher"
    const research = await client.chat.completions.create({ ... });
  });

  await withAgent("writer", async (ctx) => {
    // session_id = "u:alice:2026-04-27", agent_id = "writer"
    const article = await client.chat.completions.create({ ... });
  });
});
```

`withAgent()` emits `AGENT_RUN_STARTED` / `AGENT_RUN_ENDED` automatically. The session ID is inherited from the outer `withSession()`.

### Pattern 3: Explicit Session ID for Correlation

```typescript
import { withSession } from "@syrin/sdk";

async function handleOrderChat(orderId: string, message: string): Promise<string> {
  const sessionId = `order-${orderId}`;

  return withSession(sessionId, async () => {
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: message }],
    });
    return response.choices[0].message.content ?? "";
  });
}
```

### Pattern 4: Concurrent Users

```typescript
app.post("/batch", async (req, res) => {
  const { requests } = req.body as { requests: Array<{ userId: string; prompt: string }> };
  const today = new Date().toISOString().slice(0, 10);

  const results = await Promise.all(
    requests.map(({ userId, prompt }) =>
      withSession(`u:${userId}:${today}`, async () => {
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
        });
        return { userId, content: response.choices[0].message.content };
      })
    )
  );

  res.json({ results });
});
```

---

## Nested withSession

Inner `withSession` calls win. On exit, the outer session ID is restored automatically:

```typescript
await withSession("outer-session", async () => {
  // Active: "outer-session"

  await withSession("inner-session", async () => {
    // Active: "inner-session"
    await openai.chat.completions.create({ ... });
  });

  // Active: "outer-session" again
  await openai.chat.completions.create({ ... });
});
```

---

## LLM Calls Without withSession

If you make LLM calls without `withSession`, they are still captured — they land in the SDK's default session (the `ses_...` ID generated at `init()` time). Nothing is silently dropped.

```typescript
const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });

// No withSession — still captured, attributed to the default session
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});
```

For production workloads with real users, always use `withSession` so calls are attributed to the correct user session.
