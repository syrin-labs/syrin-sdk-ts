---
title: "Sessions & Windows"
description: "WindowType constants, deterministic session IDs, session TTL, and session lifecycle events in the TypeScript SDK."
weight: 32
---

## Sessions: Where Your LLM Calls Go to Live Together

A session is a named group of LLM calls, log entries, and lifecycle events that belong together — typically one user's interaction with your agent in a given time window. Sessions give the dashboard its timeline view: you see every call Alice made today, in order, with costs and latencies.

### What is a Session?

Every LLM call that Syrin instruments must belong to a session. A session has:
- A **session ID** — either auto-generated, user-specified, or deterministically computed from a user ID + time window
- A **start event** (`SESSION_STARTED`) emitted when the session opens
- An **end event** (`SESSION_ENDED`) emitted when it closes
- All telemetry events (LLM calls, logs, lifecycle events) stamped with the session ID

---

### Session ID Formats

| Source | Example |
|--------|---------|
| Auto-generated | `ses_a1b2c3d4e5f6` |
| Manual | `"ses_order_12345"` |
| `userId` + `DAY` | `"u:alice:2026-04-24"` |
| `userId` + `HOUR` | `"u:alice:2026-04-24T14"` |
| `userId` + `WEEK` | `"u:alice:2026-W17"` |
| `userId` + `MONTH` | `"u:alice:2026-04"` |
| `userId` + `FOREVER` | `"u:alice"` |

Deterministic session IDs are computed at call time using UTC timestamps. The same user on the same day always gets the same session ID, making it safe to call from any replica without coordination.

---

### Window Types

The TypeScript SDK does not expose a `WindowType` enum — windows are plain strings. Pass one of the accepted string values directly when computing your session ID.

| String | Alias | Reset Period | Session ID Example |
|--------|-------|--------------|-------------------|
| `"day"` | `"daily"` | UTC midnight | `u:alice:2026-04-24` |
| `"hour"` | `"hourly"` | Top of each hour | `u:alice:2026-04-24T14` |
| `"week"` | `"weekly"` | Monday 00:00 UTC | `u:alice:2026-W17` |
| `"month"` | `"monthly"` | 1st of month 00:00 UTC | `u:alice:2026-04` |
| `"forever"` | `"persistent"` | Never | `u:alice` |

---

### Choosing a Window

| Window | When to use |
|--------|-------------|
| `"day"` | Most agents — one session per user per day is a natural conversation boundary |
| `"hour"` | High-frequency agents, chatbots with many quick interactions |
| `"week"` | Low-frequency agents — weekly report generation, batch jobs |
| `"month"` | Monthly billing or review workflows |
| `"forever"` | User profiles, persistent assistants, long-lived agents |

The `"day"` window is the right default for most agents. You almost never need to change it.

---

### Computing Deterministic Session IDs

The TypeScript SDK does not automatically compute deterministic session IDs from a `userId` + `window` pair. You build the string yourself — it is just string interpolation. The ID is deterministic by construction.

```typescript
import { withSession } from '@syrin/sdk';

function sessionIdForUser(userId: string, window: string = 'day'): string {
  const now = new Date();
  switch (window) {
    case 'day':
    case 'daily':
      // "u:alice:2026-04-24"
      return `u:${userId}:${now.toISOString().slice(0, 10)}`;
    case 'hour':
    case 'hourly':
      // "u:alice:2026-04-24T14"
      return `u:${userId}:${now.toISOString().slice(0, 13)}`;
    case 'week':
    case 'weekly': {
      // "u:alice:2026-W17" — ISO week number
      const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil(
        ((now.getTime() - startOfYear.getTime()) / 86_400_000 + startOfYear.getUTCDay() + 1) / 7
      );
      return `u:${userId}:${now.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    }
    case 'month':
    case 'monthly':
      // "u:alice:2026-04"
      return `u:${userId}:${now.toISOString().slice(0, 7)}`;
    case 'forever':
    case 'persistent':
      // "u:alice"
      return `u:${userId}`;
    default:
      throw new Error(`Unknown window: ${window}`);
  }
}

