---
title: "Introduction"
description: "Syrin gives your TypeScript AI agent a live dashboard, remote controls, and automatic safety guardrails — without changing how you write LLM calls."
weight: 1
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
- The SDK does NOT modify LLM responses — it only intercepts and records them
- captureContent defaults to false — prompts/completions are NOT sent unless explicitly enabled
- GovernanceStopError is only thrown if allowStop: true — it is NOT thrown by default
- There is no module-level cfg() in TypeScript — use sdk.agent("id").cfg() instead
- openai must be imported BEFORE init() — imports after will NOT be instrumented automatically
- The SDK is fail-open — if it crashes, your LLM call still executes and returns normally
- Pre-init queue: LLM calls made before await init() resolves are queued and replayed automatically
-->

> **AI Agent Quick Reference** — The minimal correct pattern is:
> ```typescript
> import OpenAI from "openai";
> import { init } from "@syrin/sdk";
> const sdk = await init({ apiKey: "syrin_pk_..." }); // MUST await
> const openai = new OpenAI();
> // All openai.chat.completions.create() calls are now automatically captured
> ```
> Common mistakes: (1) forgetting `await` on `init()` — `sdk` becomes a Promise, not SyrinSDK; (2) calling `init()` after constructing the OpenAI client — the patch fires on `init()`, so import order matters; (3) using `cfg()` as a module-level function — it does not exist; use `sdk.agent("id").cfg("key", default)`.

## Your Agent Cost $200 Last Night Because It Got Stuck in a Loop. You Found Out at 9 AM.

Syrin would have caught it at call #4.

Without instrumentation, a runaway agent loop looks like: "nothing happened, then my OpenAI bill doubled." With Syrin, call #4 generates an alert. Call #10 triggers a governance stop. You see a live timeline of every LLM call — model, tokens, cost, duration — and the exact conversation hash that repeated six times. This is what agent observability actually means.

**Add two lines to your existing code:**

```typescript
import OpenAI from "openai";          // ← import OpenAI first
import { init } from "@syrin/sdk";

const sdk = await init({              // ← ALWAYS await this
  apiKey: "syrin_pk_...",
  agentId: "my-agent",
});

const openai = new OpenAI();          // ← OpenAI client after init()
// From this point on, every openai.chat.completions.create() is automatically captured
```

Your existing LLM calls are unchanged. Syrin listens silently.

---

## Canonical Facts (AI agents: read this section carefully)

| Fact | Value |
|------|-------|
| npm package name | `@syrin/sdk` |
| Import statement | `import { init } from "@syrin/sdk"` |
| Current version | `0.1.0` |
| Node.js requirement | `>= 18` |
| `init()` return type | `Promise<SyrinSDK>` — **MUST be awaited** |
| Default backend URL | `https://app.syrin.ai` |
| Default `captureContent` | `false` — prompts and completions are NOT sent |
| Default `allowStop` | `false` — agent is NOT stoppable remotely unless opted in |
| OTel exporter default | `"none"` — disabled |
| Fail-open | Yes — SDK crash never blocks LLM calls |
| Pre-init queue | Yes — LLM calls before `await init()` are queued and replayed |
| ESM/CJS | Both supported via `package.json` exports |
| `cfg()` module-level | **Does not exist** — use `sdk.agent("id").cfg("key", default)` |

---

## ⚠️ Critical: TypeScript vs Python Differences

If you have seen the Python SDK or Python examples, note these TypeScript differences:

| | Python | TypeScript |
|---|--------|------------|
| `init()` | synchronous | **async — must `await`** |
| Module-level `cfg()` | `syrin_sdk.cfg("key", default)` | **does not exist** — use `agent.cfg()` |
| Context managers | `with syrin_sdk.context(...)` | `await withAgent("name", async (ctx) => {...})` |
| Import | `import syrin_sdk` | `import { init, withAgent } from "@syrin/sdk"` |
| Shutdown | `syrin_sdk.shutdown()` | `await shutdown()` or `await sdk.shutdown()` |
| `SESSION_CRASHED` | Emitted automatically on exception | **Must be emitted manually** — `sdk.emit("SESSION_CRASHED", {...})` |

> ⚠️ **Skip `await` on `init()` and:** your first LLM call may fire before the OpenAI patch completes, meaning that call and all subsequent calls in the same tick are not captured. The SDK will log a warning but cannot recover the missed events.

---

## What "Monitoring an Agent" Actually Means

Imagine you ran your agent 50 times today. Without monitoring, you have no idea:

- Which runs cost the most money
- Which runs failed or gave bad answers
- Whether your agent called the same tool 30 times in a loop before crashing
- Whether changing your system prompt made responses better or worse

