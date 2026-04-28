---
title: "Governance"
description: "Backend-driven controls that can stop or redirect your agent — configured via the governance option in init()."
weight: 60
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
- GovernanceStopError does NOT extend SyrinError — it extends Error directly
- GovernanceStopError is NOT thrown by default — requires allowStop: true
- GovernanceStopError is thrown on the NEXT LLM call after receiving the stop action
- allowStop defaults to false — the agent cannot be stopped without explicit opt-in
- allowInjectMessage defaults to false — requires explicit opt-in
- Config updates and checkpoints are ALWAYS permitted — no opt-in needed
-->

> **AI Agent Quick Reference** — Enable governance stop and handle it:
> ```typescript
> const sdk = await init({
>   apiKey: "syrin_pk_...",
>   governance: { allowStop: true },   // ← explicit opt-in required
> });
> try {
>   while (true) {
>     const resp = await client.chat.completions.create({ ... });
>     // ...
>   }
> } catch (err) {
>   if (err instanceof GovernanceStopError) {
>     console.error(`Stopped: ${err.reason}`);
>   }
> }
> ```
> Common mistakes: (1) expecting `GovernanceStopError` without setting `allowStop: true` — it is never thrown without explicit opt-in; (2) trying `catch (err instanceof SyrinError)` — `GovernanceStopError` extends `Error`, not `SyrinError`; (3) expecting the stop on the same LLM call that triggered the flush — it's thrown on the NEXT call.

## The Kill Switch You Never Want to Use (But Definitely Want to Have)

Your agent has been running for 20 minutes, spending $4 on a task that should cost $0.10. The backend's loop detector sees the conversation hash repeating. Without governance, there's nothing to stop it.

Governance lets the Syrin backend take action at runtime — stopping a runaway loop, injecting a corrective message, triggering a checkpoint before a risky operation. All disruptive actions require your explicit opt-in.

Every governance action creates an **incident** visible at [app.syrin.ai → Governance → Incidents](https://app.syrin.ai) with the full session replay, loop trace, cost at time of stop, and the exact reason string.

---

## How It Works

After each LLM call, the SDK flushes events to the backend. The backend's governance engine analyses the session (cost, loop detection, drift score, policy rules) and may include governance actions in the ingest response:

```json
{
  "ok": true,
  "governance": {
    "actions": [
      { "type": "stop", "reason": "Cost limit exceeded", "incident_id": "inc_abc" },
      { "type": "alert", "level": "warning", "message": "High latency detected" }
    ]
  }
}
```

The SDK queues these actions and executes them **before the next LLM call**:

```
Your agent calls LLM (call N)
    ↓
SDK emits telemetry
    ↓
Backend analyses → sends back governance actions
    ↓
Next LLM call (call N+1): SDK checks for pending actions
    ↓
If stop action + allowStop: true → throws GovernanceStopError
```

---

## Configuring Governance

Pass a `governance` object to `init()`. Only the keys you provide override the defaults:

```typescript
import { init } from "@syrin/sdk";

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "my-agent",
  governance: {
    allowStop:          true,   // backend can stop the agent
    allowInjectMessage: false,  // backend cannot inject messages
  },
});
```

### Available Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `allowStop` | `boolean` | `false` | Allow backend to throw `GovernanceStopError` on next LLM call |
| `allowInjectMessage` | `boolean` | `false` | Allow backend to inject messages into the conversation |

Config updates and checkpoints are handled by the SDK internally and are always permitted — no flag needed.

---

## `GovernanceStopError`

Thrown when the backend sends a `stop` action **and** `allowStop: true` is set. Not thrown by default.

```typescript
// GovernanceStopError extends Error (NOT SyrinError)
class GovernanceStopError extends Error {
  readonly reason: string;                    // human-readable explanation from the backend
  readonly incidentId: string | undefined;    // optional correlation ID
  readonly driftScore: number | null;         // drift score at time of stop action
}
```

Import it for catching:

```typescript
import { GovernanceStopError } from "@syrin/sdk";
```

### Handling Stop Actions

```typescript
import { init, withSession, GovernanceStopError } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",
  governance: { allowStop: true },
});

const client = new OpenAI();
const agent  = sdk.agent("travel-assistant");

async function runAgentLoop(history: Array<{ role: string; content: string }>) {
  try {
    while (true) {
      const response = await client.chat.completions.create({
        model:    agent.cfg("llm.model", "gpt-4o") as string,
        messages: history,
      });

      const content = response.choices[0].message.content ?? "";
      history.push({ role: "assistant", content });

      if (isDone(content)) break;
    }
  } catch (err) {
    if (err instanceof GovernanceStopError) {
      console.error(`Agent stopped by backend: ${err.reason}`);
      console.error(`Incident ID: ${err.incidentId}`);

      await savePartialResults(history);
      notifyUser("Your session was paused for review.");
      return;
    }
    throw err;
  }
}
```

### When Is It Thrown?

The stop error is thrown on the **next LLM call** after the backend sends the stop action. If your agent makes no more LLM calls after receiving the stop directive, the error is never thrown.

```typescript
const responseN  = await client.chat.completions.create(...);  // N: flush → stop action received
const responseN1 = await client.chat.completions.create(...);  // N+1: throws GovernanceStopError
```

> ⚠️ **Set `allowStop: false` (the default) and:** stop actions from the backend are logged and discarded. Your agent continues normally. Enable `allowStop: true` only when your agent can handle interruption gracefully.

---

## Message Injection

When `allowInjectMessage: true`, the backend can inject a system message into the conversation before the next LLM call. Useful for corrective guidance when the backend detects drift or policy violations.

The injected message is merged into the messages list automatically. Your agent sees it as a normal system message — no special handling required:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "my-agent",
  governance: { allowInjectMessage: true },
});

