---
title: "emit() & log()"
description: "Send custom lifecycle events and structured logs to the session timeline at app.syrin.ai — guardrails, handoffs, budget warnings, and more."
weight: 42
---

## Tell the Dashboard What's Really Happening

`sdk.emit()` sends a named lifecycle event to the session timeline at [app.syrin.ai](https://app.syrin.ai). Use it to surface production-grade signals that aren't LLM calls: guardrail checks, circuit breakers, handoffs between agents, budget estimates, tool selections, and custom milestones.

All active context fields (`agentId`, `sessionId`, `workflowId`) are automatically merged into every event — you only need to provide the payload.

---

### Signatures

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

### `sdk.log()` — Structured Logs

`sdk.log()` is a convenience wrapper around `emit("CUSTOM_LOG", ...)` for structured log messages.

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

### Built-in Event Types

These event types get first-class rendering at [app.syrin.ai](https://app.syrin.ai):

---

#### `GUARDRAIL_INPUT` / `GUARDRAIL_OUTPUT`

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

**Dashboard display:**
```
● GUARDRAIL_INPUT    pii_filter        ✓ passed
● GUARDRAIL_OUTPUT   toxicity_filter   ✗ failed  "Response score 0.72 exceeds threshold 0.50"
```

---

#### `HANDOFF`

Signal that control is passing from one agent to another.

```typescript
sdk.emit("HANDOFF", {
  from_agent: "orchestrator",
  to_agent:   "researcher",
  reason:     "Starting research phase",
  context:    { topic: "Tokyo travel", depth: "standard" },
});
```

**Dashboard display:**
```
● HANDOFF   orchestrator → researcher   "Starting research phase"
```

---

#### `AGENT_FORK` / `AGENT_JOIN`

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

**Dashboard display:**
```
● AGENT_FORK    3 agents spawned   researcher-climate, researcher-hotels, researcher-transport
  ⎯⎯ 3 parallel LLM calls ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
● AGENT_JOIN    3 agents completed
```

---

#### `CIRCUIT_BREAKER_OPEN` / `CIRCUIT_BREAKER_CLOSE`

Signal that a circuit breaker tripped or recovered.

```typescript
sdk.emit("CIRCUIT_BREAKER_OPEN", {
  reason:        "5 consecutive timeouts on booking.com",
  failure_count: 5,
  threshold:     5,
});

// Later, when the service recovers:
sdk.emit("CIRCUIT_BREAKER_CLOSE", {
  reason: "Service healthy again",
});
```

---

#### `BUDGET_ESTIMATION`

Signal a cost estimation or budget threshold warning. The dashboard renders a cost bar.

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

**Dashboard display:**
```
● BUDGET_ESTIMATION   $0.82 / $1.00   ████████░░  82%   "Session at 82% of budget"
```

---

#### `CHECKPOINT`

Mark a milestone in your workflow. Appears as an annotation on the session timeline.

```typescript
sdk.emit("CHECKPOINT", {
  name:     "research-complete",
  label:    "Research Phase Done",
  metadata: { destination: "Tokyo", documentsFound: 42 },
});

// Or use the convenience method:
sdk.checkpoint("research-complete", { phase: "1", documents: 42 });
```

**Dashboard display:**
```
★ CHECKPOINT   research-complete   "Research Phase Done"   documents=42
```

> Note: `emit("CHECKPOINT", ...)` is a timeline annotation — it does **not** snapshot conversation state. For state snapshots use `sdk.createCheckpoint()`. See [Checkpoints](../control/checkpoints).

---

#### `TOOL_SELECTED`

```typescript
sdk.emit("TOOL_SELECTED", {
  tool_name:    "web_search",
  reason:       "User asked for current information",
  alternatives: ["database_query", "cached_data"],
});
```

---

#### `WORKER_SPAWNED`

```typescript
sdk.emit("WORKER_SPAWNED", {
  worker_agent: "specialist-tokyo",
  reason:       "User requested Tokyo-specific research",
});
```

---

### Custom Events

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

sdk.emit("EXTERNAL_API_CALLED", {
  service:      "booking.com",
  latency_ms:   340,
  result_count: 15,
});
```

**Dashboard display:**
```
● ITINERARY_GENERATED      destination=Tokyo  days=7  total_cost_usd=3200.0
● USER_PREFERENCE_DETECTED preference=budget_travel  confidence=0.87
● EXTERNAL_API_CALLED      service=booking.com  latency_ms=340  result_count=15
```

---

### Context Auto-Resolution

When `emit()` is called inside a `withSession()` / `withAgent()` block, the event automatically picks up all active context fields:

```typescript
await sdk.withSession({ userId: "alice", window: "day" }, async (ctx) => {
  await withAgent("researcher", async () => {
    sdk.emit("GUARDRAIL_INPUT", { name: "pii", passed: true });
    // The emitted event contains:
    // {
    //   "event_type": "GUARDRAIL_INPUT",
    //   "session_id": "u:alice:2026-04-27",
    //   "agent_id":   "researcher",
    //   "name": "pii",
    //   "passed": true,
    //   "timestamp": "..."
    // }
  });
});
```

---

### Full Example: Safe LLM Call with Guardrails

```typescript
import OpenAI from "openai";

const client = new OpenAI();

async function safeLlmCall(userMessage: string, sessionId: string): Promise<string> {
  return sdk.withSession({ sessionId }, async () => {

    // Input guardrail
    const { passed, reason } = await piiFilter.check(userMessage);
    sdk.emit("GUARDRAIL_INPUT", {
      name:    "pii_filter",
      passed,
      message: reason ?? null,
    });
    if (!passed) return "I can't process that request due to privacy constraints.";

    // LLM call
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

// What appears in the dashboard for this call:
// ● GUARDRAIL_INPUT    pii_filter     ✓ passed
// ● LLM_CALL          gpt-4o  in=28  out=142  $0.002  940ms
// ● GUARDRAIL_OUTPUT   toxicity_filter  ✓ passed
```
