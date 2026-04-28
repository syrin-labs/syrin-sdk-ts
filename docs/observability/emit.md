---
title: "emit() & log()"
description: "Send custom lifecycle events and structured logs to the session timeline at app.syrin.ai — guardrails, handoffs, budget warnings, and more."
weight: 42
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
- sdk.emit() is SYNCHRONOUS — it does NOT return a Promise, do not await it
- sdk.log() is SYNCHRONOUS — it does NOT return a Promise, do not await it
- Context (session_id, agent_id, workflow_id) is AUTO-RESOLVED from AsyncLocalStorage
- emit("CHECKPOINT", ...) is a TIMELINE ANNOTATION — it does NOT snapshot state
- For state snapshots use sdk.createCheckpoint() — see checkpoints.md
- HANDOFF events are NOT automatic — you must emit them explicitly
-->

> **AI Agent Quick Reference** — Emit a guardrail and a handoff:
> ```typescript
> const sdk = await init({ apiKey: "syrin_pk_..." }); // ← await
> sdk.emit("GUARDRAIL_INPUT", { name: "pii_filter", passed: true }); // ← NOT awaited
> sdk.emit("HANDOFF", { from_agent: "orchestrator", to_agent: "researcher" }); // ← NOT awaited
> ```
> Common mistakes: (1) `await sdk.emit(...)` — `emit()` is synchronous; (2) thinking `HANDOFF` fires automatically — you must emit it manually before each agent handoff; (3) confusing `sdk.emit("CHECKPOINT", ...)` (timeline annotation) with `sdk.createCheckpoint()` (state snapshot with rollback).

## Tell the Dashboard What's Really Happening

Your agent made three LLM calls, hit two guardrails, spawned a researcher and a writer, and reached a cost milestone. Without `emit()`, the dashboard shows three LLM call events. With it, the full picture appears — guardrail passes, agent transitions, cost warnings, and custom milestones alongside every LLM call.

`sdk.emit()` sends a named lifecycle event to the session timeline. All active context fields (`agentId`, `sessionId`, `workflowId`) are automatically merged from `AsyncLocalStorage` — you only provide the payload.

---

## Signatures

```typescript
// Instance method
sdk.emit(eventType: string, payload?: Record<string, unknown>, sessionId?: string): void

// Module-level re-export (delegates to default instance)
import { emit } from "@syrin/sdk";
emit(eventType: string, payload?: Record<string, unknown>, sessionId?: string): void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `eventType` | `string` | Event type string (see built-in types below, or any custom string) |
| `payload` | `Record<string, unknown>` | Optional fields merged into the event |
| `sessionId` | `string` | Target session — defaults to the active session from `withSession()` |

---

## `sdk.log()` — Structured Logs

`sdk.log()` is a convenience wrapper around `emit("CUSTOM_LOG", ...)` for free-form log messages with severity levels.

**Signature:**
```typescript
// Instance method
sdk.log(
  message: string,
  level?: "debug" | "info" | "warning" | "error",
  metadata?: Record<string, unknown>,
  sessionId?: string,
): void

// Module-level
import { log } from "@syrin/sdk";
log(message, level?, metadata?, sessionId?): void
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `message` | `string` | required | The log message |
| `level` | `"debug" \| "info" \| "warning" \| "error"` | `"info"` | Severity level |
| `metadata` | `Record<string, unknown>` | `undefined` | Key/value pairs shown in detail panel |
| `sessionId` | `string` | active session | Target session |

```typescript
sdk.log("User intent detected",  "info",    { intent: "travel-planning" });
sdk.log("API rate limit hit",    "warning", { service: "booking.com" });
sdk.log("Unexpected output",     "error",   { output: "..." });
```

These appear on the session timeline as `CUSTOM_LOG` events with a coloured level badge:
```
● CUSTOM_LOG [info]     User intent detected    intent=travel-planning
● CUSTOM_LOG [warning]  API rate limit hit      service=booking.com
```

---

## Built-in Event Types

