---
title: "Feedback"
description: "sdk.sessions.rate() — submit thumbs-up / thumbs-down ratings for sessions, with reason, voterId, and batch support."
weight: 61
---

## Because Your Agent Needs Performance Reviews Too

Feedback lets you submit a positive or negative rating for a session — a simple thumbs-up / thumbs-down signal that tells the Syrin dashboard whether this session produced a good outcome. Ratings appear immediately at [app.syrin.ai → Sessions](https://app.syrin.ai) as a 👍 / 👎 indicator and feed into per-agent quality metrics over time.

```
Sessions

  u:alice:2026-04-27   travel-assistant   👍  "Complete and accurate response"   $0.005
  u:bob:2026-04-27     travel-assistant   👎  "Hallucinated hotel prices"         $0.021
  u:carol:2026-04-27   travel-assistant       (no feedback yet)                  $0.009
```

Navigate to [app.syrin.ai → Agents → {agent-name}](https://app.syrin.ai) to see aggregate feedback rates, most common negative reasons, and a drilldown into every negative session with its full replay.

### Types

```typescript
type FeedbackRating = "positive" | "negative";

interface FeedbackOptions {
  reason?: string;   // human-readable explanation for the rating
  voterId?: string;  // identifier of the human or system casting the vote
}
```

### `sdk.sessions.rate()`

The primary feedback method. Rate any session by ID directly on the SDK instance — no context block required.

```typescript
await sdk.sessions.rate(
  "u:alice:2026-04-24",
  "positive",
  { reason: "Complete and accurate response", voterId: "alice" }
);

// Minimal call — only sessionId and rating are required
await sdk.sessions.rate("u:alice:2026-04-24", "negative");
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | Yes | The session to rate |
| `rating` | `FeedbackRating` | Yes | `"positive"` or `"negative"` |
| `options.reason` | `string` | No | Optional explanation |
| `options.voterId` | `string` | No | Optional identifier of who submitted the rating |

---

### `sdk.sessions.withId().rate()` — Fluent Builder

Scope to a session ID first, then call `rate()`. Cleaner when you're calling multiple methods on the same session.

```typescript
await sdk.sessions.withId("u:alice:2026-04-24").rate("positive");

await sdk.sessions.withId("u:alice:2026-04-24").rate(
  "negative",
  { reason: "Hallucinated hotel prices", voterId: "alice" }
);
```

---

### `sdk.sessions.rateBatch()` — Evaluation Pipelines

Rate multiple sessions in a single call. All requests are sent concurrently. Errors are collected and rethrown together as a single `Error` — partial success is possible.

```typescript
await sdk.sessions.rateBatch([
  { sessionId: "ses_001", rating: "positive" },
  { sessionId: "ses_002", rating: "negative", reason: "Hallucinated facts" },
  { sessionId: "ses_003", rating: "positive", voterId: "alice" },
]);
```

Each item requires `sessionId` and `rating`. `reason` and `voterId` are optional.

---

### `sdk.sessions.start()` — Start with Success Criteria

Start a session and get back a handle with a `feedback` object attached. Optionally pass `successCriteria` — a list of strings that define what a successful outcome looks like. These are stored on the session and emitted as a `SESSION_CRITERIA` event for the dashboard.

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

// Run your agent...
const response = await runAgent(userMessage);

// Then rate based on outcome
if (responseIsComplete(response)) {
  await feedback.positive({ reason: "All criteria met" });
} else {
  await feedback.negative({ reason: "Missing hotel suggestions" });
}
```

---

### `SessionFeedback` — OOP Handle

If you prefer an object-oriented style, `SessionFeedback` wraps `rate()` with explicit `positive()` and `negative()` methods, plus an `onCompletion()` helper for auto-rating based on a predicate.

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
```

`onCompletion(result, successFn)` calls `positive()` when `successFn(result)` returns `true`, otherwise `negative()`.

---

### Error Handling

| Error | HTTP Status | When |
|-------|-------------|------|
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
    // Already rated — ignore and move on
    return;
  }
  if (err instanceof SessionNotFoundError) {
    console.warn(`Session ${sessionId} not found — skipping feedback`);
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

### Common Patterns

#### Pattern 1: Auto-Rate in Express Handler

Rate based on whether the agent completed successfully — no human in the loop required.

```typescript
import express from "express";

app.post("/chat", async (req, res) => {
  const { userId, message } = req.body;
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  const { feedback } = await sdk.sessions.start({ sessionId, agentId: "travel-assistant" });

  try {
    const response = await runAgent(message, sessionId);

    // Auto-rate based on response quality
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

---

#### Pattern 2: User-Submitted Rating Endpoint

Expose a `/feedback` route so end users can submit ratings from your UI.

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

---

#### Pattern 3: Batch Rating from Evaluation Pipeline

Run an offline evaluation suite and submit all ratings in one call.

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
