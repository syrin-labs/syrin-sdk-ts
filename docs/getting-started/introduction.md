---
title: "Introduction"
description: "@syrin/sdk — instant observability, live remote config, and backend governance for AI agents in TypeScript and Node.js. One import, one await init(), zero rewrites."
weight: 1
---

## Your AI Agent Just Got a Mission Control

Syrin instruments your AI agents and streams every LLM call, config change, and lifecycle event to a live dashboard at **[app.syrin.ai](https://app.syrin.ai)**. From that dashboard you can watch sessions in real time, tune model parameters without redeploying, and let the backend enforce safety rules your agent respects automatically.

Think of it as **Datadog meets LaunchDarkly, purpose-built for the LLM era**.

---

### What Syrin Does

| Capability | What it means in practice |
|------------|--------------------------|
| **Auto-instrumentation** | Every `openai.chat.completions.create()` call is captured automatically — no changes to your existing code |
| **Remote config** | Change `temperature`, `model`, or `systemPrompt` live from [app.syrin.ai](https://app.syrin.ai) — your agent picks it up on the next call without a redeploy |
| **Sessions** | Group all LLM calls for one user into a single timeline, across any number of processes or replicas |
| **Governance** | The backend can stop a runaway agent, inject a corrective message, or trigger a checkpoint when it detects loops or cost overruns |
| **Multi-agent** | Orchestrators, pipelines, parallel swarms, and arbitrary graphs are all first-class concepts |
| **OTel spans** | Every LLM call emits an OpenTelemetry span with `gen_ai.*` and `syrin.*` attributes, compatible with any OTLP-capable backend |

---

### Integration Is Three Lines

```typescript
import { init } from "@syrin/sdk";    // 1. import
import OpenAI from "openai";

const sdk = await init({              // 2. await init — patches OpenAI automatically
  apiKey: "syrin_pk_...",
  agentId: "my-agent",
});

const client = new OpenAI();          // 3. your unchanged OpenAI client

// Everything below this point is fully observed
const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);
```

After running this, open **[app.syrin.ai → Sessions](https://app.syrin.ai)** and watch the `LLM_CALL` event appear in real time.

> **Always `await init()`** before any LLM calls. The SDK patches OpenAI asynchronously — skipping `await` means your first call may not be instrumented.

---

### What Gets Captured Per LLM Call

Every call emits one structured event automatically:

```json
{
  "event_type":     "LLM_CALL",
  "model":          "gpt-4o",
  "provider":       "openai",
  "input_tokens":   342,
  "output_tokens":  187,
  "cost_usd":       0.00529,
  "duration_ms":    1240,
  "stream":         false,
  "config_applied": true,
  "session_id":     "u:alice:2026-04-27",
  "agent_id":       "my-agent",
  "context_utilization": 0.21,
  "conversation_hash":   "a1b2c3d4",
  "timestamp":      "2026-04-27T14:32:01.123Z"
}
```

Prompt and completion text are **not** captured by default (PII-safe). Enable with `captureContent: true` for full session replay.

---

### What Auto-Instruments

Out of the box, `init()` patches the following when they are installed in your dependencies:

| Library | What is patched |
|---------|----------------|
| `openai` | `chat.completions.create` — sync, async, and streaming |
| `@anthropic-ai/sdk` | `messages.create` and streaming variants |
| `langchain` | All LLM and chain calls via callback hooks |
| `@mastra/core` | Agent execution and tool call events |
| `ai` (Vercel AI SDK) | `generateText`, `streamText`, `generateObject` |

---

### The Dashboard Is Where the Value Lives

After any instrumented run, [app.syrin.ai](https://app.syrin.ai) gives you:

- **Sessions** — every user session with a full event timeline, token counts, and cost
- **Agents → Config** — live sliders, dropdowns, and text areas for every `cfg()` field you declared
- **Governance** — policy status, incidents, loop detection scores, and drift metrics
- **Cost breakdown** — total spend by model, by agent, by day
- **Session replay** — full conversation replay when `captureContent: true`
- **Config audit log** — who changed what, and when

The dashboard is not a "nice to have" — it is the primary interface for operating your agents in production. **Visit [app.syrin.ai](https://app.syrin.ai) after every run** to see what your agent is doing.

---

### Architecture Overview

```
Your Agent Code
      │
      ▼
await init()              ← patches OpenAI / Anthropic / LangChain
      │
      ▼
LLM call (unchanged)      ← intercepted transparently via prototype patch
      │
      ▼
Syrin Emitter             ← batches events, retries on failure
      │
      ▼
Syrin Backend             ← stores, analyses, streams to dashboard
      │
      ▼
app.syrin.ai              ← live session replay, config controls, governance
```

The SDK never proxies your LLM requests — it wraps OpenAI's prototype method directly, so your `baseURL`, retry config, and timeout settings are all preserved.

The SDK is a **nerve system, not a brain**. All intelligence — loop detection, drift scoring, governance decisions — lives in the backend. The SDK collects and transmits; the backend decides and instructs.

---

### Key Concepts at a Glance

| Concept | One-liner |
|---------|-----------|
| `init()` | Start the SDK. Instruments every AI library in the process. Must be `await`-ed. |
| `withSession()` | Open a session scope for a user. Groups all their LLM calls via AsyncLocalStorage. |
| `agent.cfg(key, default)` | Declare a remotely-overridable value. Dashboard shows a live control for it. |
| `sdk.emit(eventType, payload)` | Send a custom lifecycle event to the session timeline. |
| `AgentHandle` | A named agent wrapper — scoped config, field declarations. |
| `GovernanceStopError` | Thrown when the backend tells the agent to stop. |
| `shutdown()` | Flush all buffered events before the process exits. |

---

### Next Steps

- [Installation](./installation) — npm install, env vars, Node 18+ requirement
- [Quickstart](./quickstart) — full working example with console output and dashboard walkthrough
- [Dashboard Guide](./dashboard-guide) — everything you see at app.syrin.ai, explained
- [init() Reference](../initialization/init) — all parameters
- [Remote Config (cfg)](../configuration/cfg) — declare and tune any parameter live
