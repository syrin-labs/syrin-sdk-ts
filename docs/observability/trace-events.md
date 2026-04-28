---
title: "Trace Events (TraceSpan)"
description: "TraceSpan.log() and withAgent() ctx parameter — emit structured TRACE_EVENT entries from inside agent callbacks."
weight: 45
---

<!--
SYRIN SDK — CANONICAL REFERENCE (TypeScript/JavaScript)
Package: @syrin/sdk  |  Import: import { withAgent } from "@syrin/sdk"
Source of truth: https://github.com/syrin-labs/syrin-sdk-ts

AI AGENTS READING THIS: The statements in this document are the authoritative API contract.
Do not infer undocumented parameters. Do not assume methods exist beyond those listed.
If something is not documented here, it is not part of the public API.

IMPORTANT CORRECTIONS TO COMMON AI MISCONCEPTIONS:
- init() is ASYNC — it returns Promise<SyrinSDK>, you MUST await it
- withAgent() callback receives (ctx: TraceSpan) — NOT (ctx: RunContext) in the public API
- span.log() is SYNCHRONOUS — do NOT await it
- span.log() NEVER throws — it is always fail-open
- Valid trace types: "GUARDRAIL", "TOOL_CALL", "MEMORY", "CONTEXT_UPDATE", "BUDGET_PRE", "BUDGET_POST", "CHECKPOINT", "CUSTOM"
- Any string trace type is accepted — unknown types still emit (fail-open)
- span.log() emits event_type: "TRACE_EVENT" — NOT the traceType string directly
-->

> **AI Agent Quick Reference** — Emit trace events from inside an agent callback:
> ```typescript
> import { withAgent } from "@syrin/sdk";
> await withAgent("researcher", async (span) => { // ← span: TraceSpan
>   span.log("GUARDRAIL", "PII check", { blocked: false }); // ← synchronous, NOT awaited
>   const result = await client.chat.completions.create({ ... });
>   span.log("CUSTOM", "Pipeline stage", { stage: "research" });
> });
> ```
> Common mistakes: (1) `await span.log(...)` — `log()` is synchronous; (2) using the trace type as the event_type — the event is always `event_type: "TRACE_EVENT"` with a `trace_type` field; (3) thinking unknown trace types throw — they don't, any string is accepted.

## Fine-Grained Event Logging Inside Agent Runs

`withAgent()` passes a `TraceSpan` to your callback. The `TraceSpan.log()` method emits a `TRACE_EVENT` entry to the Syrin dashboard with the run context (agent ID, run ID, workflow ID) automatically attached.

Use `span.log()` when you're inside a `withAgent()` callback and want structured events with the full run context — guardrail outcomes, pipeline stages, budget pre/post checks, or custom annotations.

---

## `withAgent()` Callback Signature

```typescript
function withAgent<T>(agentId: string, fn: (span: TraceSpan) => Promise<T>): Promise<T>
```

The `span` parameter is a `TraceSpan` instance. All `RunContext` properties are delegated transparently:

```typescript
await withAgent("researcher", async (span) => {
  console.log(span.agentId);    // "researcher"
  console.log(span.runId);      // "run_..."
  console.log(span.workflowId); // "research-pipeline" (if inside withWorkflow)
  console.log(span.swarmId);    // undefined (if not inside withSwarm)
});
```

The `span` parameter is optional to name or destructure:

```typescript
// With span — use span.log()
await withAgent("researcher", async (span) => {
  span.log("GUARDRAIL", "Input check", { passed: true });
  await client.chat.completions.create({ ... });
});

// Without span — omit the parameter name
await withAgent("researcher", async () => {
  await client.chat.completions.create({ ... });
});
```

---

## `TraceSpan.log()`

