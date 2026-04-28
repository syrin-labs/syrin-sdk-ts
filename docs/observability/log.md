---
title: "log()"
description: "Emit structured log entries to the Syrin dashboard timeline — with levels, metadata, and session scoping."
weight: 43
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
- sdk.log() is SYNCHRONOUS — do NOT await it
- log() is available BOTH as a module-level function AND as sdk.log() instance method
- Valid log levels: "debug" | "info" | "warning" | "error" — NOT "warn", NOT "verbose"
- log() is a convenience wrapper around emit("CUSTOM_LOG", ...) — NOT a separate pipeline
-->

> **AI Agent Quick Reference** — Log an application event:
> ```typescript
> import { log } from "@syrin/sdk"; // ← module-level, or use sdk.log()
> log("Retrieved 42 documents", "info", { collection: "travel_kb", latency_ms: 45 });
> log("Cost at 80%", "warning", { spent_usd: 0.80, budget_usd: 1.00 });
> ```
> Common mistakes: (1) `await log(...)` — `log()` is synchronous; (2) using `"warn"` instead of `"warning"` — the valid levels are `"debug"`, `"info"`, `"warning"`, `"error"`; (3) using `log()` for structured lifecycle events (handoffs, guardrails) — use `emit()` for those.

## Application Logs on the Dashboard Timeline

Your agent retrieves documents, parses user intent, checks budgets, and routes to sub-agents — all between LLM calls. Without `log()`, the dashboard shows only the LLM calls. With it, the full operational story appears: what your agent was doing, how long it took, and whether anything was unexpected.

`sdk.log()` emits a custom log entry that appears on the session timeline at [app.syrin.ai](https://app.syrin.ai) alongside LLM calls.

---

## Function Signature

```typescript
// Instance method
sdk.log(
  message: string,
  level?: "debug" | "info" | "warning" | "error",
  metadata?: Record<string, unknown>,
  sessionId?: string,
): void

// Module-level (delegates to default instance)
import { log } from "@syrin/sdk";
log(message, level?, metadata?, sessionId?): void
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `message` | `string` | required | The log message to display |
| `level` | `"debug" \| "info" \| "warning" \| "error"` | `"info"` | Severity level |
| `metadata` | `Record<string, unknown>` | `undefined` | Key/value pairs shown in detail panel |
| `sessionId` | `string` | active session | Target session; defaults to `AsyncLocalStorage` active session |

---

## Basic Usage

```typescript
import { init, log } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });

// Info log — normal operation milestone
log("Retrieved 42 documents from vector store");

// Warning with metadata
log("Cost budget at 80%", "warning", {
  spent_usd: 0.80,
  budget_usd: 1.00,
});

// Error — affects the agent's output
log("External API call failed", "error", {
  service: "weather_api",
  error: "ConnectionTimeout",
});
```

---

## Log Levels

| Level | Color in Dashboard | When to use |
|-------|-------------------|-------------|
| `"debug"` | Gray | Detailed trace information for debugging |
| `"info"` | Blue | Normal operation milestones |
| `"warning"` | Orange | Something unexpected but non-fatal |
| `"error"` | Red | Failures that affect the agent's output |

---

## Metadata

The `metadata` object is displayed as a collapsible key-value panel in the dashboard. Include anything useful for debugging:

```typescript
log("Vector search complete", "info", {
  collection: "travel_knowledge_base",
  query: "Tokyo hotels near Shibuya",
  results_count: 12,
  top_score: 0.94,
  latency_ms: 45,
});
```

---

## Common Patterns

### Retrieval Logging

```typescript
async function retrieveDocuments(query: string): Promise<Document[]> {
  const topK = sdk.agent("rag-agent").cfg("retrieval.topK", 5) as number;
  const results = await vectorDb.query(query, topK);

  sdk.log(`Retrieved ${results.length} documents`, "info", {
    collection: "knowledge_base",
    query,
    top_score: results[0]?.score ?? 0,
    topK,
  });

  return results;
}
```

### Business Logic Milestones

```typescript
async function runTravelAgent(userRequest: string): Promise<string> {
  sdk.log("Starting travel planning", "info", { request_length: userRequest.length });

  const destination = await extractDestination(userRequest);
  sdk.log("Destination identified", "info", { destination });

  const budget = await extractBudget(userRequest);
  sdk.log("Budget parsed", "info", { budget_usd: budget });

  const hotels = await searchHotels(destination);
  sdk.log(`Found ${hotels.length} hotels`, hotels.length ? "info" : "warning");

  return generateItinerary(destination, hotels, budget);
}
```

### Cost Monitoring

```typescript
let cumulativeCost = 0;

function trackCost(responseCost: number): void {
  cumulativeCost += responseCost;
  const budget = sdk.agent("my-agent").cfg("budget.maxCostUsd", 1.0) as number;

  if (cumulativeCost > budget * 0.8) {
    sdk.log(
      `Cost warning: $${cumulativeCost.toFixed(4)} of $${budget.toFixed(2)} budget used`,
      "warning",
      {
        current_cost: cumulativeCost,
        budget,
        percentage: Math.round(cumulativeCost / budget * 100),
      },
    );
  }
}
```

### Debug Tracing

```typescript
async function complexRoutingLogic(intent: string): Promise<string> {
  sdk.log(`Starting routing for intent: ${intent}`, "debug");

  const candidates = await getAgentCandidates(intent);
  sdk.log(`Found ${candidates.length} candidate agents`, "debug", { candidates });

  const selected = await scoreAndSelect(candidates, intent);
  sdk.log(`Selected agent: ${selected}`, "debug");

  return selected;
}
```

---

## Module vs. Instance

Both forms behave identically — the module-level function delegates to the default instance:

```typescript
import { log } from "@syrin/sdk";

// Module-level
log("Process started", "info", { pid: process.pid });

// Instance method (same behavior)
sdk.log("Process started", "info", { pid: process.pid });
```

---

## `log()` vs. `emit()`

| Feature | `log()` | `emit()` |
|---------|---------|----------|
| Message text | Yes (required first arg) | Optional (in payload) |
| Log levels | Yes | No |
| Metadata | Yes | Yes (as payload fields) |
| First-class event rendering | No (generic CUSTOM_LOG) | Yes (HANDOFF, GUARDRAIL, etc.) |
| Use case | Application logs, operational text | Lifecycle events with specific semantics |

Use `log()` for free-form operational text: "Retrieved 42 docs", "Cost at 80%", "External API failed". Use `emit()` for structured lifecycle events that the dashboard renders with specialized UI: guardrails, agent handoffs, budget warnings, AGENT_FORK/JOIN.
