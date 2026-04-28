---
title: "Observability"
description: "Auto-instrumentation for OpenAI, Anthropic, and Gemini — every LLM call captured with zero code changes. Streaming, async, tool calls, custom lifecycle events, and full OTel span export."
weight: 40
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
- captureContent defaults to FALSE — prompts/completions are NOT sent unless enabled
- OpenAI, Anthropic, AND Gemini are all auto-instrumented on init() — no adapters= needed
- sdk.flush() is ASYNC — must be awaited before process exit
- The SDK is FAIL-OPEN — if it crashes, your LLM call still executes and returns normally
- LLM responses are NOT modified — the SDK only observes and records
-->

> **AI Agent Quick Reference** — Everything is captured automatically after `await init()`:
> ```typescript
> import OpenAI from "openai";
> import { init } from "@syrin/sdk";
> const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" }); // ← await
> const client = new OpenAI();
> // All calls to client.chat.completions.create() are now captured automatically
> ```
> Common mistakes: (1) forgetting `await` on `init()` — without it, the prototype patch may not be applied before your first LLM call; (2) setting `captureContent: true` in production with PII in prompts — defaults are PII-safe; (3) not calling `await sdk.flush()` before process exit in serverless — events in the queue will be lost.

## Your Agent Is Already Observable

The moment you `await init()`, the SDK patches every OpenAI, Anthropic, and Gemini instance already loaded in your process. From that point on, every LLM call is automatically captured — model, tokens, cost, latency, streaming status, and optional prompt/completion content — without any changes to your existing code.

Open [app.syrin.ai → Sessions](https://app.syrin.ai) after your first run to see the full session timeline in real time.

---

## How Auto-Instrumentation Works

`init()` calls `patchOpenAI()`, `patchAnthropic()`, and `patchGemini()`, which patch the respective client prototypes at the class level:

- `openai`: `Completions.prototype.create` patched
- `@anthropic-ai/sdk`: `Messages.prototype.create` patched
- `@google/generative-ai` (old) + `@google/genai` (new): `GenerativeModel.prototype.generateContent` patched

Every instance of these clients shares the patched prototype — zero per-instance overhead:

```
patchOpenAI() flow
──────────────────────────────────────────────────────────────────
import('openai')
  → Completions.prototype.create = patchedCreate(original, core)
  → every existing and future client instance is now patched
  → the original response is returned to your code unmodified
──────────────────────────────────────────────────────────────────
```

The patch is idempotent — calling `init()` twice does not double-wrap. If a library is not installed, the patch step is silently skipped.

---

## Supported Providers

| Library | Auto-Instrumented | Status |
|---------|------------------|--------|
| `openai` npm | `chat.completions.create` — sync, async, streaming | Available |
| `@anthropic-ai/sdk` | `messages.create` — sync, async, streaming | Available |
| `@google/generative-ai` | `generateContent` — old API | Available |
| `@google/genai` | `generateContent` — new API | Available |

All three providers are instrumented automatically. No `adapters:` option needed.

---

## What Gets Captured Per LLM Call

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

---

## PII-Safe Defaults

By default, `captureContent` is `false`. Only metadata (tokens, cost, model, latency) is transmitted. Prompt text and completion content stay local.

```typescript
// PII-safe (default) — only metadata transmitted
const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });

// Enable content capture for session replay in the dashboard
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "my-agent",
  captureContent: true,
});
```

> ⚠️ **Enable `captureContent: true` and:** every prompt and completion text is transmitted to the Syrin backend. Do not enable this if your prompts contain user PII, medical data, or other sensitive content you are not authorized to share.

---

## Zero-Code Instrumentation Example

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });

const client = new OpenAI();

