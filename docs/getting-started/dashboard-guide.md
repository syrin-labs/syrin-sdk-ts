---
title: "Dashboard Guide"
description: "A complete tour of app.syrin.ai — Sessions, Agents, Config, Governance, Costs, and Session Replay."
weight: 4
---

## Everything Visible at app.syrin.ai

The Syrin dashboard at **[app.syrin.ai](https://app.syrin.ai)** is your primary interface for operating AI agents in production. This page explains every section of the dashboard, what data flows into it from the SDK, and how to act on what you see.

> **Tip:** Keep [app.syrin.ai](https://app.syrin.ai) open in a browser tab while you run your agents. Events appear in real time as your code executes.

---

## Sessions

**Where:** [app.syrin.ai → Sessions](https://app.syrin.ai)

Every call to `sdk.withSession({ userId: ... })` creates or resumes a session. All LLM calls, lifecycle events, and feedback signals inside the callback appear on that session's timeline.

### What You See

```
Sessions                                      Filter: last 24h  |  agent: all  |  status: all

  u:alice:2026-04-27   travel-assistant   👍  $0.005   3 calls   1.2s avg   14:32:01
  u:bob:2026-04-27     travel-assistant       $0.021   8 calls   1.8s avg   14:28:44
  ses_order_12345      order-assistant    👎  $0.003   2 calls   0.9s avg   14:15:30
  u:carol:2026-04-27   travel-assistant       $0.009   4 calls   1.4s avg   14:01:12
```

Each row shows:
- **Session ID** — from `userId + window` or explicit `sessionId`
- **Agent** — the `agentId` active during the session
- **Feedback** — 👍 positive / 👎 negative / blank = none submitted
- **Cost** — total `cost_usd` across all LLM calls in the session
- **Calls** — total LLM call count
- **Avg latency** — mean `duration_ms`
- **Time** — when the session started

### Session Timeline

Click any session row to expand the timeline:

```
Session: u:alice:2026-04-27                                   [👍 Detailed response]

  ● SESSION_STARTED              14:32:00.001
      userId=alice  window=day  agentId=travel-assistant

  ● LLM_CALL                     14:32:01.241    ▶ expand
      model: gpt-4o              duration: 1240ms    cost: $0.005
      inputTokens: 342           outputTokens: 187   configApplied: ✓
      stream: false              contextUtilization: 0.21

  ● USER_REQUEST_PROCESSED       14:32:01.250
      intent=travel-planning  destination=Tokyo  responseLength=312

  ● SESSION_ENDED                14:32:01.252
      duration: 1.251s  totalCost: $0.005  totalCalls: 1
```

**Expanding LLM_CALL** (when `captureContent: true`) shows:
```
  Messages sent:
    [system] You are a helpful travel assistant. Be concise and friendly.
    [user]   What are the top 3 things to do in Tokyo?

  Response:
    [assistant] 1. Visit the Tsukiji Outer Market...
```

### Session Filtering

Filter by:
- **Time range** — last hour, 24h, 7d, 30d, or custom
- **Agent** — any registered `agentId`
- **Status** — all, with errors, with feedback, crashed
- **User** — search by `userId`
- **Session ID** — direct lookup

---

## Agents

**Where:** [app.syrin.ai → Agents](https://app.syrin.ai)

Every `agentId` you pass to `init()` or `sdk.agent()` creates an agent entry. The Agents page shows aggregate metrics across all sessions for each agent.

### Agent Overview

```
Agents

  travel-assistant     42 sessions   $0.87 total   3.2 calls/session   👍 87%
  order-assistant      18 sessions   $0.31 total   2.1 calls/session   👍 72%
  researcher-agent      7 sessions   $0.14 total   5.8 calls/session
```

### Agent Detail Page

Click an agent to see:

1. **Config panel** — all `field()` / `cfg()` fields registered for this agent (see below)
2. **Session history** — all sessions for this agent
3. **Cost trend** — daily cost chart
4. **Model usage** — breakdown of which models were called
5. **Latency P50/P95/P99** — by model

---

## Config Panel

**Where:** [app.syrin.ai → Agents → {agent-name} → Config](https://app.syrin.ai)

Every `agent.field("section.key", default, opts)` or `agent.cfg("section.key", default)` call registers a field in this panel. You can change any value here and the agent picks it up on its next call — **no redeploy needed**.

### Field Types and How They Render

Depending on the options you pass to `field()`, the dashboard renders different controls:

#### Slider (numeric with `ge` and `le`)

```typescript
agent.field("llm.temperature", 0.7, { ge: 0, le: 2, label: "Creativity" });
```

```
Creativity     ────●──────   0.7          (0.0 — 2.0)
```

#### Dropdown (string with `enum`)

```typescript
agent.field("llm.model", "gpt-4o", { enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"] });
```

```
LLM Model      [gpt-4o ▾]   gpt-4o | gpt-4o-mini | gpt-4-turbo
```

#### Textarea (string with `multiline: true`)

```typescript
agent.field("prompt.systemPrompt", "You are an assistant.", { multiline: true, label: "System Prompt" });
```

```
System Prompt  ┌──────────────────────────────────────┐
               │ You are an assistant.                │
               │                                      │
               └──────────────────────────────────────┘
```

#### Toggle (boolean)

```typescript
agent.field("retrieval.rerankerEnabled", false, { label: "Enable Reranker" });
```

```
Enable Reranker    ○ OFF
```

#### Number Input (numeric without bounds)

```typescript
agent.field("llm.maxTokens", 1000, { ge: 1, label: "Max Tokens" });
```

```
Max Tokens     [  1000  ]   min: 1
```

### Saving a Config Change

1. Adjust the slider, dropdown, textarea, or toggle
2. Click **Save Changes**
3. The new value is pushed to the backend
4. On the agent's next `agent.cfg()` call, it returns the new value

The dashboard shows a confirmation toast:
```
✓ Config saved — travel-assistant.llm.temperature: 0.7 → 1.2
```

### Config Sections

Fields are grouped by their `section` prefix. The `llm` section expands to show all `llm.*` fields together:

```
╠══ llm ══════════════════════════════════════════╣
║  model        [gpt-4o ▾]
║  temperature  ──●────────  0.7
║  maxTokens    [  1000  ]
╠══ prompt ═══════════════════════════════════════╣
║  systemPrompt   ┌──────────────────────────┐
║                 │ You are an assistant.    │
║                 └──────────────────────────┘
╠══ retrieval ════════════════════════════════════╣
║  topK            [  5  ]   (1 — 50)
║  rerankerEnabled   ○ OFF
```

### Per-Agent Config Isolation

When `sdk.agent("researcher").cfg(...)` is called, the field is registered under `agents.researcher.*`. Each agent gets its own independent config section — changing `researcher`'s temperature does not affect `writer`'s temperature.

---

## Governance

**Where:** [app.syrin.ai → Governance](https://app.syrin.ai)

The Governance panel shows:

### Policy Overview

```
Agent: travel-assistant

  Governance Policy
    allow_stop:           ✓ enabled
    allow_inject_message: ✗ disabled
    allow_config_updates: ✓ enabled
    allow_checkpoint:     ✓ enabled
    allow_restore:        ✗ disabled
```

### Incidents

When governance actions fire, they create incident records:

```
Incidents                                               last 24h

  inc_7f3a2b   LOOP_DETECTED     travel-assistant   alice   14:45:22   stopped
  inc_4e1d9c   COST_LIMIT         order-assistant   bob    13:12:01   alerted
  inc_2a8f5e   DRIFT_DETECTED    travel-assistant   carol  11:30:44   injected
```

Click an incident to see:
- The session timeline at the moment the action fired
- The reason string (e.g., `"Loop detected — 12 identical conversation hashes"`)
- Drift score history
- Which governance action was taken

### Loop Detection

The backend tracks `conversationHash` across calls. When the same hash appears multiple times in a short window, a loop is detected:

```
Loop Detection: alice's session (14:45:10 — 14:45:22)

  call 1  hash=a1b2  ●
  call 2  hash=a1b2  ●  ← repeat
  call 3  hash=a1b2  ●  ← repeat
  ...
  call 12 hash=a1b2  ●  ← LOOP_DETECTED → GovernanceStopError thrown
```

---

## Cost & Token Analytics

**Where:** [app.syrin.ai → Analytics](https://app.syrin.ai)

### Daily Cost Chart

```
Cost (USD)

  $0.50 ┤                                   ██
  $0.40 ┤                              ██   ██
  $0.30 ┤                         ██   ██   ██
  $0.20 ┤              ██    ██   ██   ██   ██
  $0.10 ┤    ██   ██   ██    ██   ██   ██   ██
        └────────────────────────────────────────
          Apr 21  22   23    24   25   26   27
```

### Breakdown by Model

```
Model Costs — last 7 days

  gpt-4o         $1.87   ████████████████████  73%
  gpt-4o-mini    $0.51   ██████                20%
  gpt-4-turbo    $0.18   ██                     7%
```

### Breakdown by Agent

```
Agent Costs — last 7 days

  researcher-agent   $1.24   ██████████████  48%
  writer-agent       $0.89   ██████████      35%
  travel-assistant   $0.43   █████           17%
```

---

## Session Replay

**Where:** [app.syrin.ai → Sessions → {session} → Replay](https://app.syrin.ai)

When `captureContent: true`, the Replay tab shows the full conversation:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",
  captureContent: true,           // enables session replay
});
```

The replay shows each turn in order, with timestamps, token counts, and cost per turn:

```
Session Replay: u:alice:2026-04-27

  [system]     You are a helpful travel assistant...
  [user]       What are the top 3 things to do in Tokyo?
               ──── LLM call: gpt-4o  342→187 tokens  $0.005  1240ms ────
  [assistant]  1. Visit the Tsukiji Outer Market...

  [user]       How many days should I plan for?
               ──── LLM call: gpt-4o  529→142 tokens  $0.007  890ms ────
  [assistant]  I'd recommend at least 5 days for Tokyo...
```

> **Privacy note:** Content capture is off by default. Enable it only for agents where you've confirmed no PII flows through the prompts, or where you have appropriate data handling policies in place.

---

## Config Audit Log

**Where:** [app.syrin.ai → Agents → {agent} → Audit Log](https://app.syrin.ai)

Every config change is recorded:

```
Config Audit Log: travel-assistant

  2026-04-27 14:52:01   llm.temperature    0.7 → 1.2    source: dashboard  user: you
  2026-04-27 13:01:44   llm.model          gpt-4o-mini → gpt-4o  source: governance
  2026-04-26 09:15:22   prompt.systemPrompt   [changed]  source: dashboard  user: you
```

---

## Health Check / SDK Connectivity

**Where:** [app.syrin.ai → Settings → Agents](https://app.syrin.ai)

```
Agents

  travel-assistant    ● LIVE    last heartbeat: 3s ago    v0.1.0 (typescript)
  order-assistant     ○ IDLE    last heartbeat: 4m ago    v0.1.0 (typescript)
```

Check connectivity programmatically:

```typescript
const sdk = await init({ apiKey: "syrin_pk_...", agentId: "travel-assistant" });
const ok = await sdk.healthCheck();
console.log(`Backend reachable: ${ok}`);  // → Backend reachable: true
```

---

## Getting Your API Key

1. Go to [app.syrin.ai](https://app.syrin.ai)
2. Sign in or create a free account
3. Navigate to **Settings → API Keys**
4. Click **Create Key** — copy the `syrin_pk_...` value immediately (shown only once)
5. Set it as `SYRIN_API_KEY` or pass it to `init({ apiKey: ... })`

---

## Summary: What Each SDK Action Does in the Dashboard

| SDK Action | Dashboard Result |
|-----------|-----------------|
| `await init({ agentId: "x" })` | Creates agent `x` in Agents page |
| `sdk.withSession({ userId: "alice" })` | Creates/resumes session in Sessions page |
| `agent.field("llm.temp", 0.7, { ge:0, le:2 })` | Registers slider in Agents → x → Config |
| `agent.cfg("llm.temp", 0.7)` | Registers control if not already present |
| Any LLM call inside `withSession()` | Adds `LLM_CALL` event to session timeline |
| `sdk.emit("HANDOFF", {...})` | Adds `HANDOFF` event to session timeline |
| `ctx.feedback.positive()` | Sets 👍 on session card |
| `GovernanceStopError` thrown | Creates incident in Governance → Incidents |
| `captureContent: true` | Enables Replay tab on each session |

**Visit [app.syrin.ai](https://app.syrin.ai) after every run — the dashboard is where your agent's story unfolds.**