// Usage
const sessionId = sessionIdForUser('alice', 'day');  // "u:alice:2026-04-24"

await withSession(sessionId, async () => {
  const response = await openai.chat.completions.create({ ... });
});
```

For most teams, extracting this into a shared utility and calling it from every request handler is sufficient.

---

### Creating Sessions

#### Via `withSession()` with a computed ID

```typescript
import { init, withSession } from '@syrin/sdk';

const sdk = await init({ apiKey: 'syrin_...', agentId: 'my-agent' });

// Daily session — most common pattern
const sessionId = `u:alice:${new Date().toISOString().slice(0, 10)}`;

await withSession(sessionId, async () => {
  const response = await openai.chat.completions.create({ ... });
});
```

#### Via explicit session ID

```typescript
// Use your own ID for easy correlation with your data model
await withSession('order-12345-chat', async () => {
  const response = await openai.chat.completions.create({ ... });
});
```

#### Via `sdk.sessions.start()` with success criteria

```typescript
const { sessionId, feedback } = await sdk.sessions.start({
  sessionId: `u:alice:${new Date().toISOString().slice(0, 10)}`,
  successCriteria: [
    "User's destination identified",
    'At least 3 hotel options presented',
    'Flights checked and presented',
    'Total trip cost estimated',
  ],
});

await withSession(sessionId, async () => {
  const result = await runTravelAgent(userRequest);
  if (allCriteriaMet(result)) {
    await feedback.rate('positive');
  } else {
    await feedback.rate('negative', { reason: 'Some criteria not met' });
  }
});
```

---

### Session Lifecycle Events

Every opened session emits lifecycle events visible on the dashboard timeline:

| Event | When |
|-------|------|
| `SESSION_STARTED` | `withSession()` block entered |
| `SESSION_ENDED` | `withSession()` block exited (normal or error) |
| `SESSION_CRITERIA` | When `successCriteria` is provided to `sdk.sessions.start()` |

> **Note:** The TypeScript SDK does not emit `SESSION_CRASHED`. Errors thrown inside a `withSession()` block propagate to the caller normally — `SESSION_ENDED` is always emitted in the `finally` branch regardless of whether an error occurred. Use `sdk.emit('SESSION_CRASHED', { ... })` explicitly if you need to surface a crash event on the dashboard.

```typescript
// If you want explicit crash visibility:
await withSession(sessionId, async () => {
  try {
    await runAgent();
  } catch (err) {
    sdk.emit('SESSION_CRASHED', {
      exception_type: err instanceof Error ? err.constructor.name : 'Error',
      exception_message: err instanceof Error ? err.message.slice(0, 500) : String(err),
    });
    throw err;  // re-throw so the caller knows
  }
});
```

---

### Session TTL (Long-Running Servers)

The SDK keeps all sessions in an in-memory `SessionStore`. Without cleanup, this store grows without bound in long-running HTTP servers. There is no background cleanup thread — call `clearStaleSessions` manually on a schedule:

```typescript
import { clearStaleSessions } from '@syrin/sdk';

// Remove sessions older than 1 hour — call this periodically
setInterval(() => {
  const removed = clearStaleSessions(60 * 60 * 1000);  // 1 hour in ms
  if (removed > 0) {
    console.log(`[Syrin] Cleared ${removed} stale sessions`);
  }
}, 30 * 60 * 1000);  // run every 30 minutes
```

Or via the SDK instance:

```typescript
const sdk = await init({ ... });
setInterval(() => sdk.clearStaleSessions(3_600_000), 1_800_000);
```

`clearStaleSessions` returns the number of sessions removed. Sessions are identified as stale based on their `startedAt` timestamp.

---

### Session Metadata

Attach arbitrary metadata to the `SESSION_STARTED` event by emitting it manually:

```typescript
await withSession(sessionId, async () => {
  // Emit extra metadata alongside SESSION_STARTED
  sdk.emit('SESSION_STARTED', {
    plan: 'premium',
    ab_variant: 'control',
    region: 'us-east-1',
    app_version: '2.3.1',
  }, sessionId);

  const response = await openai.chat.completions.create({ ... });
});
```

All metadata fields are visible in the dashboard session detail panel.

---

### Success Criteria

Record expected outcomes for a session — useful for automated quality measurement:

```typescript
const { sessionId, feedback } = await sdk.sessions.start({
  sessionId: `u:alice:${new Date().toISOString().slice(0, 10)}`,
  successCriteria: [
    "User's destination identified",
    'At least 3 hotel options presented',
    'Flights checked and presented',
    'Total trip cost estimated',
  ],
});