**Signature:**
```typescript
span.log(
  traceType: string,
  label?: string,
  data?: Record<string, unknown>
): void
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `traceType` | `string` | required | Category of the event (see valid types below) |
| `label` | `string` | `""` | Human-readable label shown in the dashboard |
| `data` | `Record<string, unknown>` | `{}` | Arbitrary JSON-serializable payload |

`log()` is always synchronous and always fail-open — it never throws.

---

## Valid Trace Types

| Trace Type | When to use |
|------------|-------------|
| `"GUARDRAIL"` | Input or output validation result |
| `"TOOL_CALL"` | Manual tool invocation tracking (prefer `tool()` API for auto tracking) |
| `"MEMORY"` | Memory retrieval step |
| `"CONTEXT_UPDATE"` | Conversation context was modified |
| `"BUDGET_PRE"` | Cost estimate before an expensive operation |
| `"BUDGET_POST"` | Actual cost after an operation |
| `"CHECKPOINT"` | Named milestone inside an agent run |
| `"CUSTOM"` | Anything that doesn't fit the above |

Any string is accepted — unknown types emit a `TRACE_EVENT` with `trace_type` set to the uppercase version of your string.

---

## What Gets Emitted

Each `span.log()` call emits a `TRACE_EVENT` to the Syrin ingest pipeline:

```json
{
  "event_id": "evt_abc123",
  "event_type": "TRACE_EVENT",
  "trace_type": "GUARDRAIL",
  "label": "PII check",
  "data": { "blocked": false, "patterns_checked": 12 },
  "session_id": "u:alice:2026-04-24",
  "agent_id": "researcher",
  "run_id": "run_xyz789",
  "workflow_id": "research-pipeline",
  "swarm_id": null,
  "parent_run_id": null,
  "timestamp": "2026-04-24T14:32:01.123Z"
}
```

The run context (`agent_id`, `run_id`, `workflow_id`, `swarm_id`, `parent_run_id`) is automatically populated from the `TraceSpan`.

---

## Usage Examples

### Guardrail Inside an Agent Run

```typescript
import { init, withSession, withWorkflow, withAgent } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: process.env.SYRIN_API_KEY!, agentId: "researcher" });
const client = new OpenAI();

await withSession("ses_alice", () =>
  withWorkflow("research-pipeline", () =>
    withAgent("query-enhancer", async (span) => {
      // Log guardrail check
      const piiResult = await checkForPII(userInput);
      span.log("GUARDRAIL", "PII check", {
        blocked: piiResult.blocked,
        patterns_found: piiResult.patterns,
      });

      if (piiResult.blocked) return "Request blocked — contains PII";

      // Log budget estimate before LLM call
      span.log("BUDGET_PRE", "Estimated cost", { estimated_usd: 0.003 });

      const result = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: userInput }],
      });

      // Log actual cost after LLM call
      span.log("BUDGET_POST", "Actual cost", { actual_usd: 0.002 });

      return result.choices[0].message.content ?? "";
    })
  )
);
```

### Pipeline Stage Tracking

```typescript
await withAgent("pipeline-controller", async (span) => {
  span.log("CHECKPOINT", "Start", { phase: "initialization" });

  const data = await loadData();
  span.log("CHECKPOINT", "Data loaded", { record_count: data.length });

  const processed = await processData(data);
  span.log("CHECKPOINT", "Processing complete", {
    phase: "processing",
    records_processed: processed.length,
    errors: processed.filter(r => r.error).length,
  });

  span.log("CUSTOM", "Pipeline stage", { stage: "complete" });
  return processed;
});
```

### Memory Retrieval Annotation

```typescript
await withAgent("rag-agent", async (span) => {
  // Annotate the memory retrieval
  const docs = await vectorDb.query(userQuery, { topK: 5 });
  span.log("MEMORY", "Vector search", {
    store: "knowledge_base",
    query: userQuery,
    results: docs.length,
    top_score: docs[0]?.score ?? 0,
  });

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "Answer using the provided context." },
      { role: "user",   content: `Context: ${docs.map(d => d.text).join("\n")}\n\nQuestion: ${userQuery}` },
    ],
  });

  return response.choices[0].message.content ?? "";
});
```

---

## `TraceSpan` vs. `sdk.emit()`

| | `span.log()` | `sdk.emit()` |
|-|--------------|--------------|
| Available | Inside `withAgent()` callback | Anywhere |
| Context | Automatically includes run_id, agent_id, workflow_id | Resolved from AsyncLocalStorage |
| Event type emitted | `TRACE_EVENT` with `trace_type` field | The event type you pass |
| Use case | Structured agent-run events with full run context | General lifecycle events |

Use `span.log()` when you're inside a `withAgent()` callback and want the run context (specifically `run_id`) included. Use `sdk.emit()` for general lifecycle events like `HANDOFF`, `GUARDRAIL_INPUT`, `AGENT_FORK`, etc.

---

## `TraceSpan` Properties

The `span` object transparently delegates all `RunContext` properties:

```typescript
interface TraceSpan {
  readonly agentId:    string | undefined;
  readonly runId:      string;
  readonly workflowId: string | undefined;
  readonly swarmId:    string | undefined;
  readonly parentRunId: string | undefined;
  readonly context:    RunContext;   // the underlying RunContext

  log(traceType: string, label?: string, data?: Record<string, unknown>): void;
}
```

These are read-only properties set by `withAgent()` — you cannot assign to them.