// If backend injects:
// { "type": "inject_message", "role": "system", "content": "Focus on the user's actual question" }
// The next LLM call automatically includes this message
```

---

## Common Deployment Configurations

### Observe Only (default)

No disruptive actions. Pure observability. Safe for any environment.

```typescript
const sdk = await init({ apiKey: "syrin_pk_..." });
// governance defaults: { allowStop: false, allowInjectMessage: false }
// Config updates and checkpoints still work — they're always permitted
```

### Config Tuning Only

Allow live config updates from the dashboard (temperature, model, prompts) but no runtime interruptions.

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  // governance omitted — all defaults, config updates always work
});
```

### Full Control (development / sandbox)

Allow the backend to stop and redirect the agent. Use in development or systems designed to handle interruption.

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  governance: {
    allowStop:          true,
    allowInjectMessage: true,
  },
});
```

### Regulated Workloads

Explicitly disable all disruptive actions. Document in code that governance was considered and intentionally restricted.

```typescript
// Finance / healthcare — no runtime mutations
const sdk = await init({
  apiKey: "syrin_pk_...",
  governance: {
    allowStop:          false,  // explicit: backend cannot stop
    allowInjectMessage: false,  // explicit: backend cannot inject
  },
});
```

---

## Governance Dashboard

At [app.syrin.ai → Governance](https://app.syrin.ai):

- **Active governance policy** — per-agent flag settings
- **Governance actions taken** — action type, reason, and incident ID
- **Loop detection scores** — per-session conversation hash repeat counts
- **Drift scores** — model output drift over time
- **Incident history** — full replay of every session that triggered a governance action

---

## Security Considerations

Governance actions originate from your Syrin backend. They are authenticated via your API key. The SDK only executes action types you have explicitly opted into via the `governance` option.

The `allowStop: false` default means your agent cannot be stopped remotely without your code explicitly enabling it. If you run Syrin self-hosted, the governance engine is also fully under your control.
