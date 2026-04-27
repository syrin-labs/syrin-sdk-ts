---
title: "Quickstart"
description: "Add Syrin to a TypeScript AI agent in under 5 minutes. Full working example with expected output and dashboard walkthrough."
weight: 3
---

## Add Monitoring to Your Agent in Under 5 Minutes

By the end of this guide you will have a TypeScript agent that:

1. Sends live session data and LLM call details to your Syrin dashboard
2. Has a config field you can change from the dashboard without redeploying your code
3. Appears as a named session in [app.syrin.ai > Sessions](https://app.syrin.ai)

---

## Before You Begin

Install the packages:

```bash
npm install @syrin/sdk openai
```

Set your API keys as environment variables:

```bash
export SYRIN_API_KEY="syrin_pk_..."   # get this from app.syrin.ai > Settings > API Keys
export OPENAI_API_KEY="sk-..."        # your OpenAI key
```

**Don't have a Syrin API key yet?** Go to [app.syrin.ai](https://app.syrin.ai), create a free account, then go to **Settings > API Keys > Create Key**. Copy the key — it is shown only once.

---

## Step 1 — Initialize Syrin

Create a file called `travel-agent.ts`. The very first thing you must do is `await init()`:

```typescript
import { init, shutdown } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({
  apiKey: "syrin_pk_...",       // your Syrin API key
  agentId: "travel-assistant",  // the name that appears in the dashboard
  captureContent: true,         // lets you see full conversations in the Replay tab
});

const openai = new OpenAI();
```

**What this does:** `await init()` wraps the OpenAI library so that every `openai.chat.completions.create(...)` call you make is automatically recorded. The `agentId` is just a label — it appears as your agent's name in the dashboard. Nothing about how OpenAI behaves changes.

**Why must you `await` it?** The SDK patches OpenAI asynchronously. If you call `openai.chat.completions.create(...)` before `init()` finishes, the call won't be captured. Always `await init()` before any LLM calls.

**Expected result after running this far:** The SDK registers your agent with Syrin and starts a background heartbeat. If you open [app.syrin.ai > Agents](https://app.syrin.ai), you will see `travel-assistant` appear with a green "LIVE" status indicator.

---

## Step 2 — Declare an Agent and Its Config Fields

An `AgentHandle` is your interface to a specific agent. You use it to declare which settings are configurable from the dashboard, and to read those settings at runtime.

```typescript
const agent = sdk.agent("travel-assistant");

agent
  .field("llm.model", "gpt-4o", {
    enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    label: "LLM Model",
  })
  .field("llm.temperature", 0.7, { ge: 0, le: 2, label: "Creativity" })
  .field("prompt.systemPrompt",
    "You are a helpful travel assistant. Be concise and friendly.",
    { multiline: true, label: "System Prompt" }
  );
```

**What this does:** Each `field()` call creates one control in the dashboard's Config panel. The first argument is the key name (the part before the dot is the section — so `llm.temperature` goes under the "llm" section). The second argument is the default value used on first run. The options control how the control renders: `enum` makes a dropdown, `ge`/`le` makes a slider, `multiline` makes a text area.

**Expected result:** Navigate to [app.syrin.ai > Agents > travel-assistant > Config](https://app.syrin.ai) and you will see three controls appear:

- Under the **llm** section: a dropdown for "LLM Model" and a slider for "Creativity" (range 0 to 2)
- Under the **prompt** section: a text area for "System Prompt"

---

## Step 3 — Open a Session for a User

A session groups all the LLM calls for one user's conversation. Without a session, your calls show up as disconnected events.

```typescript
await sdk.withSession({ userId: "alice", window: "day" }, async (ctx) => {
  console.log(`Session ID: ${ctx.sessionId}`);
  // → Session ID: u:alice:2026-04-27
});
```

**What this does:** `withSession()` creates a session scoped to user `"alice"` for the current day. Every LLM call made inside the callback function is tagged with this session ID. The `window: "day"` means the session resets each day — if Alice comes back tomorrow, she gets a fresh session. The session ID is deterministic: `u:alice:2026-04-27` is always the same for the same user on the same day.

**Expected console output:**
```
Session ID: u:alice:2026-04-27
```

**What you see in the dashboard:** Navigate to [app.syrin.ai > Sessions](https://app.syrin.ai) and you will see a new row for `u:alice:2026-04-27` under `travel-assistant`. It updates in real time.

---

## Step 4 — Read Config Values and Make the LLM Call

Inside the session callback, read the current config values and use them in your LLM call:

```typescript
await sdk.withSession({ userId: "alice", window: "day" }, async (ctx) => {
  console.log(`Session ID: ${ctx.sessionId}`);

  // Read current config values (returns default on first run, dashboard value thereafter)
  const model        = agent.cfg("llm.model", "gpt-4o") as string;
  const temperature  = agent.cfg("llm.temperature", 0.7) as number;
  const systemPrompt = agent.cfg("prompt.systemPrompt",
    "You are a helpful travel assistant. Be concise and friendly.") as string;

  console.log(`Using model: ${model}, temperature: ${temperature}`);

  // Your LLM call — completely unchanged
  const response = await openai.chat.completions.create({
    model,
    temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: "What are the top 3 things to do in Tokyo?" },
    ],
  });

  const answer = response.choices[0].message.content!;
  console.log(answer);
});
```

**What `agent.cfg()` does:** It returns the current value for this field. On the first run, that is the default you provided (`"gpt-4o"`, `0.7`, etc.). After you change the value in the dashboard, the next call to `agent.cfg()` returns the new value from the backend — no code change needed.

**Expected console output:**
```
Session ID: u:alice:2026-04-27
Using model: gpt-4o, temperature: 0.7
1. Visit the Tsukiji Outer Market for fresh sushi at sunrise.
2. Explore Shinjuku Gyoen — stunning in any season.
3. Take the Yamanote Line loop to discover neighborhoods at your own pace.
```

**What you see in the dashboard:** Go to [app.syrin.ai > Sessions](https://app.syrin.ai) and click the `u:alice:2026-04-27` session. You will see an `LLM_CALL` event with the model name, token counts, cost, and latency. If `captureContent: true`, click the event to see the full conversation.

---

## Step 5 — Mark Important Events

You can add labeled markers to the session timeline to record what your agent was doing at each point.

```typescript
  sdk.emit("USER_REQUEST_PROCESSED", {
    intent: "travel-planning",
    destination: "Tokyo",
    responseLength: answer.length,
  });
```

**What this does:** `emit()` adds a custom event to the session timeline in the dashboard. The first argument is the event name (any string you choose), and the second is an object of metadata. When you review this session later, you will see `USER_REQUEST_PROCESSED` as a labeled marker with the data you passed.

This is useful when your agent makes multiple LLM calls in sequence and you want to mark which call corresponded to which step.

---

## Step 6 — Rate the Session

Tell Syrin whether this session went well. This feeds the quality metrics shown per agent in the dashboard.

```typescript
  if (answer.length > 100) {
    ctx.feedback.positive({ reason: "Detailed response" });
  } else {
    ctx.feedback.negative({ reason: "Response too short" });
  }
```

**What this does:** Feedback marks the session with a thumbs-up or thumbs-down. The Sessions list shows a feedback icon on each row, and the Agents page shows the percentage of positive sessions for each agent.

---

## The Complete Working Example

```typescript
import { init, shutdown } from "@syrin/sdk";
import OpenAI from "openai";

// Initialize Syrin — always await before any LLM calls
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",
  captureContent: true,
});

const openai = new OpenAI();

// Declare config fields (appear as controls in the dashboard)
const agent = sdk.agent("travel-assistant");
agent
  .field("llm.model", "gpt-4o", {
    enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    label: "LLM Model",
  })
  .field("llm.temperature", 0.7, { ge: 0, le: 2, label: "Creativity" })
  .field("prompt.systemPrompt",
    "You are a helpful travel assistant. Be concise and friendly.",
    { multiline: true, label: "System Prompt" }
  );

// Open a session for user "alice"
await sdk.withSession({ userId: "alice", window: "day" }, async (ctx) => {
  console.log(`Session ID: ${ctx.sessionId}`);

  const model        = agent.cfg("llm.model", "gpt-4o") as string;
  const temperature  = agent.cfg("llm.temperature", 0.7) as number;
  const systemPrompt = agent.cfg("prompt.systemPrompt",
    "You are a helpful travel assistant. Be concise and friendly.") as string;

  console.log(`Using model: ${model}, temperature: ${temperature}`);

  // Your LLM call — unchanged
  const response = await openai.chat.completions.create({
    model,
    temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: "What are the top 3 things to do in Tokyo?" },
    ],
  });

  const answer = response.choices[0].message.content!;
  console.log(answer);

  // Add a marker to the session timeline
  sdk.emit("USER_REQUEST_PROCESSED", {
    intent: "travel-planning",
    destination: "Tokyo",
  });

  // Rate the session
  ctx.feedback.positive({ reason: "Detailed response" });
});

console.log("Done — open https://app.syrin.ai to see the session.");
await shutdown();
```

**Expected console output:**
```
Session ID: u:alice:2026-04-27
Using model: gpt-4o, temperature: 0.7
1. Visit the Tsukiji Outer Market for fresh sushi at sunrise.
2. Explore Shinjuku Gyoen — stunning in any season.
3. Take the Yamanote Line loop to discover neighborhoods at your own pace.
Done — open https://app.syrin.ai to see the session.
```

---

## Change a Config Value Without Redeploying

1. Open [app.syrin.ai > Agents > travel-assistant > Config](https://app.syrin.ai)
2. Find the **Creativity** slider and drag it from `0.7` to `1.2`
3. Click **Save Changes**
4. Run `travel-agent.ts` again

**New console output:**
```
Session ID: u:alice:2026-04-27
Using model: gpt-4o, temperature: 1.2
```

The `agent.cfg("llm.temperature", 0.7)` call returned `1.2` because the backend sent the new value. Your code did not change.

---

## Handling Multiple Users Concurrently (Express Server)

If your agent serves many users at the same time, use `withSession` inside your request handler. Each user gets their own isolated session — concurrent requests never share state.

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";
import express from "express";

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  agentId: "travel-api",
});

const openai = new OpenAI();
const agent  = sdk.agent("travel-api");
agent.field("llm.model", "gpt-4o").field("llm.temperature", 0.7, { ge: 0, le: 2 });

const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { userId, messages } = req.body;

  const result = await sdk.withSession({ userId, window: "day" }, async (ctx) => {
    const model = agent.cfg("llm.model", "gpt-4o") as string;

    const response = await openai.chat.completions.create({ model, messages });

    return {
      sessionId: ctx.sessionId,
      content: response.choices[0].message.content,
    };
  });

  res.json(result);
});

app.listen(3000, () => console.log("Server running on port 3000"));
```

**Example response your server returns:**
```json
{
  "sessionId": "u:alice:2026-04-27",
  "content": "The best time to visit Tokyo is March-April for cherry blossoms."
}
```

After multiple requests, [app.syrin.ai > Sessions](https://app.syrin.ai) shows one row per user — each with their own independent timeline and cost.

---

## What to Do Next

- [Dashboard Guide](./dashboard-guide) — a full walkthrough of every section at app.syrin.ai
- [init() Reference](../initialization/init) — all parameters for `init()` explained
- [Remote Config](../configuration/cfg) — more about `field()`, `cfg()`, and agent-scoped config
- [Sessions](../sessions/with-session) — sessions in depth: custom IDs, windows, feedback
- [AgentHandle](../agents/agent-handle) — the right pattern for multi-agent systems with per-agent config
- [Governance](../control/governance) — automatic safety rules: stopping runaway agents, cost limits
