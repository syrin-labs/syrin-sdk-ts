# Syrin TypeScript SDK — Quickstart

Get full AI agent observability in under 5 minutes.

---

## 1. Install

```bash
npm install @syrin/sdk
```

Requires Node.js 18+.

---

## 2. Initialize

```typescript
import { init } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_..." });
```

That's it. The SDK is now connected to your Syrin project.

> **Always `await` init().** If you skip the `await`, the SDK may not be ready
> before your first LLM call.

---

## 3. Scope a session

Wrap each user request in a session so everything it produces is grouped in the dashboard.

```typescript
import { withSession } from "@syrin/sdk";

app.post("/chat", async (req, res) => {
  const reply = await withSession({ userId: req.body.userId }, async (sid) => {
    return callLLM(req.body.messages);
  });
  res.json({ reply });
});
```

`userId` makes the session ID stable — Alice's requests today all land in
`u:alice:2026-04-19`, giving you a single timeline per user per day.

---

## 4. Add remote config

Any parameter you pass to your LLM can be overridden live from the dashboard:

```typescript
async function run(messages: Message[]) {
  return openai.chat.completions.create({
    model: sdk.cfg("llm.model", "gpt-4o"),
    temperature: sdk.cfg("llm.temperature", 0.7, { ge: 0.0, le: 2.0 }),
    messages,
  });
}
```

Push `llm.temperature = 0.3` from the dashboard → the next call uses `0.3`. No redeploy.

---

## 5. Emit custom events

```typescript
sdk.log("Retrieved 42 documents", { metadata: { collection: "kb" } });
sdk.log("Fallback triggered", { level: "warning" });
```

Events appear on the session timeline with timestamp, level, and metadata.

---

## Full example — Express agent

```typescript
import { init, withSession, withAgent } from "@syrin/sdk";
import OpenAI from "openai";
import express from "express";

const sdk = await init({ apiKey: "syrin_..." });
sdk.registerAgent("chat-agent", { description: "Customer support agent" });

const app = express();
const openai = new OpenAI();

app.post("/chat", async (req, res) => {
  const reply = await withSession({ userId: req.body.userId }, async (sid) => {
    return withAgent("chat-agent", async () => {
      const response = await openai.chat.completions.create({
        model: sdk.cfg("llm.model", "gpt-4o"),
        temperature: sdk.cfg("llm.temperature", 0.7),
        messages: req.body.messages,
      });
      return response.choices[0].message.content;
    });
  });
  res.json({ reply });
});
```

---

## All `init()` options

```typescript
const sdk = await init({
  apiKey: "syrin_...",           // required — from dashboard Settings
  agentId: "my-agent",          // default agent ID for un-scoped calls
  offline: false,               // true = no network (local dev / CI)
  captureContent: false,        // true = store prompt/completion text (check PII policy)
  captureToolCalls: true,       // emit tool call events
  backendUrl: "https://...",    // Syrin cloud (default) or self-hosted
  otelEndpoint: "http://...",   // OTLP export (Jaeger, Tempo, Honeycomb, etc.)
  debug: false,                 // verbose SDK logging
  scanPaths: ["./src"],         // scan source for cfg() defaults at startup
});
```

---

## Common use-cases

### Multi-agent workflow

```typescript
import { withWorkflow, withAgent } from "@syrin/sdk";

await withSession({ userId }, async () => {
  await withWorkflow("research-pipeline", async () => {
    await withAgent("planner", async () => {
      plan = await callLLM(planPrompt);
    });
    await withAgent("executor", async () => {
      result = await callLLM(execPrompt);
    });
  });
});
```

### Instrument a tool

```typescript
import { withTool } from "@syrin/sdk";

async function search(query: string): Promise<string[]> {
  return withTool("web_search", { query }, () => webSearchAPI(query));
}
```

### Checkpoint before a risky operation

```typescript
const checkpoint = await sdk.createCheckpoint(messages, { label: "before-tool" });
try {
  messages = await callToolAndAppend(messages);
} catch {
  messages = await sdk.restoreCheckpoint(checkpoint.checkpointId) ?? messages;
}
```

### React to backend config pushes

```typescript
import { onConfigChange } from "@syrin/sdk";

onConfigChange((update) => {
  console.log("Remote config updated:", update);
});
```

### Governance stop

```typescript
import { GovernanceStopError } from "@syrin/sdk";

try {
  const response = await callLLM(messages);
} catch (e) {
  if (e instanceof GovernanceStopError) {
    return { error: "blocked", reason: e.reason };
  }
  throw e;
}
```

### Skip telemetry for internal calls

```typescript
import { withSkip } from "@syrin/sdk";

const probe = await withSkip(() =>
  openai.chat.completions.create({ model: "gpt-4o-mini", messages: [...] })
);
```

---

## Module-level helpers vs instance methods

After `init()`, both styles work:

```typescript
// Instance method — good when you have named instances
const sdk = await init({ apiKey: "..." });
sdk.cfg("llm.model", "gpt-4o");
sdk.log("hello");

// Module-level helper — good for single-instance apps
import { cfg, log } from "@syrin/sdk";
cfg("llm.model", "gpt-4o");
log("hello");
```

Module-level helpers target the **default** (first) instance.

---

## Next steps

- [ConfigStore, Tunable, ConfigGuard](config-store.md) — advanced config management
- [OTel Schema Reference](otel-reference.md) — span attributes for custom dashboards
- [Backend API Reference](backend-api.md) — webhook and ingest endpoints
