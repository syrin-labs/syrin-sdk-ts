---
title: "Quickstart"
description: "Add Syrin to a TypeScript AI agent in under 5 minutes. Full working example with expected output and dashboard walkthrough."
weight: 3
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

> **AI Agent Quick Reference** — The minimal correct pattern for a complete instrumented agent:
> ```typescript
> import OpenAI from "openai";
> import { init, withSession, shutdown } from "@syrin/sdk";
> const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });
> const openai = new OpenAI();
> await withSession(`u:alice:${new Date().toISOString().slice(0,10)}`, async () => {
>   const response = await openai.chat.completions.create({ model: "gpt-4o", messages: [...] });
> });
> await shutdown();
> ```
> Common mistakes: (1) missing `await` on `init()`; (2) constructing `new OpenAI()` before `await init()` — the `new` is fine, but any LLM call before `init()` resolves may not be patched; (3) using `sdk.cfg()` directly — use `sdk.agent("id").cfg("key", default)`.

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
import OpenAI from "openai";           // ← import OpenAI BEFORE init()
import { init, shutdown } from "@syrin/sdk";

// Always await init() — it patches OpenAI asynchronously
const sdk = await init({
  apiKey: "syrin_pk_...",       // your Syrin API key
  agentId: "travel-assistant",  // the name that appears in the dashboard
  captureContent: true,         // lets you see full conversations in the Replay tab
});

const openai = new OpenAI();
```

**What this does:** `await init()` wraps the OpenAI library so every `openai.chat.completions.create(...)` call you make is automatically recorded. The `agentId` is just a label — it appears as your agent's name in the dashboard.

**Why must you `await` it?** The SDK patches OpenAI asynchronously. If you call `openai.chat.completions.create(...)` before `init()` finishes, those calls are queued and replayed once `init()` resolves — but it is safer and clearer to always `await` before making any calls.

> ⚠️ **Use `const sdk = init(...)` without await and:** `sdk` is a `Promise<SyrinSDK>`, not a `SyrinSDK`. Calling `sdk.agent(...)` will throw `TypeError: sdk.agent is not a function`.

**Expected result after running this far:** The SDK registers your agent with Syrin. If you open [app.syrin.ai > Agents](https://app.syrin.ai), you will see `travel-assistant` appear with a green "LIVE" status indicator.

---

## Step 2 — Declare an Agent and Its Config Fields

An `AgentHandle` is your interface to a specific agent. Use it to declare which settings are configurable from the dashboard, and to read those settings at runtime.

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

**What this does:** Each `field()` call creates one control in the dashboard's Config panel. The key format is `"section.field"` — the section becomes an accordion group in the UI.

**Expected result:** Navigate to [app.syrin.ai > Agents > travel-assistant > Config](https://app.syrin.ai) and you will see three controls appear:

- Under **llm**: a dropdown for "LLM Model" and a slider for "Creativity" (range 0 to 2)
- Under **prompt**: a text area for "System Prompt"

---

## Step 3 — Open a Session for a User

A session groups all the LLM calls for one user's conversation:

```typescript
import { withSession } from "@syrin/sdk";

const today = new Date().toISOString().slice(0, 10); // "2026-04-27"