await withSession(sessionId, async () => {
  const result = await runTravelAgent(userRequest);

  if (allCriteriaMet(result)) {
    await sdk.sessions.rate(sessionId, 'positive');
  } else {
    await sdk.sessions.rate(sessionId, 'negative', { reason: 'Some criteria not met' });
  }
});
```

When `successCriteria` is provided, a `SESSION_CRITERIA` event is emitted and the criteria are stored on the session state for dashboard display.

---

### Session vs. Run vs. Trace

Three complementary scopes:

| Scope | Set via | Represents | Persists across |
|-------|---------|------------|-----------------|
| Session | `withSession(sessionId, ...)` | A user's interaction window | Multiple agent runs |
| Run | `withAgent(agentId, ...)` | A single agent execution | The duration of the function |
| Trace | Auto-generated | The full distributed call tree | All nested agent runs |

A session can contain many runs. A trace spans the full nested call stack.

---

### Getting the Current Session ID

```typescript
import { getSessionId, withSession } from '@syrin/sdk';

// Inside a withSession block — returns the active session ID
await withSession('u:alice:2026-04-24', async () => {
  const sessionId = getSessionId();  // "u:alice:2026-04-24"
  console.log(sessionId);
});

// Outside a withSession block — returns the SDK's default session ID
const sessionId = getSessionId();  // "ses_a1b2c3..."
```

`getSessionId()` reads from `AsyncLocalStorage`, so it correctly resolves the innermost active session in nested or concurrent calls.

---

### Multi-Server Session Continuity

Because session IDs are plain strings you compute deterministically, any replica of your service handling requests for the same user on the same day will produce the same session ID — no session state needs to be shared between processes. The Syrin backend merges all events from the same session ID into one timeline automatically.

```typescript
// Replica 1 — handles alice's first request
const sessionId = `u:alice:${new Date().toISOString().slice(0, 10)}`;
// sessionId = "u:alice:2026-04-24"

await withSession(sessionId, async () => {
  await openai.chat.completions.create({ ... });
});

// Replica 2 — handles alice's second request (different process, same day)
const sessionId2 = `u:alice:${new Date().toISOString().slice(0, 10)}`;
// sessionId2 = "u:alice:2026-04-24" — same! Events merge in the dashboard.

await withSession(sessionId2, async () => {
  await openai.chat.completions.create({ ... });
});
```

---

### Common Patterns

#### HTTP Request Handler

```typescript
import express from 'express';
import { init, withSession } from '@syrin/sdk';

const sdk = await init({ apiKey: 'syrin_...', agentId: 'chat-bot' });
const app = express();

app.post('/chat', async (req, res) => {
  const { userId, messages } = req.body;
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  await withSession(sessionId, async () => {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
    });
    res.json({ sessionId, content: response.choices[0].message.content });
  });
});
```

#### Batch Job

```typescript
// Each batch run gets its own explicit session ID
const batchSessionId = `batch:nightly-report:${new Date().toISOString().slice(0, 10)}`;

await withSession(batchSessionId, async () => {
  for (const item of items) {
    await openai.chat.completions.create({ ... });
  }
});
```

#### Explicit Session ID for Backend Correlation

```typescript
// Tie the Syrin session to your order ID for easy cross-system correlation
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
