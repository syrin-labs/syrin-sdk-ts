---
title: "Dashboard Guide"
description: "A full walkthrough of app.syrin.ai — what every section shows, how it connects to your SDK code, and how to act on what you see."
weight: 4
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

> **AI Agent Quick Reference** — Each SDK call maps to exactly one dashboard location. The table at the bottom of this page lists every mapping. If data is not appearing, check: (1) `await init()` was called; (2) LLM calls are inside a `withSession()` block; (3) `sdk.flush()` was called before process exit.

## What You See at app.syrin.ai

The Syrin dashboard at **[app.syrin.ai](https://app.syrin.ai)** is where you monitor and control your agents. This page walks through every section: what it shows, which SDK call produces the data, and what actions you can take.

> **Tip:** Keep [app.syrin.ai](https://app.syrin.ai) open in a browser tab while your agent runs. Data appears in real time.

---

## Sessions

**Where:** [app.syrin.ai > Sessions](https://app.syrin.ai)

**What it is:** A list of every user conversation your agent has handled. Each row represents one session — all the LLM calls that happened while serving one user's request.

**What creates it:** Any code inside `withSession(sessionId, ...)` creates or resumes a session. All LLM calls, events, and feedback inside that callback appear in that session's timeline.

> ⚠️ **Skip `withSession()` and:** LLM calls are still captured but land in the SDK's auto-generated default session (`ses_...`). You cannot tell which calls belonged to which user.

### The Sessions List

The Sessions page shows a table. Each row has:

- **Session ID** — either a deterministic ID you constructed (like `u:alice:2026-04-27`) or an explicit ID you provided
- **Agent** — which agent handled this session (the `agentId` active during the session)
- **Feedback** — a thumbs-up or thumbs-down icon if `sdk.sessions.rate(sessionId, "positive")` or `"negative"` was called
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
- `CHECKPOINT` — milestone annotations
- `GUARDRAIL_INPUT` / `GUARDRAIL_OUTPUT` — guardrail check results
- `HANDOFF` — agent-to-agent transitions
- `SESSION_ENDED` — when the callback returned (or `SESSION_CRASHED` if it threw)

Each `LLM_CALL` event shows:

- Model name (e.g., `gpt-4o`)
- How many tokens went in and came out
- Cost in USD for that single call
- How long it took in milliseconds
- Whether a config value was active during the call (`config_applied: true`)
- Context utilization (fraction of the model's context window used)

If `captureContent: true` was set in `init()`, you can click any `LLM_CALL` event to expand it and see the full conversation text — every message sent and the response received.

### Why Sessions Matter

Without sessions, you have a pile of LLM calls with no context. With sessions, you can answer:

- "Alice's session on Tuesday cost $0.15 — why?" (open the session, look at the call count and token counts)
- "Why did this session fail?" (look for `SESSION_CRASHED` or error events in the timeline)
- "Did changing the system prompt make responses better?" (compare sessions before and after the config change)

---

## Agents

**Where:** [app.syrin.ai > Agents](https://app.syrin.ai)

**What it is:** Aggregate statistics for each named agent across all its sessions.

**What creates it:** Every unique `agentId` you pass to `init()` or `sdk.agent("...")` creates an agent entry.

### The Agents List

Each row shows:

- **Sessions** — total session count
- **Total cost** — cumulative spend across all sessions
- **Calls per session** — average number of LLM calls per session
- **Feedback** — percentage of sessions marked positive

### Agent Detail

Click an agent name to open its detail page:

1. **Config panel** — live controls for all settings registered with `field()` (see the Config section below)
2. **Session history** — all sessions for this agent
3. **Cost trend** — daily spend for the last 30 days
4. **Model usage** — breakdown of which models were used and their relative costs
5. **Latency** — response time statistics

---

## Config Panel

**Where:** [app.syrin.ai > Agents > {your-agent-name} > Config](https://app.syrin.ai)

**What it is:** A control panel for your agent's live settings. Every call to `agent.field("section.key", default, opts)` creates one control here.

**What makes this powerful:** Change any value here and your agent picks it up on its next call — no code change, no redeploy.

### How Field Types Map to Controls

**Numeric field with `ge` and `le` → Slider:**
```typescript
agent.field("llm.temperature", 0.7, { ge: 0, le: 2, label: "Creativity" });
```
The dashboard shows a slider labeled "Creativity" with a range of 0 to 2.

**String field with `enum` → Dropdown:**
```typescript
agent.field("llm.model", "gpt-4o", { enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"] });
```
The dashboard shows a dropdown with those three options.

**String field with `multiline: true` → Textarea:**
```typescript
agent.field("prompt.systemPrompt", "You are a helpful assistant.", { multiline: true });
```
The dashboard shows a resizable textarea.

**Boolean field → Toggle:**
```typescript
agent.field("retrieval.rerankerEnabled", false, { label: "Enable Reranker" });
```
The dashboard shows an on/off toggle switch.

### How to Change a Config Value

1. Navigate to Agents > your agent name > Config
2. Adjust the slider, dropdown, textarea, or toggle
3. Click **Save Changes**

The dashboard confirms the change. On your agent's next `agent.cfg()` call, it returns the new value. No restart needed.

### Config Audit Log

**Where:** [app.syrin.ai > Agents > {agent} > Audit Log tab](https://app.syrin.ai)

Every config change is recorded: who changed what, old value, new value, whether it came from the dashboard or governance, and the timestamp. Use this to debug sudden quality changes — if your agent's responses changed at 3pm, the audit log will show whether a config value was modified at that time.

---

## Governance

**Where:** [app.syrin.ai > Governance](https://app.syrin.ai)

**What it is:** A log of safety rule violations and the actions taken automatically by the Syrin backend.

**What "governance" means:** The Syrin backend watches your agent's behavior in real time. If it detects something dangerous — looping, high cost, or drift — it can:

- **Stop** the agent (throws `GovernanceStopError` in your code — only if `allowStop: true`)
- **Inject a message** into the next LLM call (only if `allowInjectMessage: true`)
- **Alert** you (sends a notification to your configured channels)

### Loop Detection Explained

Every LLM call includes a `conversation_hash` — a fingerprint of the conversation so far. If your agent keeps sending the same messages over and over, the hash stays the same. The backend tracks these hashes: if the same hash appears repeatedly within a short window, it flags a loop.

Your code handles this with a `try/catch`:

```typescript
import { GovernanceStopError } from "@syrin/sdk";
import { init, withSession } from "@syrin/sdk";

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "my-agent",
  governance: { allowStop: true },  // explicit opt-in
});

try {
  await withSession(`u:alice:${today}`, async () => {
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

### Incidents

When a governance action fires, it creates an **incident record** with:

- The incident ID
- What triggered it (e.g., `LOOP_DETECTED`, `COST_LIMIT_EXCEEDED`)
- Which agent and user session it happened in
- When it happened
- What action was taken

---

## Analytics

**Where:** [app.syrin.ai > Analytics](https://app.syrin.ai)

The Analytics page shows:

- **Daily cost chart** — total spend per day for the last 30 days
- **Cost by model** — how much each model contributed to your total spend
- **Cost by agent** — which agent is spending the most
- **Token volume** — input and output token counts over time
- **Session volume** — how many sessions per day
- **Latency trends** — average response time per day

Use this to answer questions like "my costs doubled on Wednesday — what happened?" or "which agent is the most expensive?"

---

## Session Replay

**Where:** [app.syrin.ai > Sessions > {session} > Replay tab](https://app.syrin.ai)

A full conversation transcript — user messages, assistant responses, tool calls, and any injected system messages — with per-turn cost and latency.

**What enables it:** Setting `captureContent: true` in `init()`:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",
  captureContent: true,   // enables the Replay tab
});
```

Without this flag, the Replay tab shows event metadata only — no conversation text.

> **Privacy warning:** When `captureContent: true`, the full text of every prompt and response is sent to Syrin's servers. Only enable this if your prompts do not contain sensitive personal information, or if you have appropriate data handling agreements in place.

---

## Agent Health and Connectivity

**Where:** [app.syrin.ai > Settings > Agents](https://app.syrin.ai)

Each registered agent shows whether the SDK is currently running:

- **LIVE** (green dot) — the SDK is running and sent a heartbeat within the last 60 seconds
- **IDLE** (grey dot) — the process was running but is now stopped or paused

The SDK sends a heartbeat signal every 30 seconds while running. Check connectivity programmatically:

```typescript
const sdk = await init({ apiKey: "syrin_pk_...", agentId: "travel-assistant" });
const ok = await sdk.healthCheck();
console.log(`Backend reachable: ${ok}`);
// → Backend reachable: true
```

---

## Getting Your API Key

1. Go to [app.syrin.ai](https://app.syrin.ai)
2. Sign in or create a free account
3. Navigate to **Settings > API Keys**
4. Click **Create Key**
5. Copy the `syrin_pk_...` value — it is only shown once

---

## Quick Reference: SDK Call to Dashboard Location

| SDK Call | Where it appears in the dashboard |
|----------|----------------------------------|
| `await init({ agentId: "x" })` | Creates agent "x" in the Agents list |
| `withSession(sessionId, ...)` | Creates session in the Sessions list |
| `agent.field("llm.temp", 0.7, { ge: 0, le: 2 })` | Adds a slider in Agents > x > Config |
| Any LLM call inside `withSession()` | Adds an `LLM_CALL` event to the session timeline |
| `sdk.emit("MY_EVENT", {...})` | Adds a labeled event to the session timeline |
| `sdk.sessions.rate(sessionId, "positive")` | Shows thumbs-up on the session row |
| `sdk.log("message", "warning", {...})` | Adds a `CUSTOM_LOG` event to the timeline |
| `sdk.checkpoint("label", {...})` | Adds a `CHECKPOINT` pin to the timeline |
| `GovernanceStopError` thrown | Creates an incident in Governance > Incidents |
| `captureContent: true` | Enables the Replay tab for each session |
| `agent.tools(["search", "fetch"])` | Adds toggleable tool switches under Agents > Config > Tools |
| `withAgent("researcher", ...)` | Adds `AGENT_RUN_STARTED` / `AGENT_RUN_ENDED` events |
| `withWorkflow("pipeline", ...)` | Adds `WORKFLOW_STARTED` / `WORKFLOW_ENDED` boundary markers |
