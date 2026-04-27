---
title: "Governance"
description: "Backend-driven controls that can stop or redirect your agent — configured via the governance option in init()."
weight: 60
---

## The Kill Switch You Never Want to Use (But Definitely Want to Have)

Governance lets the Syrin backend take action on your agent at runtime — stopping a runaway loop, injecting a corrective message, triggering a checkpoint before a risky operation. All disruptive actions require your explicit opt-in through the `governance` option in `init()`.

By default, all disruptive actions are disabled. You must explicitly allow each one.

Every governance action fired creates an **incident** visible at [app.syrin.ai → Governance → Incidents](https://app.syrin.ai) with the full session replay, loop trace, cost at time of stop, and the exact reason string.

### How It Works

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

The SDK queues these actions and executes them **before the next LLM call**. This keeps the control loop clean:

```
Your agent calls LLM
    ↓
Syrin emits telemetry
    ↓
Backend analyses → sends back governance actions
    ↓
Next LLM call: SDK checks for pending actions
    ↓
If stop action + allowStop: true → throws GovernanceStopError
```

### Configuring Governance

Pass a `governance` object to `init()`. Only the keys you provide override the defaults — omit any key to keep its default value.

```typescript
import { init } from "@syrin/sdk";

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "my-agent",
  governance: {
    allowStop: true,           // backend can stop the agent
    allowInjectMessage: false, // backend cannot inject messages
  },
});
```

#### Available Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `allowStop` | `boolean` | `false` | Allow backend to throw `GovernanceStopError` |
| `allowInjectMessage` | `boolean` | `false` | Allow backend to inject messages into the conversation |

The TypeScript SDK exposes the two flags that map to disruptive runtime actions. Config updates and checkpoints are handled separately by the SDK internals and are always permitted.

### `GovernanceStopError`

Thrown when the backend sends a `stop` action **and** `allowStop: true` is set.

```typescript
import { GovernanceStopError } from "@syrin/sdk";

class GovernanceStopError extends Error {
  readonly reason: string;         // human-readable explanation from the backend
  readonly incidentId: string | undefined; // optional correlation ID
}
```

#### Handling Stop Actions

```typescript
import { init, GovernanceStopError } from "@syrin/sdk";
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
        model:    agent.cfg("llm.model", "gpt-4o"),
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

      // Graceful cleanup
      await savePartialResults(history);
      notifyUser("Your session was paused for review.");
      return;
    }
    throw err;
  }
}
```

#### When Is It Thrown?

The stop error is thrown on the **next LLM call** after the backend sends the stop action. If your agent makes no more LLM calls after receiving the stop directive, the error is never thrown.

```typescript
// SDK receives stop action during flush after call N
// Next call (N+1) throws GovernanceStopError

const responseN  = await client.chat.completions.create(...);  // N: triggers flush, stop received
const responseN1 = await client.chat.completions.create(...);  // N+1: throws GovernanceStopError
```

This design keeps your agent loop clean — the stop propagates as a normal exception through your existing `try/catch` stack.

#### Stop Action Without `allowStop`

If `allowStop` is `false` (the default), stop actions from the backend are **logged and discarded** — your agent continues normally. Enable `allowStop: true` only when your agent can handle interruption gracefully.

```typescript
// Default: governance stop is a no-op
const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });
// Backend can send stop all it wants — agent will never throw
```

### Message Injection

When `allowInjectMessage: true`, the backend can inject a system message into the conversation before the next LLM call. This is useful for providing corrective guidance when the backend detects drift or policy violations.

The injected message is merged into the messages list automatically by the SDK interceptor. Your agent sees it as a normal system message — no special handling required.

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "my-agent",
  governance: { allowInjectMessage: true },
});

// If backend injects: { "type": "inject_message", "role": "system", "content": "Focus on the user's actual question" }
// The next LLM call automatically includes this message
```

### Common Deployment Configurations

#### Observe Only (default)

No governance actions. Pure observability. Safe for any environment.

```typescript
const sdk = await init({ apiKey: "syrin_pk_..." });
// governance defaults: { allowStop: false, allowInjectMessage: false }
```

---

#### Config Tuning Only

Allow live config updates from the dashboard (temperature, model, prompts) but no runtime interruptions.

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  governance: {},  // all defaults — config updates are always permitted
});
```

---

#### Full Control (development / sandbox)

Allow the backend to stop and redirect the agent. Use in development environments or systems that have been explicitly designed to handle interruption.

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  governance: {
    allowStop:           true,
    allowInjectMessage:  true,
  },
});
```

---

#### Regulated Workloads

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

### Governance Dashboard

In the Syrin dashboard, the Governance panel shows:

- Active governance policy for each agent
- Governance actions taken and their reasons
- Loop detection scores
- Drift scores over time
- Incident history

### Security Considerations

Governance actions originate from your Syrin backend (which you control or which is hosted on your behalf). They are authenticated via your API key. The SDK only executes the action types you have explicitly opted into via `governance` in `init()`.

The `allowStop: false` default means your agent cannot be stopped remotely unless you explicitly enable it — there is no way to accidentally expose this capability. If you are running Syrin self-hosted, the governance engine is also under your full control.