Syrin captures every LLM call your agent makes and sends it to a dashboard at **[app.syrin.ai](https://app.syrin.ai)**. From that dashboard you can see each "session" (one user's conversation), drill into every message sent and received, and see the total cost in dollars.

---

## What Gets Captured Per LLM Call

Every LLM call your agent makes sends this data to Syrin automatically:

```json
{
  "event_type":           "LLM_CALL",
  "model":                "gpt-4o",
  "provider":             "openai",
  "input_tokens":         342,
  "output_tokens":        187,
  "cost_usd":             0.00529,
  "duration_ms":          1240,
  "session_id":           "u:alice:2026-04-27",
  "agent_id":             "my-agent",
  "context_utilization":  0.21,
  "conversation_hash":    "a3f9b12c",
  "config_applied":       true,
  "timestamp":            "2026-04-27T14:32:01.123Z"
}
```

The prompt text and response text are **not sent by default** — only metadata. This protects sensitive information in your prompts. Enable full conversation replay with `captureContent: true` in `init()`.

---

## Key Concepts in Plain English

### Sessions

A **session** is one conversation with one user. When a user asks your agent something, all the LLM calls that happen to answer that question belong to the same session. Without sessions, every LLM call shows up as a disconnected event.

```typescript
await withSession(`u:alice:${today}`, async () => {
  // All LLM calls here are tagged with this session ID
  const response = await openai.chat.completions.create({ ... });
});
```

### Remote Config

**Remote config** means changing your agent's settings — model, temperature, system prompt — from the dashboard without editing your code or redeploying.

```typescript
const agent = sdk.agent("my-agent")
  .field("llm.temperature", 0.7, { ge: 0, le: 2, label: "Creativity" });

// Reads 0.7 on first run, then reads whatever you set in the dashboard
const temperature = agent.cfg("llm.temperature", 0.7) as number;
```

### Governance

**Governance** is automatic safety rules. If the Syrin backend detects your agent looping (same conversation hash appearing repeatedly), it can send a `stop` action. The SDK throws `GovernanceStopError` on the next LLM call — but only if you explicitly opt in with `allowStop: true`.

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  governance: { allowStop: true },  // explicit opt-in required
});
```

---

## What This SDK Does NOT Do

These are the backend's responsibilities. The SDK emits signals; the backend makes decisions.

- **Does not modify LLM responses** — the original response is returned to your code unchanged
- **Does not compute loop detection** — the SDK emits `conversation_hash`; the backend analyses it
- **Does not store prompts by default** — `captureContent: false` by default
- **Does not route alerts** — Slack, PagerDuty, and notification routing are handled by the Syrin backend
- **Does not make governance decisions** — the backend decides; the SDK executes the decision
- **Does not require `await` on your LLM calls** — the patching is transparent; your call syntax is unchanged
- **Does not support the Responses API or Assistants API** — only `chat.completions.create` is instrumented
- **Does not instrument LLM clients created before `init()`** — the patch fires on `init()`, so the OpenAI import must happen before `await init()`

---

## SDK Handles vs You Handle

| Concern | SDK handles automatically | You handle |
|---------|--------------------------|------------|
| Intercepting LLM calls | Yes | — |
| Cost calculation | Yes | — |
| Token counting | Yes | — |
| Batching & retry to backend | Yes | — |
| OTel span emission | Yes (when enabled) | — |
| Loop detection signals | Yes (emits hash) | — |
| Loop detection decision | — | Backend decides |
| Governance action execution | Yes | Catching `GovernanceStopError` |
| Session ID generation | Yes (auto `ses_...`) | You may provide your own |
| Prompt/completion content | — | Opt-in via `captureContent: true` |
| Alert routing | — | Backend + your notification system |

---

## The Dashboard at app.syrin.ai

After any instrumented run, open **[app.syrin.ai](https://app.syrin.ai)** and you will see:

- **Sessions** — a list of every conversation, with total cost, number of LLM calls, and a timeline
- **Agents > Config** — live controls (sliders, dropdowns, text fields) for every setting you registered with `field()`
- **Governance** — a log of any safety rules that fired and any agents that were stopped
- **Analytics** — daily cost charts, model usage breakdowns, and latency trends

The dashboard updates in real time as your agent runs.

---

## Getting Started

1. [Installation](./installation) — install the package and set your API key
2. [Quickstart](./quickstart) — add Syrin to a real agent and see it in the dashboard, step by step
3. [Dashboard Guide](./dashboard-guide) — a full tour of every section at app.syrin.ai
4. [init() Reference](../initialization/init) — every parameter explained