These event types get first-class rendering at [app.syrin.ai](https://app.syrin.ai):

### `GUARDRAIL_INPUT` / `GUARDRAIL_OUTPUT`

Record a guardrail check on the input or output of an LLM call.

```typescript
// Before calling the LLM
sdk.emit("GUARDRAIL_INPUT", {
  name:    "pii_filter",
  passed:  true,
  message: null,
});

// After the LLM responds
sdk.emit("GUARDRAIL_OUTPUT", {
  name:    "toxicity_filter",
  passed:  false,
  message: "Response score 0.72 exceeds threshold 0.50",
});
```

Dashboard display:
```
● GUARDRAIL_INPUT    pii_filter        ✓ passed
● GUARDRAIL_OUTPUT   toxicity_filter   ✗ failed  "Response score 0.72 exceeds threshold 0.50"
```

---

### `HANDOFF`

Signal that control is passing from one agent to another. **Not emitted automatically** — you must call this explicitly before the receiving agent's first LLM call.

```typescript
sdk.emit("HANDOFF", {
  from_agent: "orchestrator",
  to_agent:   "researcher",
  reason:     "Starting research phase",
  context:    { topic: "Tokyo travel", depth: "standard" },
});
```

Dashboard display:
```
● HANDOFF   orchestrator → researcher   "Starting research phase"
```

> ⚠️ **Forget to emit `HANDOFF` and:** the dashboard won't show which agent was responsible for each LLM call. The timeline will look like all calls came from one agent.

---

### `AGENT_FORK` / `AGENT_JOIN`

Signal the start and end of parallel agent execution.

```typescript
const agents = ["researcher-climate", "researcher-hotels", "researcher-transport"];

sdk.emit("AGENT_FORK", {
  agents,
  reason: "Parallel research across three aspects",
});

const results = await Promise.all(agents.map(a => runAgent(a)));

sdk.emit("AGENT_JOIN", {
  agents,
  reason: "All parallel researchers completed",
});
```

Dashboard display:
```
● AGENT_FORK    3 agents spawned   researcher-climate, researcher-hotels, ...
  ⎯⎯ 3 parallel LLM calls ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
● AGENT_JOIN    3 agents completed
```

---

### `CIRCUIT_BREAKER_OPEN` / `CIRCUIT_BREAKER_CLOSE`

Signal that a circuit breaker tripped or recovered.

```typescript
sdk.emit("CIRCUIT_BREAKER_OPEN", {
  reason:        "5 consecutive timeouts on booking.com",
  failure_count: 5,
  threshold:     5,
});

sdk.emit("CIRCUIT_BREAKER_CLOSE", {
  reason: "Service healthy again",
});
```

---

### `BUDGET_ESTIMATION`

Signal a cost estimate or budget threshold warning. The dashboard renders a cost bar.

```typescript
const sessionCost = getSessionCost();
const budget      = agent.cfg("budget.maxCostUsd", 1.0) as number;

if (sessionCost > budget * 0.8) {
  sdk.emit("BUDGET_ESTIMATION", {
    estimated_cost_usd: sessionCost,
    budget_usd:         budget,
    message:            `Session at ${Math.round(sessionCost / budget * 100)}% of budget`,
  });
}
```

Dashboard display:
```
● BUDGET_ESTIMATION   $0.82 / $1.00   ████████░░  82%
```

---

### `CHECKPOINT`

Mark a milestone in your workflow. This is a **timeline annotation** — it does not snapshot conversation state.

```typescript
sdk.emit("CHECKPOINT", {
  name:     "research-complete",
  label:    "Research Phase Done",
  metadata: { destination: "Tokyo", documentsFound: 42 },
});

// Convenience alias:
sdk.checkpoint("research-complete", { phase: "1", documents: 42 });
```

> **Note:** `emit("CHECKPOINT", ...)` is a timeline annotation. For state snapshots with rollback capability, use `sdk.createCheckpoint()`. See [Checkpoints](../control/checkpoints).

---

### `TOOL_SELECTED`

```typescript
sdk.emit("TOOL_SELECTED", {
  tool_name:    "web_search",
  reason:       "User asked for current information",
  alternatives: ["database_query", "cached_data"],
});
```

---

### `WORKER_SPAWNED`

```typescript
sdk.emit("WORKER_SPAWNED", {
  worker_agent: "specialist-tokyo",
  reason:       "User requested Tokyo-specific research",
});
```

---

## Custom Events

Any string not in the built-in list is accepted and rendered as a generic event:

```typescript
sdk.emit("ITINERARY_GENERATED", {
  destination:    "Tokyo",
  days:           7,
  total_cost_usd: 3200.0,
});

sdk.emit("USER_PREFERENCE_DETECTED", {
  preference: "budget_travel",
  confidence: 0.87,
});
```

---

## Context Auto-Resolution

When `emit()` is called inside a `withSession()` / `withAgent()` block, the event automatically picks up all active context fields:

```typescript
await withSession("ses_alice", async () => {
  await withAgent("researcher", async (ctx) => {
    sdk.emit("GUARDRAIL_INPUT", { name: "pii", passed: true });
    // Event contains automatically:
    // {
    //   "event_type": "GUARDRAIL_INPUT",
    //   "session_id": "ses_alice",
    //   "agent_id":   "researcher",
    //   "run_id":     "run_...",
    //   "name": "pii", "passed": true,
    //   "timestamp": "..."
    // }
  });
});
```

---

## `emit()` vs. `log()`

| Feature | `emit()` | `log()` |
|---------|----------|---------|
| Structured payload | Yes | Yes (as `metadata`) |
| Log level | No | Yes (`debug/info/warning/error`) |
| Free-form message text | Optional (in payload) | Yes (required first arg) |
| First-class event rendering | Yes (HANDOFF, GUARDRAIL, etc.) | No (generic CUSTOM_LOG) |
| Use case | Lifecycle events with specific semantics | Application logs and operational text |

---

## Full Example: Safe LLM Call with Guardrails

```typescript
import { init, withSession } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: process.env.SYRIN_API_KEY!, agentId: "travel-assistant" });
const client = new OpenAI();
const agent = sdk.agent("travel-assistant");

async function safeLlmCall(userMessage: string, sessionId: string): Promise<string> {
  return withSession(sessionId, async () => {
    // Input guardrail
    const { passed, reason } = await piiFilter.check(userMessage);
    sdk.emit("GUARDRAIL_INPUT", { name: "pii_filter", passed, message: reason ?? null });
    if (!passed) return "I can't process that request due to privacy constraints.";

    // LLM call — automatically captured
    const response = await client.chat.completions.create({
      model:    agent.cfg("llm.model", "gpt-4o") as string,
      messages: [{ role: "user", content: userMessage }],
    });
    const output = response.choices[0].message.content ?? "";

    // Output guardrail
    const toxicityScore = await toxicityModel.score(output);
    sdk.emit("GUARDRAIL_OUTPUT", {
      name:    "toxicity_filter",
      passed:  toxicityScore < 0.5,
      message: toxicityScore >= 0.5 ? `Score: ${toxicityScore.toFixed(2)}` : null,
    });
    if (toxicityScore >= 0.5) return "I can't provide that response.";

    return output;
  });
}

// What appears in the dashboard:
// ● GUARDRAIL_INPUT    pii_filter     ✓ passed
// ● LLM_CALL          gpt-4o  in=28  out=142  $0.002  940ms
// ● GUARDRAIL_OUTPUT   toxicity_filter  ✓ passed
```
