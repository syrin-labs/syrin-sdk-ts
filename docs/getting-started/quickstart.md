---
title: "Quickstart"
description: "A complete working example: Syrin init() + OpenAI, session context, remote config, and live traces in the dashboard."
weight: 3
---

## Zero to Observable in 90 Seconds

This page walks through a complete, runnable example that covers all the basics: initialization, session context, remote config via `cfg()`, and viewing the trace in the Syrin dashboard.

### Prerequisites

```bash
npm install @syrin/sdk openai
export SYRIN_API_KEY="syrin_pk_..."
export OPENAI_API_KEY="sk-..."
```

---

### The Complete Example

```typescript
import { init, withSession, shutdown } from "@syrin/sdk";
import OpenAI from "openai";

// ── 1. Initialize ─────────────────────────────────────────────────────────────
//
// init() validates your config early and returns the SDK handle.
// From this point on, all OpenAI calls made anywhere in this process
// are automatically instrumented — no changes to call sites needed.
//
// IMPORTANT: always await init(). Skipping it means the patch may not
// complete before your first call, and telemetry will be silently missed.

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",         // how this agent appears in the dashboard
  backendUrl: "https://app.syrin.ai",  // omit to use the default
  captureContent: true,                // include prompts/completions in traces
});

// ── 2. Create your normal OpenAI client ───────────────────────────────────────
//
// Nothing about the OpenAI client changes. Syrin wraps the underlying
// method at the library level — your baseURL, retries, and timeouts
// are all preserved unchanged.

const openai = new OpenAI();

// ── 3. Open a session for a user ──────────────────────────────────────────────
//
// withSession() sets the active session ID via AsyncLocalStorage.
// Every LLM call inside the callback is automatically grouped under
// this session in the dashboard. Concurrent calls from different users
// never cross-contaminate — each has its own AsyncLocalStorage context.

await withSession("u:alice:today", async () => {

  // ── 4. Use cfg() for remotely-configurable values ─────────────────────────
  //
  // agent.cfg(key, default) declares a field the dashboard can override.
  // The first time it is called, the field appears in the agent's config
  // panel. On subsequent runs, the live value from the backend is returned
  // instead of the default — no code change, no redeploy.

  const agent = sdk.agent("travel-assistant");

  const model = agent.cfg("llm.model", "gpt-4o");
  const temperature = agent.cfg("llm.temperature", 0.7);
  const systemPrompt = agent.cfg(
    "prompt.system",
    "You are a helpful travel assistant. Be concise and friendly."
  );

  // ── 5. Your LLM call — completely unchanged ───────────────────────────────
  const response = await openai.chat.completions.create({
    model,
    temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "What are the top 3 things to do in Tokyo?" },
    ],
  });

  const answer = response.choices[0].message.content!;
  console.log(answer);

  // ── 6. Emit custom lifecycle events ───────────────────────────────────────
  //
  // These appear on the session timeline in the dashboard.
  // Built-in event types get first-class rendering: GUARDRAIL_INPUT,
  // HANDOFF, BUDGET_ESTIMATION, CHECKPOINT, etc. Custom strings work too.
  sdk.emit("USER_REQUEST_PROCESSED", {
    user: "alice",
    intent: "travel-planning",
    response_length: answer.length,
  });

  // ── 7. Submit feedback (optional) ─────────────────────────────────────────
  //
  // Rate the session after evaluating the response quality.
  // Ratings appear on the session card in the dashboard and feed into
  // aggregate quality metrics per agent.
  const sessionId = "u:alice:today";
  if (answer.length > 100) {
    await sdk.sessions.rate(sessionId, "positive", { reason: "Detailed response" });
  } else {
    await sdk.sessions.rate(sessionId, "negative", { reason: "Response too short" });
  }
});

// Session ends when withSession's callback resolves.
// Events are batched and flushed automatically — no manual flush needed
// for normal operation.
```

Open [app.syrin.ai](https://app.syrin.ai), navigate to **Sessions**, and you'll see Alice's session with the full trace.

---

### What You'll See in the Dashboard

After running the example, the dashboard shows:

- **Session timeline** — `SESSION_STARTED`, `LLM_CALL`, `USER_REQUEST_PROCESSED`, `SESSION_ENDED` events in chronological order
- **LLM call details** — model, tokens, cost, latency, context utilization, and whether a config override was active
- **Config panel** — live controls for `llm.model`, `llm.temperature`, and `prompt.system` with their declared defaults
- **Feedback** — thumbs up/down indicator on the session card

---

### Changing Config from the Dashboard

While your agent is running (or between runs):

1. Go to **Agents → travel-assistant → Config**
2. Change `llm.temperature` from `0.7` to `1.2`
3. Run the script again — `agent.cfg("llm.temperature", 0.7)` returns `1.2`

No code change. No redeploy. The field appears in the dashboard the first time `cfg()` is called and persists across restarts in `.syrin/syrin.config.json`.

---

### Multi-User Pattern

For a server handling many concurrent users, each `withSession` call gets its own AsyncLocalStorage context — they do not interfere with each other:

```typescript
import { init, withSession } from "@syrin/sdk";
import OpenAI from "openai";
import express from "express";

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",
});

const openai = new OpenAI();
const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { userId, message } = req.body as { userId: string; message: string };

  // Each request gets its own session scope. Concurrent requests for
  // different users run in parallel without sharing state.
  await withSession(`user:${userId}:${new Date().toISOString().slice(0, 10)}`, async () => {
    const agent = sdk.agent("travel-assistant");
    const model = agent.cfg("llm.model", "gpt-4o");

    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: message }],
    });

    res.json({ reply: response.choices[0].message.content });
  });
});
```

Each `userId` gets its own session; calls from different users never cross-contaminate.

---

### Adding Governance

To let the backend stop a runaway agent:

```typescript
import { init, withSession, GovernanceStopError } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",
  // No extra option needed — governance is always active.
  // GovernanceStopError is raised when the backend sends a stop action.
});

const openai = new OpenAI();

try {
  await withSession("u:bob:today", async () => {
    // If the backend decides to stop this agent (cost overrun, loop
    // detected, manual stop from dashboard), GovernanceStopError is raised
    // on the next LLM call — not immediately when the signal arrives.
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Plan a world tour" }],
    });
    console.log(response.choices[0].message.content);
  });
} catch (err) {
  if (err instanceof GovernanceStopError) {
    console.error(`Agent stopped by backend: ${err.reason}`);
    // err.incidentId links to the incident in the dashboard
  } else {
    throw err;
  }
}
```

---

### Offline Mode (for tests)

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",
  offline: true, // no network calls — ideal for unit tests
});

// cfg() still returns defaults, withSession() still scopes calls,
// but no events are sent and no config is fetched from the backend.
```

---

### Clean Shutdown

In long-running servers, call `shutdown()` when the process exits to flush any buffered events:

```typescript
import { init, shutdown } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "travel-assistant" });

// Flush remaining events and stop background timers before the
// process exits. Without this, the last batch of events may be lost.
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
```

The SDK also registers its own `beforeExit` handler for short-lived scripts, so scripts that run to completion and exit normally will flush automatically. The explicit `process.on("SIGTERM")` handler is mainly for servers receiving OS-level signals.

---

### Next Steps

- [init() Reference](../init) — all parameters explained
- [Remote Config](../cfg) — `cfg()` in depth, `ConfigStore`, `tunable`
- [Sessions & Context](../sessions) — `withSession()`, `withAgent()`, `withWorkflow()`
- [Governance](../governance) — stop, inject, checkpoint, restore
