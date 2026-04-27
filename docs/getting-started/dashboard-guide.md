---
title: "Dashboard Guide"
description: "A full walkthrough of app.syrin.ai — what every section shows, how it connects to your SDK code, and how to act on what you see."
weight: 4
---

## What You See at app.syrin.ai

The Syrin dashboard at **[app.syrin.ai](https://app.syrin.ai)** is where you monitor and control your agents. This page walks through every section: what it shows, which SDK call produces the data, and what actions you can take.

> **Tip:** Keep [app.syrin.ai](https://app.syrin.ai) open in a browser tab while your agent runs. Data appears in real time.

---

## Sessions

**Where:** [app.syrin.ai > Sessions](https://app.syrin.ai)

**What it is:** A list of every user conversation your agent has handled. Each row represents one session — all the LLM calls that happened while serving one user's request.

**What creates it:** Any code inside `sdk.withSession({ userId: "alice" }, ...)` creates or resumes a session. All LLM calls, events, and feedback inside that callback appear in that session's timeline.

### The Sessions List

The Sessions page shows a table. Each row has:

- **Session ID** — either a deterministic ID based on user and date (like `u:alice:2026-04-27`), or an explicit ID you provided
- **Agent** — which agent handled this session (the `agentId` active during the session)
- **Feedback** — a thumbs-up or thumbs-down icon if `ctx.feedback.positive()` or `.negative()` was called
- **Cost** — total cost in USD across all LLM calls in this session
- **Calls** — total number of LLM calls
- **Avg latency** — average response time across all LLM calls
- **Started** — when the session began

You can filter the list by time range, agent name, feedback status, or search by user ID.

### Inside a Session

Click any session row to open its timeline. The timeline shows every event in chronological order:

- `SESSION_STARTED` — when `withSession()` opened
- `LLM_CALL` — one entry for every call to `openai.chat.completions.create()`
- Any custom events you added with `sdk.emit("...", {...})`
- `SESSION_ENDED` — when the callback returned

Each `LLM_CALL` event shows:

- Model name (e.g., `gpt-4o`)
- How many tokens went in and came out
- Cost in USD for that single call
- How long it took in milliseconds
- Whether a config value was active during the call

If `captureContent: true` was set in `init()`, you can click the LLM_CALL event to expand it and see the full conversation text — every message sent to the model and the response it gave.

### Why Sessions Matter

Without sessions, you have a pile of LLM calls with no context. With sessions, you can answer questions like:

- "Alice's session on Tuesday cost $0.15 — why was it so expensive?" (open the session, look at the call count and token counts)
- "Why did this session fail?" (look for error events in the timeline)
- "Did changing the system prompt make responses better?" (compare sessions from before and after the change)

---

## Agents

**Where:** [app.syrin.ai > Agents](https://app.syrin.ai)

**What it is:** Aggregate statistics for each named agent across all its sessions.

**What creates it:** Every unique `agentId` you pass to `init()` or `sdk.agent("...")` creates an agent entry.

### The Agents List

The Agents page shows one row per agent with:

- **Sessions** — total session count
- **Total cost** — cumulative spend across all sessions
- **Calls per session** — average number of LLM calls per session
- **Feedback** — percentage of sessions marked positive

This gives you a high-level health check: if `researcher-agent` costs 3x more than `writer-agent` per session, that is a signal worth investigating.

### Agent Detail

Click an agent name to open its detail page. You will see:

1. **Config panel** — live controls for all settings registered with `field()` or `cfg()` (see the Config section below)
2. **Session history** — all sessions for this agent, with the same timeline view
3. **Cost trend** — a chart showing daily spend for the last 30 days
4. **Model usage** — a breakdown of which models were used and their relative costs
5. **Latency** — response time statistics

---

## Config Panel

**Where:** [app.syrin.ai > Agents > {your-agent-name} > Config](https://app.syrin.ai)

**What it is:** A control panel for your agent's live settings. Every call to `agent.field("section.key", default, opts)` or `agent.cfg("section.key", default)` creates one control here.

**What makes this powerful:** You can change any value here and your agent picks it up on its very next call — no code change, no redeploy.

### How Field Types Map to Controls

When you declare a field with `field()`, the options you pass determine what control appears in the dashboard:

**Numeric field with `ge` and `le` (slider):**

When you write:
```typescript
agent.field("llm.temperature", 0.7, { ge: 0, le: 2, label: "Creativity" });
```

The dashboard shows a slider labeled "Creativity" with a range of 0 to 2 and the current value shown next to it.

**String field with `enum` (dropdown):**

When you write:
```typescript
agent.field("llm.model", "gpt-4o", { enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"] });
```

The dashboard shows a dropdown with those three options. The currently active model is selected.

**String field with `multiline: true` (text area):**

When you write:
```typescript
agent.field("prompt.systemPrompt", "You are a helpful assistant.", { multiline: true });
```

The dashboard shows a resizable text area. You can edit the entire system prompt and save it.

**Boolean field (toggle):**

When you write:
```typescript
agent.field("retrieval.rerankerEnabled", false, { label: "Enable Reranker" });
```

The dashboard shows an on/off toggle switch.

### How to Change a Config Value

1. Navigate to Agents > your agent name > Config
2. Find the field you want to change
3. Adjust the slider, dropdown, text area, or toggle
4. Click **Save Changes**

The dashboard confirms the change with a notification. On your agent's next call to `agent.cfg()`, it returns the new value. No restart needed.

### Config Sections

Fields are grouped by the section prefix in the key name. If your key is `llm.temperature`, it appears in the "llm" section. If your key is `prompt.systemPrompt`, it appears in the "prompt" section. You create sections by choosing a prefix — there is no separate setup step.

### Per-Agent Config

If you use `sdk.agent("researcher").field("llm.temperature", 0.3)`, that field appears under the `researcher` agent's Config tab, not the orchestrator's. Each agent has completely independent config controls. Changing the researcher's temperature does not affect the writer's temperature.

---

## Governance

**Where:** [app.syrin.ai > Governance](https://app.syrin.ai)

**What it is:** A log of safety rule violations and the actions taken automatically by the Syrin backend.

**What "governance" means:** The Syrin backend watches your agent's behavior in real time. If it detects something dangerous — your agent looping, going over a cost limit, or drifting from its intended behavior — it can automatically:

- **Stop** the agent (throws `GovernanceStopError` in your code)
- **Inject a message** into the next LLM call (adds a corrective message to the conversation)
- **Alert** you (sends a notification)

You do not have to write this detection logic yourself. The backend handles it based on the data it receives from your SDK.

### Incidents

When a governance action fires, it creates an **incident record**. The Governance page lists all incidents with:

- The incident ID
- What triggered it (e.g., `LOOP_DETECTED`, `COST_LIMIT_EXCEEDED`)
- Which agent and user session it happened in
- When it happened
- What action was taken

Click any incident to see the session timeline at the exact moment the action fired, the reason text, and a graph of the loop detection score over time.

### Loop Detection Explained

Every LLM call includes a "conversation hash" — a fingerprint of the conversation so far. If your agent keeps sending the same messages over and over, the hash stays the same. The backend tracks these hashes: if the same hash appears 10 or more times within a short window, it concludes the agent is stuck and fires the `LOOP_DETECTED` governance action.

Your code can handle this with a try/catch:

```typescript
import { GovernanceStopError } from "@syrin/sdk";

try {
  await sdk.withSession({ userId: "alice", window: "day" }, async () => {
    while (true) {
      const response = await openai.chat.completions.create({ ... });
      // if a loop is detected, the next call throws GovernanceStopError
    }
  });
} catch (err) {
  if (err instanceof GovernanceStopError) {
    console.error(`Agent stopped: ${err.reason}`);
    // → Agent stopped: Loop detected — 12 identical conversation hashes in 30 seconds
  } else {
    throw err;
  }
}
```

---

## Analytics

**Where:** [app.syrin.ai > Analytics](https://app.syrin.ai)

**What it is:** Cost and usage trends over time, broken down in multiple ways.

The Analytics page shows:

- **Daily cost chart** — total spend per day for the last 30 days. Useful for spotting unusual spikes.
- **Cost by model** — how much each model (gpt-4o, gpt-4o-mini, etc.) contributed to your total spend
- **Cost by agent** — which agent is spending the most
- **Token volume** — input and output token counts over time
- **Session volume** — how many sessions per day
- **Latency trends** — average response time per day

Use this page to answer questions like "my costs doubled on Wednesday — what happened?" or "which agent is the most expensive and should I switch it to a cheaper model?"

---

## Session Replay

**Where:** [app.syrin.ai > Sessions > {session} > Replay tab](https://app.syrin.ai)

**What it is:** A full conversation transcript showing every message sent to the model and every response received, with per-turn cost and latency.

**What enables it:** Setting `captureContent: true` in `init()`:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",
  captureContent: true,   // enables the Replay tab
});
```

Without this flag, the Replay tab exists but only shows event metadata — no conversation text.

The replay shows each turn in sequence: the system prompt, each user message, and each assistant response, with cost and latency shown per LLM call.

> **Privacy warning:** When `captureContent: true`, the full text of every prompt and response is sent to Syrin's servers. Only enable this if your prompts and responses do not contain sensitive personal information, or if you have appropriate data handling agreements in place.

---

## Config Audit Log

**Where:** [app.syrin.ai > Agents > {agent} > Audit Log tab](https://app.syrin.ai)

**What it is:** A record of every config change, showing who changed what and when.

Every time someone changes a value in the Config panel and clicks Save, the audit log records:

- Which field changed
- What the old value was and what the new value is
- Whether it was changed from the dashboard, by governance, or by code
- The timestamp

This is useful for debugging: if your agent's response quality changed suddenly, check the audit log to see if a config value was modified around that time.

---

## Agent Health and Connectivity

**Where:** [app.syrin.ai > Settings > Agents](https://app.syrin.ai)

Each registered agent shows whether the SDK is currently running:

- **LIVE** (green dot) — the SDK is running and sent a heartbeat within the last 60 seconds
- **IDLE** (grey dot) — the process was running but is now stopped or paused

The SDK sends a heartbeat signal every 30 seconds while it is running. This lets you confirm at a glance that your agent process is healthy.

Check connectivity programmatically:

```typescript
const sdk = await init({ apiKey: "syrin_pk_...", agentId: "travel-assistant" });
const ok = await sdk.healthCheck();
console.log(`Backend reachable: ${ok}`);
// → Backend reachable: true
```

---

## Getting Your API Key

If you have not yet created a Syrin account:

1. Go to [app.syrin.ai](https://app.syrin.ai)
2. Sign in or create a free account
3. Navigate to **Settings > API Keys**
4. Click **Create Key**
5. Copy the `syrin_pk_...` value — it is only shown once

Use this key as the `apiKey` parameter in `init()`, or set it as the `SYRIN_API_KEY` environment variable.

---

## Quick Reference: SDK Call to Dashboard Location

| SDK Call | Where it appears in the dashboard |
|----------|----------------------------------|
| `await init({ agentId: "x" })` | Creates agent "x" in the Agents list |
| `sdk.withSession({ userId: "alice" }, ...)` | Creates session in the Sessions list |
| `agent.field("llm.temp", 0.7, { ge: 0, le: 2 })` | Adds a slider in Agents > x > Config |
| Any LLM call inside `withSession()` | Adds an LLM_CALL event to the session timeline |
| `sdk.emit("MY_EVENT", {...})` | Adds a labeled event to the session timeline |
| `ctx.feedback.positive()` | Shows thumbs-up on the session row |
| `GovernanceStopError` thrown | Creates an incident in Governance > Incidents |
| `captureContent: true` | Enables the Replay tab for each session |
