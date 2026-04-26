---
title: "Observability"
description: "Auto-instrumentation for OpenAI — every LLM call captured with zero code changes. Streaming, async, tool calls, custom lifecycle events, and full OTel span export."
weight: 40
---

## Your Agent Is Already Observable. You Just Don't Know It Yet.

The moment you `await init()`, the SDK patches every OpenAI instance already loaded in your process. From that point on, every `chat.completions.create` call is automatically captured — model, tokens, cost, latency, streaming status, and optional prompt/completion content — without any changes to your existing code.

### How Auto-Instrumentation Works in Node.js

`init()` calls `patchOpenAI()`, which lazily imports the `openai` npm package and patches `Completions.prototype.create` at the class prototype level. This means:

1. Your existing `client.chat.completions.create(...)` calls are unchanged
2. The patched prototype intercepts every call before it reaches the API
3. On response, the wrapper extracts metadata and emits an `LLM_CALL` event to the Syrin ingest pipeline
4. The original response object is returned to your code, unmodified

The patch is idempotent — calling `init()` twice does not double-wrap. If `openai` is not installed, the patch step is silently skipped (no error thrown).

```
patchOpenAI() flow
──────────────────────────────────────────────────────────────────
import('openai')
  → Completions.prototype.create = patchedCreate(original, core)
  → every instance shares the patched prototype (zero per-instance overhead)
──────────────────────────────────────────────────────────────────
```

### Supported Libraries

| Library | Auto-Instrumented | Status |
|---------|------------------|--------|
| OpenAI (`openai` npm) | `chat.completions.create` — sync, async, streaming | Available |
| Anthropic | `messages.create` | Coming soon |
| LangChain | LLM + chain calls | Coming soon |

---

### What Gets Captured Per LLM Call

Every `LLM_CALL` event contains:

```json
{
  "event_id": "evt_01j9k3m2...",
  "event_type": "LLM_CALL",
  "session_id": "u:alice:2026-04-24",
  "agent_id": "travel-assistant",
  "model": "gpt-4o",
  "provider": "openai",
  "input_tokens": 342,
  "output_tokens": 187,
  "cost_usd": 0.00529,
  "duration_ms": 1240,
  "stream": false,
  "config_applied": true,
  "finish_reason": "stop",
  "call_index": 3,
  "context_utilization": 0.21,
  "conversation_hash": "a3f9b12c...",
  "tool_set_hash": "d78e1f4a...",
  "timestamp": "2026-04-24T14:32:01.123Z"
}
```

When `captureContent: true`, the event also includes:
- `messages` — the full message array sent to the API
- `completion` — the full response text

### PII-Safe Defaults

By default, `captureContent` is `false`. Only metadata (tokens, cost, model, latency) is transmitted. Prompt text and completion content stay local.

```typescript
import { init } from "@syrin/sdk";

// PII-safe (default) — only metadata transmitted
const sdk = await init({ apiKey: "syrin_...", agentId: "my-agent" });

// Enable content capture for session replay in the dashboard
const sdk = await init({
  apiKey: "syrin_...",
  agentId: "my-agent",
  captureContent: true,
});
```

---

### Zero-Code Instrumentation Example

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";

// After this line, all OpenAI calls in this process are instrumented
const sdk = await init({ apiKey: "syrin_...", agentId: "my-agent" });

const client = new OpenAI();

// No changes needed — this call is automatically captured
const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(response.choices[0].message.content);
```

> **Note:** You must `await init()`. If you skip the await, the OpenAI prototype may not be patched before your first API call, and telemetry will be silently missed.

---

### Streaming Support

Streaming calls are fully supported. The SDK wraps the async iterator returned by `chat.completions.create({ stream: true })`, accumulates chunks as they arrive, and emits the final `LLM_CALL` event with total token counts when the stream ends.

```typescript
const stream = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Tell me a story" }],
  stream: true,
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content ?? "";
  process.stdout.write(delta);
}
// Stream ends → LLM_CALL event emitted with stream: true
```

The wrapper is a transparent `Proxy` — `for await` iteration, `.controller`, and any other properties on the stream object pass through unchanged.

---

### Async Support

Async calls are captured identically to sync calls. The patched `create` is always `async` — it awaits the original and then calls `afterCall` before returning.

```typescript
import OpenAI from "openai";

const client = new OpenAI();

