---
title: "Introduction"
description: "Syrin gives your TypeScript AI agent a live dashboard, remote controls, and automatic safety guardrails — without changing how you write LLM calls."
weight: 1
---

## You Built an Agent. Now You Need to Understand It.

You have an AI agent making LLM calls. Maybe it answers customer questions. Maybe it researches topics and writes reports. Maybe multiple agents hand off work to each other. Whatever it does, right now it's a black box: you run it, and you hope it works.

**Syrin changes that.** Add two lines to your existing code, and you get:

- A live dashboard showing every LLM call your agent makes, how long it took, and what it cost
- The ability to change your agent's behavior (model, temperature, system prompt) from a web browser — without touching your code or redeploying
- Automatic detection when your agent gets stuck in a loop or goes over budget, with the ability to stop it automatically

None of your existing code needs to change. Syrin listens to your OpenAI calls silently in the background.

---

## What "Monitoring an Agent" Actually Means

Imagine you ran your agent 50 times today. Without monitoring, you have no idea:

- Which runs cost the most money
- Which runs failed or gave bad answers
- Whether changing your system prompt made responses better or worse
- Whether your agent called the same tool 30 times in a loop before crashing

Syrin captures every LLM call your agent makes and sends it to a dashboard at **[app.syrin.ai](https://app.syrin.ai)**. From that dashboard you can see each "session" (one user's conversation), drill into every message sent and received, and see the total cost in dollars.

---

## The Two Lines You Add

```typescript
import { init } from "@syrin/sdk";

const sdk = await init({
  apiKey: "syrin_pk_...",   // your Syrin API key
  agentId: "my-agent",      // a name for your agent in the dashboard
});
```

That's it. After `await init()`, every call to `openai.chat.completions.create(...)` is automatically captured and sent to your dashboard. Your existing code doesn't change.

**Why `await`?** The SDK patches the OpenAI library asynchronously — it rewrites one internal method so that every call your code makes is intercepted. This patching has to complete before you make your first LLM call. If you forget `await`, your first LLM call might not be captured.

**Why does this work?** When you call `await init()`, the SDK quietly wraps OpenAI's prototype method. From that point forward, every time your code calls OpenAI, the SDK intercepts it, records what happened (model, tokens, cost, duration), and sends that data to Syrin's backend. Your OpenAI call still executes normally — the SDK never slows it down or changes its output.

---

## Key Concepts in Plain English

### Sessions

A **session** is one conversation with one user. When a user asks your agent something, all the LLM calls that happen to answer that question belong to the same session.

Without sessions, every LLM call shows up as a separate event and you can't tell which calls were part of the same conversation. With sessions, you can open the dashboard and see "Alice asked about Tokyo and it took 3 LLM calls and cost $0.02."

You create a session by wrapping your code in `sdk.withSession({ userId: "alice" }, async () => { ... })`.

### Remote Config

**Remote config** means changing your agent's settings (like which model to use, or how creative its responses should be) from the dashboard — without editing your code and redeploying.

You tell Syrin about a setting by calling `agent.field("llm.temperature", 0.7, { ge: 0, le: 2 })`. After that, the dashboard shows a slider you can drag. When you save a new value, your agent picks it up on its next call automatically.

### Governance

**Governance** is automatic safety rules for your agent. For example: "if the agent makes more than 20 LLM calls in one session, stop it and throw an error."

The Syrin backend watches your agent's behavior and can send instructions back to the SDK. If it detects a loop (your agent repeating the same thing over and over), it can tell the SDK to throw a `GovernanceStopError` — stopping the agent before it wastes more money.

---

## What Gets Captured Per LLM Call

Every LLM call your agent makes sends this data to Syrin automatically:

```json
{
  "event_type":   "LLM_CALL",
  "model":        "gpt-4o",
  "input_tokens": 342,
  "output_tokens": 187,
  "cost_usd":     0.00529,
  "duration_ms":  1240,
  "session_id":   "u:alice:2026-04-27",
  "agent_id":     "my-agent",
  "timestamp":    "2026-04-27T14:32:01.123Z"
}
```

The prompt text and response text are **not sent by default** — only the metadata above. This protects any sensitive information in your prompts. If you want to enable full conversation replay in the dashboard, add `captureContent: true` to `init()`.

---

## The Dashboard at app.syrin.ai

After any instrumented run, open **[app.syrin.ai](https://app.syrin.ai)** and you will see:

- **Sessions** — a list of every conversation, with total cost, number of LLM calls, and a timeline of exactly what happened
- **Agents > Config** — live controls (sliders, dropdowns, text fields) for every setting you registered with `field()` or `cfg()`
- **Governance** — a log of any safety rules that fired and any agents that were stopped automatically
- **Analytics** — daily cost charts, model usage breakdowns, and latency trends

The dashboard updates in real time as your agent runs. Open it in a browser tab while your code executes and watch the events appear.

---

## Getting Started

1. [Installation](./installation) — install the package and set your API key
2. [Quickstart](./quickstart) — add Syrin to a real agent and see it in the dashboard, step by step
3. [Dashboard Guide](./dashboard-guide) — a full tour of every section at app.syrin.ai
