---
title: "withSession()"
description: "Scope all LLM calls to a named session using Node's AsyncLocalStorage. One function call — everything inside is attributed."
weight: 30
---

## One Function. Everything Scoped.

`withSession()` is the primary way to open a session in the TypeScript SDK. Pass a session ID and an async function — every LLM call inside that function is automatically attributed to the session. No classes, no context managers, no decorators. Just a function call.

```typescript
import { init, withSession } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_...", agentId: "my-agent" });

await withSession("u:alice:2026-04-27", async () => {
  const response = await openai.chat.completions.create({
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

Everything inside the callback — LLM calls, agent runs, workflow steps, emitted events — is tagged with `u:alice:2026-04-27` at [app.syrin.ai](https://app.syrin.ai).

---

### Function Signature

```typescript
function withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | `string` | The session ID to activate for the duration of `fn` |
| `fn` | `() => Promise<T>` | Async callback — all SDK calls inside are scoped to `sessionId` |

Returns a `Promise<T>` — resolves to whatever `fn` returns. Errors propagate normally; `SESSION_ENDED` is always emitted in the `finally` branch.

---

### How to Get the Current Session ID Inside the Block

Use `getSessionId()` — it reads from `AsyncLocalStorage` and returns the session ID of the innermost active `withSession` call:

```typescript
import { withSession, getSessionId } from '@syrin/sdk';

await withSession('u:alice:2026-04-24', async () => {
  const sessionId = getSessionId();  // "u:alice:2026-04-24"
  console.log(`Running in session: ${sessionId}`);

  await openai.chat.completions.create({ ... });
});
```

Outside a `withSession` block, `getSessionId()` returns the SDK's default session ID (the auto-generated `ses_...` from `init()`).

---

### Session ID Strategies

The session ID is a plain string — you decide what it means. There are three common strategies:

#### 1. Deterministic from user + window

Compute it yourself before calling `withSession`. The same formula on any replica produces the same ID, so the dashboard merges all events automatically:

```typescript
// One session per user per day (most common)
const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

// One session per user per hour
const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 13)}`;

// One permanent session per user
const sessionId = `u:${userId}`;
```

#### 2. Correlated with your data model

Tie the session to an entity in your system for easy cross-system lookup:

```typescript
const sessionId = `order-${orderId}`;
const sessionId = `ticket-${ticketId}`;
const sessionId = `conv-${conversationId}`;
```

#### 3. Auto-generated per invocation

For batch jobs or one-off runs where sessions don't need to merge:

```typescript
import { randomUUID } from 'crypto';

const sessionId = `ses_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
```

---

### What Happens When the Block Throws

Errors inside the `withSession` callback propagate to the caller as normal — `withSession` does not swallow them. `SESSION_ENDED` is emitted in the `finally` branch regardless.

> **Difference from Python:** The Python SDK emits `SESSION_CRASHED` automatically on unhandled exceptions. The TypeScript SDK does not. If you want crash visibility on the dashboard, emit it explicitly:

```typescript
await withSession(sessionId, async () => {
  try {
    await runAgent();
  } catch (err) {
    sdk.emit('SESSION_CRASHED', {
      exception_type: err instanceof Error ? err.constructor.name : 'Error',
      exception_message: err instanceof Error ? err.message.slice(0, 500) : String(err),
    });
    throw err;  // re-throw so the caller handles it
  }
});
```

---

### Backed by AsyncLocalStorage — No Cross-Contamination

`withSession` uses Node's built-in `AsyncLocalStorage`. Each call creates a new storage context that flows through all async continuations (await chains, Promises, callbacks) spawned within it — but never bleeds into sibling or parent contexts.

This means you can run hundreds of concurrent `withSession` calls on the same Node.js process and they will never interfere with each other:

```typescript
// These run concurrently. Each user's LLM calls stay in their own session.
await Promise.all([
  withSession(`u:alice:${today}`, () => handleRequest(aliceMessages)),
  withSession(`u:bob:${today}`,   () => handleRequest(bobMessages)),
  withSession(`u:carol:${today}`, () => handleRequest(carolMessages)),
]);
```

