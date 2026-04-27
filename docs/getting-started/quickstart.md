---
title: "Quickstart"
description: "A complete working example: init(), withSession(), remote config, and a full dashboard walkthrough — from zero to observable in under 5 minutes."
weight: 3
---

## Zero to Observable in Under 5 Minutes

This guide walks through a complete, runnable example. By the end you will have:

1. An instrumented agent sending live telemetry
2. A session visible at [app.syrin.ai](https://app.syrin.ai)
3. A config field you can change from the dashboard without redeploying

---

### Prerequisites

```bash
npm install @syrin/sdk openai
export SYRIN_API_KEY="syrin_pk_..."   # from app.syrin.ai → Settings → API Keys
export OPENAI_API_KEY="sk-..."
```

Don't have an API key yet? [Sign up at app.syrin.ai](https://app.syrin.ai) — it takes 60 seconds.

---

### The Complete Example

Save this as `travel-agent.ts` and run it with `npx tsx travel-agent.ts`:

```typescript
import { init, shutdown } from "@syrin/sdk";
import OpenAI from "openai";

// ── 1. Initialize ─────────────────────────────────────────────────────────────
//
// Always await init(). It patches OpenAI's prototype asynchronously.
// Skipping await means the first LLM call may not be instrumented.

const sdk = await init({
  apiKey: "syrin_pk_...",          // or set SYRIN_API_KEY env var
  agentId: "travel-assistant",     // appears as the agent name in the dashboard
  captureContent: true,            // include prompts/completions in session replay
});

// ── 2. Create your OpenAI client — nothing changes ───────────────────────────

const openai = new OpenAI();

// ── 3. Get an AgentHandle and declare config fields ──────────────────────────
//
// field() registers the field in the dashboard config panel immediately
// (before any LLM calls). It returns `this` for chaining.

const agent = sdk.agent("travel-assistant");
agent
  .field("llm.model",       "gpt-4o", { enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"], label: "LLM Model" })
  .field("llm.temperature", 0.7,      { ge: 0, le: 2, label: "Creativity" })
  .field("prompt.systemPrompt", "You are a helpful travel assistant. Be concise and friendly.", { multiline: true });

// ── 4. Open a session for a user ──────────────────────────────────────────────
//
// withSession() sets the session ID via AsyncLocalStorage.
// Every LLM call inside the callback is grouped under this session at app.syrin.ai.
// The callback is async-safe: concurrent calls for different users never cross-contaminate.

await sdk.withSession({ userId: "alice", window: "day" }, async (ctx) => {
  console.log(`Session: ${ctx.sessionId}`);
  // → Session: u:alice:2026-04-27

  // ── 5. Read live config values with cfg() ─────────────────────────────────
  //
  // cfg(key, default) returns the live value from the backend if one exists,
  // otherwise the default you provided. The first call registers the field.

  const model        = agent.cfg("llm.model",       "gpt-4o") as string;
  const temperature  = agent.cfg("llm.temperature", 0.7)      as number;
  const systemPrompt = agent.cfg("prompt.systemPrompt",
    "You are a helpful travel assistant. Be concise and friendly.") as string;

  console.log(`Model: ${model}, Temperature: ${temperature}`);
  // → Model: gpt-4o, Temperature: 0.7

  // ── 6. Your LLM call — completely unchanged ───────────────────────────────
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
  // → 1. Visit the Tsukiji Outer Market for fresh sushi at sunrise.
  //   2. Explore Shinjuku Gyoen — stunning in any season.
  //   3. Take the Yamanote Line loop to discover neighborhoods at your own pace.

  // ── 7. Emit custom lifecycle events ───────────────────────────────────────
  //
  // These appear as labelled markers on the session timeline in the dashboard.
  sdk.emit("USER_REQUEST_PROCESSED", {
    intent: "travel-planning",
    destination: "Tokyo",
    responseLength: answer.length,
  });

  // ── 8. Submit feedback on the session ─────────────────────────────────────
  //
  // Ratings appear on the session card and feed aggregate quality metrics per agent.
  if (answer.length > 100) {
    ctx.feedback.positive({ reason: "Detailed response" });
  } else {
    ctx.feedback.negative({ reason: "Response too short" });
  }
});

console.log("Done. Open https://app.syrin.ai to see the session.");
// → Done. Open https://app.syrin.ai to see the session.

await shutdown();
```

**Expected console output:**
```
Session: u:alice:2026-04-27
Model: gpt-4o, Temperature: 0.7
1. Visit the Tsukiji Outer Market for fresh sushi at sunrise.
2. Explore Shinjuku Gyoen — stunning in any season.
3. Take the Yamanote Line loop to discover neighborhoods at your own pace.
Done. Open https://app.syrin.ai to see the session.
```

---

### What You'll See in the Dashboard

Open [app.syrin.ai](https://app.syrin.ai) and navigate to **Sessions**. You'll see Alice's session with a timeline that looks like this:

```
Session: u:alice:2026-04-27            [👍 positive]   Cost: $0.005   Tokens: 529

  ● SESSION_STARTED              14:32:00.001   userId=alice  window=day
  ● LLM_CALL                     14:32:01.241   gpt-4o  in=342 out=187  $0.005  1240ms
      model: gpt-4o  temperature: 0.7  configApplied: true
  ● USER_REQUEST_PROCESSED       14:32:01.250   intent=travel-planning  destination=Tokyo
  ● SESSION_ENDED                14:32:01.252
```

Click any event to expand it. The `LLM_CALL` event shows:
- Full token counts, cost, and latency
- Which config values were in effect (`configApplied: true`)
- The full conversation (because `captureContent: true`)

---

### The Config Panel at app.syrin.ai

Navigate to **Agents → travel-assistant → Config**. You'll see three controls registered by the `field()` calls above:

```
╔══ LLM ═════════════════════════════════════════════════════╗
║  LLM Model      [gpt-4o ▾]  gpt-4o | gpt-4o-mini | gpt-4-turbo
║  Creativity     ──●───────  0.7   (0.0 — 2.0)
╠══ Prompt ══════════════════════════════════════════════════╣
║  systemPrompt   ╔══════════════════════════════════════╗   ║
║                 ║ You are a helpful travel assistant.  ║   ║
║                 ║ Be concise and friendly.             ║   ║
║                 ╚══════════════════════════════════════╝   ║
╚════════════════════════════════════════════════════════════╝
```

---

### Change Config Without Redeploying

1. In the dashboard, go to **Agents → travel-assistant → Config**
2. Drag the **Creativity** slider from `0.7` to `1.2` and click **Save**
3. Run `travel-agent.ts` again

**New output:**
```
Session: u:alice:2026-04-27
Model: gpt-4o, Temperature: 1.2      ← updated from dashboard, no redeploy
...
```

The `agent.cfg("llm.temperature", 0.7)` call now returns `1.2`. No code change, no redeploy.

---

### Express Server Pattern

For a server handling many concurrent users:

```typescript
import { init, shutdown } from "@syrin/sdk";
import OpenAI from "openai";
import express from "express";

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  agentId: "travel-api",
});

const openai = new OpenAI();
const agent  = sdk.agent("travel-api");
agent
  .field("llm.model", "gpt-4o")
  .field("llm.temperature", 0.7, { ge: 0, le: 2 });

const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { userId, messages } = req.body;

  // Each userId gets its own session scope.
  // Concurrent requests for different users run in parallel without sharing state.
  const result = await sdk.withSession({ userId, window: "day" }, async (ctx) => {
    const model = agent.cfg("llm.model", "gpt-4o") as string;

    const response = await openai.chat.completions.create({
      model,
      messages,
    });

    return {
      sessionId: ctx.sessionId,
      content: response.choices[0].message.content,
    };
  });

  res.json(result);
});

// Example response:
// { "sessionId": "u:alice:2026-04-27", "content": "The best time to visit Tokyo is..." }
```

Each `userId` gets its own session at [app.syrin.ai](https://app.syrin.ai) — separate rows in the Sessions view with their own timelines and costs.

---

### Adding Governance: Let the Backend Stop Runaway Agents

```typescript
import { init, GovernanceStopError } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",
  // governance is always active — GovernanceStopError is thrown
  // when the backend sends a stop action.
});

const openai = new OpenAI();

try {
  await sdk.withSession({ userId: "bob", window: "day" }, async () => {
    for (let i = 0; i < 100; i++) {   // a runaway loop
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Keep going..." }],
      });
      // When the backend detects the loop, GovernanceStopError is thrown
      // on the NEXT call.
    }
  });
} catch (err) {
  if (err instanceof GovernanceStopError) {
    console.error(`Stopped: ${err.reason}`);
    console.error(`Incident: ${err.incidentId}`);
    // → Stopped: Loop detected — 12 identical conversation hashes in 30 seconds
    // → Incident: inc_7f3a2b...
    // Visit app.syrin.ai → Governance → Incidents to see the full report
  } else {
    throw err;
  }
}
```

---

### Offline Mode (for unit tests)

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",
  offline: true,   // no network calls — ideal for CI
});

// cfg() returns defaults, withSession() still scopes calls,
// but nothing is sent to the backend and no config is fetched.
const model = agent.cfg("llm.model", "gpt-4o");
console.log(model);  // → "gpt-4o"
```

---

### Clean Shutdown

In servers that receive OS signals, flush buffered events explicitly:

```typescript
import { init, shutdown } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "travel-assistant" });

process.on("SIGTERM", async () => {
  await shutdown();   // flush remaining events
  process.exit(0);
});

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

// Short-lived scripts flush automatically via a `beforeExit` handler —
// no explicit shutdown needed for scripts that run to completion.
```

---

### Next Steps

- [Dashboard Guide](./dashboard-guide) — a full tour of app.syrin.ai: sessions, config, governance, cost
- [init() Reference](../initialization/init) — all parameters explained
- [Remote Config](../configuration/cfg) — `cfg()` in depth, field types, agent scoping
- [Sessions](../sessions/with-session) — `withSession()`, `withAgent()`, `withWorkflow()`
- [AgentHandle](../agents/agent-handle) — `field()`, `cfg()`, multi-agent patterns
- [Governance](../control/governance) — stop, inject, checkpoint, restore