async function runAgent(userMessage: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: userMessage }],
  });
  return response.choices[0].message.content ?? "";
}
```

No special setup is needed. Concurrent calls in the same process are all captured and associated with their correct sessions via `AsyncLocalStorage`.

---

### Custom Lifecycle Events with `sdk.emit()`

Beyond LLM calls, you can emit named lifecycle events from anywhere in your agent code. These appear in the dashboard timeline alongside LLM calls and are queryable in the traces view.

```typescript
sdk.emit(eventType: string, payload?: Record<string, unknown>, sessionId?: string): void
```

Active context fields (`agentId`, `runId`, `workflowId`, `swarmId`) are automatically resolved from `AsyncLocalStorage` — no need to pass them manually.

#### Built-in Event Types

| Event Type | Dashboard Display | Typical Use |
|------------|------------------|-------------|
| `GUARDRAIL_INPUT` | Guardrail badge on timeline | Input validation passed/failed |
| `GUARDRAIL_OUTPUT` | Guardrail badge on timeline | Output validation passed/failed |
| `CIRCUIT_BREAKER_OPEN` | Warning marker | Downstream service unavailable |
| `CIRCUIT_BREAKER_CLOSE` | Recovery marker | Downstream service restored |
| `HANDOFF` | Agent transition arrow | Routing between sub-agents |
| `AGENT_FORK` | Fork point on timeline | Spawning parallel agents |
| `AGENT_JOIN` | Join point on timeline | Collecting parallel results |
| `WORKER_SPAWNED` | Worker spawn marker | New worker agent started |
| `BUDGET_ESTIMATION` | Budget gauge | Cost estimate before run |
| `TOOL_SELECTED` | Tool call annotation | Manual tool dispatch tracking |
| `CHECKPOINT` | Checkpoint pin | Milestone annotation |

#### Emitting Custom Events

```typescript
// Guardrail check
sdk.emit("GUARDRAIL_INPUT", { name: "pii_filter", passed: true, rule: "no-ssn" });

// Agent handoff
sdk.emit("HANDOFF", { from_agent: "orchestrator", to_agent: "researcher", reason: "research_task" });

// Circuit breaker
sdk.emit("CIRCUIT_BREAKER_OPEN", { service: "flight-api", failure_count: 5 });

// Budget estimation before an expensive operation
sdk.emit("BUDGET_ESTIMATION", {
  estimated_cost_usd: 0.12,
  budget_usd: 1.0,
  remaining_usd: 0.88,
});

// Checkpoint annotation on the timeline
sdk.checkpoint("itinerary-confirmed", { destination: "Tokyo", nights: 7 });
```

#### Payload Fields

Any key-value pairs you include in `payload` are merged into the event. The following fields are always set automatically:

| Field | Source |
|-------|--------|
| `event_id` | Generated (`evt_` prefix) |
| `timestamp` | `new Date().toISOString()` |
| `session_id` | `AsyncLocalStorage` → `sessionId` option |
| `agent_id` | `AsyncLocalStorage` → `agentId` option |
| `run_id` | `AsyncLocalStorage` (set by `withAgent`) |
| `workflow_id` | `AsyncLocalStorage` (set by `withWorkflow`) |

---

### Advanced Telemetry Signals

Beyond the basic cost and token fields, the SDK computes and includes the following signals on every `LLM_CALL` event:

| Signal | Type | Description |
|--------|------|-------------|
| `conversation_hash` | string (SHA-256 prefix) | Fingerprint of the full message history. Identical hashes across calls indicate the agent is repeating the same context — a loop detection signal. |
| `context_utilization` | float (0.0–1.0) | Fraction of the model's context window consumed by the current message list. A value above 0.9 indicates context pressure. |
| `tool_set_hash` | string (SHA-256 prefix) | Fingerprint of the tool definitions array. Changes when tools are added, removed, or redefined mid-session. |
| `call_index` | int | Sequential LLM call counter within the session. Starts at 0. Useful for ordering calls in the timeline when timestamps have sub-millisecond resolution. |
| `system_prompt_hash` | string (SHA-256 prefix) | Fingerprint of the system message content. Detects prompt injection or drift. |
| `model_config_hash` | string (SHA-256 prefix) | Fingerprint of `{ model, temperature, max_tokens, top_p }`. Changes when any parameter shifts. |
| `message_count` | int | Total number of messages in the conversation at call time. |
| `has_refusal` | bool | True when the response text matches common refusal patterns. |

---

### Config Observation

When a remote config override is active during an LLM call, `config_applied: true` is recorded in the event. You can see in the dashboard exactly which calls had an override in effect, and cross-reference with the config change audit log.

```typescript
// Remote config is active (e.g. temperature: 0.2 pushed from dashboard)
const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [...],
});
// → event includes config_applied: true
//   and the actual temperature that was sent to OpenAI
```

---

### OpenTelemetry Spans

The SDK emits one OTel span per LLM call using the `gen_ai.*` semantic conventions with `syrin.*` extensions. Spans are disabled by default (`otelExporter: "none"`).

```typescript
// Console exporter — useful for local development
const sdk = await init({
  apiKey: "syrin_...",
  agentId: "my-agent",
  otelExporter: "console",
});