Alice's calls land in Alice's session. Bob's in Bob's. No locking, no coordination.

---

### Common Patterns

#### Pattern 1: Express Request Handler

```typescript
import express from 'express';
import OpenAI from 'openai';
import { init, withSession, getSessionId } from '@syrin/sdk';

const sdk = await init({ apiKey: 'syrin_...', agentId: 'chat-bot' });
const openai = new OpenAI();
const app = express();
app.use(express.json());

app.post('/chat', async (req, res) => {
  const { userId, messages } = req.body as { userId: string; messages: OpenAI.ChatCompletionMessageParam[] };
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  await withSession(sessionId, async () => {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
    });

    res.json({
      sessionId: getSessionId(),
      content: response.choices[0].message.content,
    });
  });
});
```

---

#### Pattern 2: Agent Scoping Inside withSession

Use `withAgent()` inside a `withSession()` block to add agent-level scoping. All events emitted inside the `withAgent` block carry both the session ID and the agent ID:

```typescript
import { withSession, withAgent } from '@syrin/sdk';

await withSession(`u:${userId}:${today}`, async () => {
  // Outer session context
  await withAgent('researcher', async (ctx) => {
    // ctx.agentId = "researcher"
    // Events: session_id + agent_id both stamped
    const research = await openai.chat.completions.create({ ... });
    return research;
  });

  await withAgent('writer', async (ctx) => {
    const article = await openai.chat.completions.create({ ... });
    return article;
  });
});
```

`withAgent()` emits `AGENT_RUN_STARTED` / `AGENT_RUN_ENDED` events automatically. Nested agents in different parent contexts emit `HANDOFF` events.

---

#### Pattern 3: Explicit Session ID for Correlation

```typescript
import { withSession } from '@syrin/sdk';

// Tie the Syrin session to your order ID — easy to find in the dashboard
async function handleOrderChat(orderId: string, message: string): Promise<string> {
  const sessionId = `order-${orderId}`;

  return withSession(sessionId, async () => {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: message }],
    });
    return response.choices[0].message.content ?? '';
  });
}
```

---

#### Pattern 4: Concurrent Users

Many simultaneous `withSession` calls on a single Node.js process — fully safe, each session is isolated by `AsyncLocalStorage`:

```typescript
import { withSession } from '@syrin/sdk';

// Incoming HTTP requests — all processed concurrently
app.post('/batch', async (req, res) => {
  const { requests } = req.body as { requests: Array<{ userId: string; prompt: string }> };
  const today = new Date().toISOString().slice(0, 10);

  const results = await Promise.all(
    requests.map(({ userId, prompt }) =>
      withSession(`u:${userId}:${today}`, async () => {
        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
        });
        return { userId, content: response.choices[0].message.content };
      })
    )
  );

  res.json({ results });
});
```

Each user's LLM calls are attributed to their own session. The dashboard shows separate timelines per user, not one merged blob.

---

### Nested withSession

Inner `withSession` calls win. If you nest `withSession` inside another `withSession`, the inner session ID is active for the duration of the inner block. On exit, the outer session ID is restored automatically:

```typescript
await withSession('outer-session', async () => {
  // Active session: "outer-session"

  await withSession('inner-session', async () => {
    // Active session: "inner-session"
    // LLM calls here go to "inner-session"
    await openai.chat.completions.create({ ... });
  });

  // Active session: "outer-session" again
  await openai.chat.completions.create({ ... });
});
```

This is useful when an orchestrator session spawns sub-agent sessions that need separate timelines.

---

### No-Op Without withSession

If you make LLM calls without wrapping them in `withSession`, they are still captured — they land in the SDK's default session (the `ses_...` ID generated at `init()` time). Nothing is silently dropped.

```typescript
const sdk = await init({ apiKey: 'syrin_...', agentId: 'my-agent' });

// No withSession — still captured, attributed to the default session
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});

// Check what session it landed in:
console.log(sdk.sessionId);  // "ses_a1b2c3..."
```

For production workloads with real users, always use `withSession` so calls are attributed to the correct user session.