// No changes to your existing code — this call is automatically captured
const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(response.choices[0].message.content);
```

---

## Streaming Support

Streaming calls are fully supported. The SDK wraps the async iterator, accumulates chunks as they arrive, and emits the final `LLM_CALL` event with total token counts when the stream ends:

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

The wrapper is a transparent `Proxy` — `for await` iteration, `.controller`, and any other properties pass through unchanged.

---

## Advanced Telemetry Signals

Beyond basic cost and token fields, every `LLM_CALL` event includes:

| Signal | Type | Description |
|--------|------|-------------|
| `conversation_hash` | string (SHA-256 prefix) | Fingerprint of the full message history. Identical hashes across calls indicate the agent is repeating the same context — a loop detection signal. |
| `context_utilization` | float (0.0–1.0) | Fraction of the model's context window consumed. A value above 0.9 indicates context pressure. |
| `tool_set_hash` | string (SHA-256 prefix) | Fingerprint of the tool definitions array. Changes when tools are added, removed, or redefined mid-session. |
| `call_index` | int | Sequential LLM call counter within the session. Starts at 0. |
| `system_prompt_hash` | string (SHA-256 prefix) | Fingerprint of the system message. Detects prompt injection or drift. |
| `model_config_hash` | string (SHA-256 prefix) | Fingerprint of `{ model, temperature, max_tokens, top_p }`. Changes when any parameter shifts. |
| `message_count` | int | Total number of messages in the conversation at call time. |
| `has_refusal` | bool | True when the response text matches common refusal patterns. |

---

## Custom Lifecycle Events with `sdk.emit()`

Emit named lifecycle events from anywhere in your agent code. These appear in the dashboard timeline alongside LLM calls:

```typescript
sdk.emit(eventType: string, payload?: Record<string, unknown>, sessionId?: string): void
```

All active context fields (`agentId`, `runId`, `workflowId`, `swarmId`) are automatically resolved from `AsyncLocalStorage` — you don't need to pass them.

**Built-in event types:**

| Event Type | Dashboard Display | Typical Use |
|------------|------------------|-------------|
| `GUARDRAIL_INPUT` | Guardrail badge | Input validation passed/failed |
| `GUARDRAIL_OUTPUT` | Guardrail badge | Output validation passed/failed |
| `CIRCUIT_BREAKER_OPEN` | Warning marker | Downstream service unavailable |
| `CIRCUIT_BREAKER_CLOSE` | Recovery marker | Downstream service restored |
| `HANDOFF` | Agent transition arrow | Routing between sub-agents |
| `AGENT_FORK` | Fork point | Spawning parallel agents |
| `AGENT_JOIN` | Join point | Collecting parallel results |
| `WORKER_SPAWNED` | Worker spawn marker | New worker agent started |
| `BUDGET_ESTIMATION` | Budget gauge | Cost estimate before run |
| `TOOL_SELECTED` | Tool call annotation | Manual tool dispatch tracking |
| `CHECKPOINT` | Checkpoint pin | Milestone annotation |

```typescript
sdk.emit("GUARDRAIL_INPUT",  { name: "pii_filter", passed: true });
sdk.emit("HANDOFF",          { from_agent: "orchestrator", to_agent: "researcher" });
sdk.emit("BUDGET_ESTIMATION",{ estimated_cost_usd: 0.12, budget_usd: 1.0 });
sdk.checkpoint("itinerary-confirmed", { destination: "Tokyo", nights: 7 });
```

---

## OpenTelemetry Spans

The SDK emits one OTel span per LLM call using the `gen_ai.*` semantic conventions with `syrin.*` extensions. Spans are disabled by default (`otelExporter: "none"`).

```typescript
// Console exporter — local development
const sdk = await init({
  apiKey: "syrin_pk_...",
  otelExporter: "console",
});

// OTLP exporter — Jaeger, Tempo, Honeycomb, Datadog
const sdk = await init({
  apiKey: "syrin_pk_...",
  otelExporter: "otlp",
  otelEndpoint: "http://your-collector:4318",
});
```

Span name format: `chat {model}` (e.g., `chat gpt-4o`).

**Standard `gen_ai.*` attributes:** `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens`, `gen_ai.response.finish_reasons`.

**Syrin `syrin.*` extension attributes:** `syrin.session_id`, `syrin.agent_id`, `syrin.cost_usd`, `syrin.cumulative_cost_usd`, `syrin.config_applied`, `syrin.call_index`, `syrin.context_utilization`, `syrin.conversation_hash`, `syrin.tool_set_hash`, `syrin.system_prompt_hash`.

---

## Batch Event Delivery

Events are queued in memory and flushed in batches:

| Strategy | Trigger | Config Option | Default |
|----------|---------|---------------|---------|
| Batch-full flush | Queue reaches `batchSize` events | `batchSize` | `100` |
| Idle flush | `idleFlushMs` ms after first queued event | `idleFlushMs` | `10 000 ms` |

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  batchSize: 5,       // flush every 5 events
  idleFlushMs: 3000,  // flush after 3 s of inactivity
});
```

### `sdk.flush()` — Immediate Flush

Force an immediate delivery of all queued events — important before process exit or at the end of a serverless function:

```typescript
sdk.emit("GUARDRAIL_OUTPUT", { name: "safety_check", passed: false });
await sdk.flush();   // ← await required
return response;
```

For clean process shutdown, `sdk.shutdown()` stops the heartbeat, flushes all pending events, and unpatches the OpenAI prototype:

```typescript
process.on("SIGTERM", async () => {
  await sdk.shutdown();
  process.exit(0);
});
```

---

## What the Dashboard Shows

Once your agent is instrumented, [app.syrin.ai](https://app.syrin.ai) provides:

**Call Timeline** — every LLM call, lifecycle event, guardrail check, and agent handoff in a session. Click any event to see its full payload.

**Cost and Token Breakdown:**
- Total calls per session, per agent, per time window
- Total tokens: input + output, by model
- Total cost in USD, by model and agent
- P50 / P95 / P99 latency per model

**Session Replay** — when `captureContent: true`, reconstructs the full conversation for debugging.

**Loop Detection** — the `conversation_hash` signal feeds drift analysis. Sessions where the same context hash repeats trigger a `loop_detected` flag.

---

## Full Example

```typescript
import { init, withSession } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  agentId: "travel-assistant",
  captureContent: false,  // PII-safe
  batchSize: 10,
  idleFlushMs: 5000,
});

const client = new OpenAI();

async function handleRequest(userId: string, message: string): Promise<string> {
  return withSession(`user:${userId}`, async () => {
    sdk.emit("GUARDRAIL_INPUT", { name: "content_filter", passed: true });

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful travel assistant." },
        { role: "user",   content: message },
      ],
    });

    const answer = response.choices[0].message.content ?? "";

    sdk.emit("GUARDRAIL_OUTPUT", { name: "content_filter", passed: true });
    sdk.checkpoint("response-ready", { char_count: answer.length });

    return answer;
  });
}

process.on("SIGTERM", async () => {
  await sdk.shutdown();
  process.exit(0);
});
```