// OTLP exporter — for Jaeger, Tempo, Honeycomb, Datadog, etc.
const sdk = await init({
  apiKey: "syrin_...",
  agentId: "my-agent",
  otelExporter: "otlp",
  otelEndpoint: "http://your-collector:4318",
});
```

Span name format: `chat {model}` (e.g. `chat gpt-4o`).

**Standard `gen_ai.*` attributes** — `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens`, `gen_ai.response.finish_reasons`.

**Syrin `syrin.*` extension attributes** — `syrin.session_id`, `syrin.agent_id`, `syrin.cost_usd`, `syrin.cumulative_cost_usd`, `syrin.config_applied`, `syrin.call_index`, `syrin.context_utilization`, `syrin.conversation_hash`, `syrin.tool_set_hash`, `syrin.system_prompt_hash`.

When `captureContent: true`, span events are added for each input message (`gen_ai.{role}.message`) and the output choice (`gen_ai.choice`).

See [otel-reference.md](../otel-reference.md) for the full attribute table, span event schema, and provider mapping.

---

### Batch Event Delivery

Events are queued in memory and flushed to the Syrin ingest endpoint in batches. Two flush strategies run in parallel:

| Strategy | Trigger | Config Option | Default |
|----------|---------|---------------|---------|
| Batch-full flush | Queue reaches `batchSize` events | `batchSize` | `10` |
| Idle flush | `idleFlushMs` ms after first queued event | `idleFlushMs` | `10 000 ms` |

```typescript
const sdk = await init({
  apiKey: "syrin_...",
  agentId: "my-agent",
  batchSize: 5,       // flush every 5 events
  idleFlushMs: 3000,  // flush after 3 s of inactivity
});
```

The idle flush timer is scheduled lazily on the first `emit()` call after a flush — it does not run continuously. In Node.js, the timer is `unref()`-ed so it does not prevent the process from exiting.

#### `sdk.flush()` — Immediate Flush

Call `flush()` to force an immediate delivery of all queued events. This is important before process exit, at the end of a request handler, or after a critical event you want guaranteed delivery on.

```typescript
// Flush before Lambda returns
sdk.emit("GUARDRAIL_OUTPUT", { name: "safety_check", passed: false });
await sdk.flush();
return response;
```

For clean process shutdown, use `sdk.shutdown()` — it stops the heartbeat, flushes all pending events, and unpatches the OpenAI prototype.

```typescript
process.on("SIGTERM", async () => {
  await sdk.shutdown();
  process.exit(0);
});
```

---

### What the Dashboard Shows

Once your agent is instrumented, the Syrin dashboard provides:

#### Call Timeline
A chronological view of every LLM call, lifecycle event, guardrail check, and agent handoff in a session. Click any event to see its full payload, including which config overrides were active at that moment.

#### Cost and Token Breakdown
- **Total calls** — per session, per agent, per time window
- **Total tokens** — input + output, broken down by model
- **Total cost** — in USD, by model and by agent
- **Avg latency** — P50 / P95 / P99 per model
- **Cost per session** — for monitoring per-conversation economics

#### Session Replay
When `captureContent: true` is set, the dashboard reconstructs the full conversation: user messages, assistant responses, tool calls, and any injected system messages. Useful for debugging unexpected agent behavior without adding logging to your code.

#### Loop Detection
The `conversation_hash` signal feeds the backend's drift analysis. Sessions where the same context hash appears more than once trigger a `loop_detected` flag, which appears as a warning in the session view and can trigger a governance `stop` action.

---

### Full Example

```typescript
import { init, withSession } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  agentId: "travel-assistant",
  captureContent: false,      // PII-safe default
  batchSize: 10,
  idleFlushMs: 5000,
});

const client = new OpenAI();

async function handleRequest(userId: string, message: string): Promise<string> {
  return withSession(`user:${userId}`, async () => {
    // Emit a lifecycle event before the LLM call
    sdk.emit("GUARDRAIL_INPUT", { name: "content_filter", passed: true });

    // This call is automatically captured — no changes needed
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful travel assistant." },
        { role: "user", content: message },
      ],
    });

    const answer = response.choices[0].message.content ?? "";

    sdk.emit("GUARDRAIL_OUTPUT", { name: "content_filter", passed: true });
    sdk.checkpoint("response-ready", { char_count: answer.length });

    return answer;
  });
}

// Flush before exit
process.on("SIGTERM", () => sdk.shutdown().then(() => process.exit(0)));
```