await withSession(`u:alice:${today}`, async () => {
  console.log("Session opened: u:alice:" + today);
  // All LLM calls inside here are tagged with this session ID
});
```

**What this does:** `withSession()` creates a session scope using `AsyncLocalStorage`. Every LLM call made inside the callback is tagged with `u:alice:2026-04-27`. The session ID is deterministic — the same user on the same day always gets the same session ID across all your server replicas.

**What you see in the dashboard:** Navigate to [app.syrin.ai > Sessions](https://app.syrin.ai) and you will see a new row for `u:alice:2026-04-27` under `travel-assistant`.

---

## Step 4 — Read Config Values and Make the LLM Call

Inside the session callback, read the current config values and use them in your LLM call:

```typescript
await withSession(`u:alice:${today}`, async () => {
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

**What `agent.cfg()` does:** Returns the current live value for this field. On first run, that is the default you provided. After you change the value in the dashboard, the next `agent.cfg()` call returns the new value.

**Expected console output:**
```
Using model: gpt-4o, temperature: 0.7
1. Visit the Tsukiji Outer Market for fresh sushi at sunrise.
2. Explore Shinjuku Gyoen — stunning in any season.
3. Take the Yamanote Line loop to discover neighborhoods at your own pace.
```

**What you see in the dashboard:** Go to [app.syrin.ai > Sessions](https://app.syrin.ai) and click the session. You will see an `LLM_CALL` event with the model name, token counts, cost, and latency. If `captureContent: true`, click the event to see the full conversation.

---

## Step 5 — Mark Important Events

Add labeled markers to the session timeline:

```typescript
sdk.emit("USER_REQUEST_PROCESSED", {
  intent: "travel-planning",
  destination: "Tokyo",
  responseLength: answer.length,
});
```

**What this does:** `emit()` adds a custom event to the session timeline. The first argument is the event name (any string), and the second is an object of metadata. When you review this session in the dashboard, you will see `USER_REQUEST_PROCESSED` as a labeled marker.

---

## Step 6 — Rate the Session

Tell Syrin whether this session went well:

```typescript
await sdk.sessions.rate(`u:alice:${today}`, "positive", { reason: "Detailed response" });
```

**What this does:** Marks the session with a thumbs-up. The Sessions list shows a feedback icon on each row, and the Agents page shows the percentage of positive sessions.

---

## The Complete Working Example

```typescript
import OpenAI from "openai";                              // ← LLM client first
import { init, withSession, shutdown } from "@syrin/sdk"; // ← SDK second

// Initialize Syrin — always await before any LLM calls
const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
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

const today = new Date().toISOString().slice(0, 10);

// Open a session for user "alice"
await withSession(`u:alice:${today}`, async () => {
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
});

// Rate the session
await sdk.sessions.rate(`u:alice:${today}`, "positive", { reason: "Completed successfully" });

console.log("Done — open https://app.syrin.ai to see the session.");
await shutdown();
```

**Expected console output:**
```
Using model: gpt-4o, temperature: 0.7
1. Visit the Tsukiji Outer Market for fresh sushi at sunrise.
2. Explore Shinjuku Gyoen — stunning in any season.
3. Take the Yamanote Line loop to discover neighborhoods at your own pace.
Done — open https://app.syrin.ai to see the session.
```

---

## ESM vs CJS

The SDK ships both ESM and CJS builds via `package.json` exports. Both work transparently:

**ESM (recommended for new projects):**
```typescript
import { init, withSession } from "@syrin/sdk";
```

**CommonJS:**
```javascript
const { init, withSession } = require("@syrin/sdk");

// init() is async — use an async wrapper
async function main() {
  const sdk = await init({ apiKey: process.env.SYRIN_API_KEY });
  // ...
}
main();
```

---

## Change a Config Value Without Redeploying

1. Open [app.syrin.ai > Agents > travel-assistant > Config](https://app.syrin.ai)
2. Find the **Creativity** slider and drag it from `0.7` to `1.2`
3. Click **Save Changes**
4. Run `travel-agent.ts` again

**New console output:**
```
Using model: gpt-4o, temperature: 1.2
```

The `agent.cfg("llm.temperature", 0.7)` call returned `1.2` because the backend sent the new value. Your code did not change.

---

## Handling Multiple Users Concurrently (Express Server)

If your agent serves many users at the same time, use `withSession` inside your request handler. Each user gets their own isolated session — concurrent requests never share state because `withSession` uses `AsyncLocalStorage`.

```typescript
import OpenAI from "openai";
import { init, withSession } from "@syrin/sdk";
import express from "express";

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  agentId: "travel-api",
  sessionTtlMs: 7_200_000, // evict sessions older than 2 hours
});

const openai = new OpenAI();
const agent  = sdk.agent("travel-api");
agent.field("llm.model", "gpt-4o").field("llm.temperature", 0.7, { ge: 0, le: 2 });

const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { userId, messages } = req.body;
  const today = new Date().toISOString().slice(0, 10);
  const sessionId = `u:${userId}:${today}`;

  const result = await withSession(sessionId, async () => {
    const model = agent.cfg("llm.model", "gpt-4o") as string;

    const response = await openai.chat.completions.create({ model, messages });

    return {
      sessionId,
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
- [withSession()](../sessions/with-session) — sessions in depth: custom IDs, windows, feedback
- [AgentHandle](../agents/agent-handle) — the right pattern for multi-agent systems with per-agent config
- [Governance](../control/governance) — automatic safety rules: stopping runaway agents, cost limits
