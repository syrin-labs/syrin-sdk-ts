---
title: "Feedback"
description: "sdk.sessions.rate() — submit thumbs-up / thumbs-down ratings for sessions, with reason, voterId, and batch support."
weight: 61
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
- sdk.sessions.rate() is ASYNC — must be awaited
- sdk.sessions.rateBatch() is ASYNC — must be awaited
- FeedbackRating type is "positive" | "negative" — NOT "thumbsUp"/"thumbsDown" or 1/-1
- AlreadyRatedError is a SyrinError subclass — catch it specifically for idempotent handling
- SessionNotFoundError is a SyrinError subclass with a sessionId property
- sdk.sessions.start() is ASYNC — it returns Promise<{ sessionId, feedback }>
-->

> **AI Agent Quick Reference** — Rate a session after it ends:
> ```typescript
> const sdk = await init({ apiKey: "syrin_pk_..." }); // ← await
> await sdk.sessions.rate("ses_alice_001", "positive", { reason: "Accurate response" });
> // or negative:
> await sdk.sessions.rate("ses_abc", "negative", { reason: "Hallucinated hotel prices" });
> ```
> Common mistakes: (1) using `"thumbsUp"` / `"thumbsDown"` instead of `"positive"` / `"negative"` — the only valid values are `"positive"` and `"negative"`; (2) not handling `AlreadyRatedError` — rating the same session twice throws; (3) forgetting `await` on `rate()` — it's async.

## Because Your Agent Needs Performance Reviews Too

Your agent ran a travel planning session. The user got three hotel options, exact flight prices, and a day-by-day itinerary. Was that a good outcome? You know — but the dashboard doesn't, unless you tell it.

Feedback lets you submit a positive or negative rating for a session. Ratings appear immediately at [app.syrin.ai → Sessions](https://app.syrin.ai) and feed into per-agent quality metrics over time.

```
Sessions

  u:alice:2026-04-27   travel-assistant   👍  "Complete and accurate response"   $0.005
  u:bob:2026-04-27     travel-assistant   👎  "Hallucinated hotel prices"         $0.021
  u:carol:2026-04-27   travel-assistant       (no feedback yet)                  $0.009
```

---

## Types

```typescript
type FeedbackRating = "positive" | "negative";

interface FeedbackOptions {
  reason?: string;   // human-readable explanation for the rating
  voterId?: string;  // identifier of the human or system casting the vote
}
```

---

## `sdk.sessions.rate()`

Rate any session by ID.

**Signature:**
```typescript
sdk.sessions.rate(
  sessionId: string,
  rating: FeedbackRating,
  options?: FeedbackOptions
): Promise<void>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | Yes | The session to rate |
| `rating` | `FeedbackRating` | Yes | `"positive"` or `"negative"` |
| `options.reason` | `string` | No | Optional explanation shown in the dashboard |
| `options.voterId` | `string` | No | Optional identifier of who submitted the rating |

```typescript
// Full rating with reason and voter
await sdk.sessions.rate(
  "u:alice:2026-04-24",
  "positive",
  { reason: "Complete and accurate response", voterId: "alice" }
);

// Minimal call — only sessionId and rating are required
await sdk.sessions.rate("u:alice:2026-04-24", "negative");
```

---

## `sdk.sessions.withId().rate()` — Fluent Builder

Scope to a session ID first, then call `rate()`:

```typescript
await sdk.sessions.withId("u:alice:2026-04-24").rate("positive");

await sdk.sessions.withId("u:alice:2026-04-24").rate(
  "negative",
  { reason: "Hallucinated hotel prices", voterId: "alice" }
);
```

---

## `sdk.sessions.rateBatch()` — Evaluation Pipelines

Rate multiple sessions in a single call. All requests are sent concurrently. Errors are collected and rethrown together as a single `Error` — partial success is possible.

**Signature:**
```typescript
sdk.sessions.rateBatch(
  ratings: Array<{
    sessionId: string;
    rating: FeedbackRating;
    reason?: string;
    voterId?: string;
  }>
): Promise<void>
```

```typescript
await sdk.sessions.rateBatch([
  { sessionId: "ses_001", rating: "positive" },
  { sessionId: "ses_002", rating: "negative", reason: "Hallucinated facts" },
  { sessionId: "ses_003", rating: "positive", voterId: "alice" },
]);
```

---

## `sdk.sessions.start()` — Start with Success Criteria

Start a session and get back a handle with a `feedback` object attached. Pass `successCriteria` to define what a successful outcome looks like:

**Signature:**
```typescript
sdk.sessions.start(options: {
  sessionId?: string;
  agentId?: string;
  successCriteria?: string[];
}): Promise<{ sessionId: string; feedback: SessionFeedbackHandle }>
```

```typescript
const { sessionId, feedback } = await sdk.sessions.start({
  sessionId: "u:alice:2026-04-26",
  agentId: "travel-assistant",
  successCriteria: [
    "Suggested at least 3 specific hotels",
    "Included flight options",
    "Stayed within the stated budget",
  ],
});

const response = await runAgent(userMessage);

if (responseIsComplete(response)) {
  await feedback.positive({ reason: "All criteria met" });
} else {
  await feedback.negative({ reason: "Missing hotel suggestions" });
}
```

---

## `SessionFeedback` — Object-Oriented Handle

For object-oriented style, `SessionFeedback` wraps `rate()` with explicit `positive()` and `negative()` methods, plus `onCompletion()` for auto-rating based on a predicate:

```typescript
import { SessionFeedback } from "@syrin/sdk";

const feedback = new SessionFeedback("ses_abc123", sdk.config);

// Manual rating
await feedback.positive({ reason: "User confirmed the answer was helpful" });
await feedback.negative({ reason: "Response was off-topic" });

// Auto-rate based on a success predicate
const result = await runTravelAgent(userRequest);

await feedback.onCompletion(result, (r) =>
  r.status === "complete" && r.hotels.length > 0
);
// → positive if predicate returns true, negative otherwise
```

`onCompletion(result, successFn)` calls `positive()` when `successFn(result)` is `true`, otherwise `negative()`.

---

## Error Handling

| Error | HTTP Status | When thrown |
|-------|-------------|-------------|
| `AlreadyRatedError` | 409 | Session has already been rated |
| `SessionNotFoundError` | 404 | Session does not exist on the backend |
| `ValidationError` | 422 | `rating` is not `"positive"` or `"negative"` |

```typescript
import {
  AlreadyRatedError,
  SessionNotFoundError,
  ValidationError,
} from "@syrin/sdk";

try {
  await sdk.sessions.rate(sessionId, "positive", { reason: "Great response" });
} catch (err) {
  if (err instanceof AlreadyRatedError) {
    // Already rated — safe to ignore for idempotent pipelines
    return;
  }
  if (err instanceof SessionNotFoundError) {
    console.warn(`Session ${sessionId} not found — may have been evicted`);
    return;
  }
  if (err instanceof ValidationError) {
    console.error(`Invalid feedback payload: ${err.message}`);
    return;
  }
  throw err;
}
```

---

## Common Patterns

### Pattern 1: Auto-Rate in Express Handler

```typescript
import express from "express";
import { init, withSession } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "travel-assistant" });
const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { userId, message } = req.body;
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  const { feedback } = await sdk.sessions.start({ sessionId, agentId: "travel-assistant" });

  try {
    const response = await withSession(sessionId, () => runAgent(message));

    await feedback.onCompletion(
      response,
      (r) => r.status === "success" && r.content.length > 100
    );

    res.json({ sessionId, response: response.content });
  } catch (err) {
    await feedback.negative({ reason: `Error: ${(err as Error).message}` }).catch(() => {});
    throw err;
  }
});
```

### Pattern 2: User-Submitted Rating Endpoint

```typescript
app.post("/feedback", async (req, res) => {
  const { sessionId, thumbsUp, userId } = req.body as {
    sessionId: string;
    thumbsUp: boolean;
    userId: string;
  };

  try {
    await sdk.sessions.rate(
      sessionId,
      thumbsUp ? "positive" : "negative",
      { voterId: userId }
    );
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof AlreadyRatedError) {
      res.status(409).json({ ok: false, error: "Already rated" });
    } else if (err instanceof SessionNotFoundError) {
      res.status(404).json({ ok: false, error: "Session not found" });
    } else {
      throw err;
    }
  }
});
```

### Pattern 3: Batch Rating from Evaluation Pipeline

```typescript
interface EvalResult {
  sessionId: string;
  score: number;
}

async function submitEvalResults(evalResults: EvalResult[]): Promise<void> {
  const ratings = evalResults.map((r) => ({
    sessionId: r.sessionId,
    rating: (r.score >= 0.8 ? "positive" : "negative") as FeedbackRating,
    reason: `Eval score: ${r.score.toFixed(2)}`,
    voterId: "eval-pipeline",
  }));

  try {
    await sdk.sessions.rateBatch(ratings);
    console.log(`Submitted ${ratings.length} ratings`);
  } catch (err) {
    // rateBatch collects all errors — log and continue
    console.error(`Batch rating errors: ${(err as Error).message}`);
  }
}
```
