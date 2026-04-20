# @syrin/sdk

**Mixpanel for AI agents** — observability, remote configuration, evals, and debugging for
any AI agent, framework, or LLM library. Minimal integration, maximum insight.

---

## What you get

- **Dashboard visibility** — every LLM call, session, agent run, tool call, and custom event in one place
- **Remote config** — change model, temperature, prompts, and any parameter live from the dashboard — no redeploy
- **Governance** — stop or constrain agent behaviour from the backend at runtime
- **Checkpoints** — save and restore conversation state for recovery flows
- **Custom logging** — emit structured events that appear on the session timeline
- **OpenTelemetry** — standard `gen_ai.*` spans + `syrin.*` extensions

---

## Setup — 4 lines

```bash
npm install @syrin/sdk
```

```typescript
import { init } from "@syrin/sdk";

await init({ apiKey: "syrin_..." });
```

That is the entire setup. The SDK connects to your Syrin project and you can immediately
start emitting events, using remote config, and scoping sessions.

---

## Core API

### 1. Session scoping

Group all events for a user request into a single dashboard session.

```typescript
import { withSession } from "@syrin/sdk";

// Web handler — one session per request
await withSession({ userId: request.userId, window: "day" }, async (sid) => {
  const reply = await callLLM(messages);
  return reply;
});

// Background job — independent run each time
await withSession(async (sid) => {
  const result = await runPipeline();
});
```

Session IDs are **stable within a window** — all of Alice's requests today share one
session, letting you see her full conversation history in the dashboard.

| Call | Session ID |
|------|-----------|
| `withSession(fn)` | `ses_a1b2c3d` (auto) |
| `withSession({ userId: "alice", window: "day" }, fn)` | `u:alice:2026-04-19` |
| `withSession({ userId: "alice", window: "forever" }, fn)` | `u:alice` |
| `withSession({ key: "batch-etl", window: "day" }, fn)` | `k:batch-etl:2026-04-19` |

### 2. Agent scoping

Tag events with the agent that produced them.

```typescript
import { withAgent } from "@syrin/sdk";

await withAgent("researcher", async () => {
  const response = await openai.chat.completions.create({ ... });
});

// Register with metadata for the dashboard
sdk.registerAgent("researcher", { description: "Searches and summarises" });
```

Combine with `withWorkflow()` or `withSwarm()` for multi-agent pipelines:

```typescript
import { withWorkflow, withAgent } from "@syrin/sdk";

await withWorkflow("pipeline", async () => {
  await withAgent("planner", async () => {
    plan = await callLLM(planPrompt);
  });
  await withAgent("executor", async () => {
    result = await callLLM(execPrompt);
  });
});
```

### 3. Remote config — `cfg()`

Declare any parameter as remotely configurable. The dashboard shows a live control panel.

```typescript
const sdk = await init({ apiKey: "syrin_..." });

const response = await openai.chat.completions.create({
  model: sdk.cfg("llm.model", "gpt-4o"),
  temperature: sdk.cfg("llm.temperature", 0.7, { ge: 0.0, le: 2.0 }),
  messages: [...],
});
```

Or use the module-level helper:

```typescript
import { cfg } from "@syrin/sdk";

const model = cfg("llm.model", "gpt-4o");
```

- `key` uses dot-notation: `"section.field"` — sections become accordion groups in the dashboard
- The **default** is used until you push an override from the dashboard
- Inside `withAgent("name", ...)` the field is automatically scoped to that agent

### 4. Custom logging

Emit structured events that appear on the session timeline.

```typescript
sdk.log("Retrieved 42 documents", { metadata: { collection: "kb", latencyMs: 45 } });
sdk.log("Cost budget at 80%", { level: "warning" });
sdk.log("Tool call failed", { level: "error", metadata: { tool: "webSearch" } });
```

### 5. Governance

The backend can stop an agent mid-run. Catch `GovernanceStopError`:

```typescript
import { GovernanceStopError } from "@syrin/sdk";

try {
  const response = await callLLM(messages);
} catch (e) {
  if (e instanceof GovernanceStopError) {
    logger.warn("Agent stopped by governance:", e.reason);
    return { error: "request_blocked" };
  }
  throw e;
}
```

---

## Common patterns

### Instrument an Express / Fastify route

```typescript
import { init, withSession, withAgent } from "@syrin/sdk";

await init({ apiKey: "syrin_..." });

app.post("/chat", async (req, res) => {
  const reply = await withSession({ userId: req.body.userId }, async (sid) => {
    return withAgent("chat-agent", () => callLLM(req.body.messages));
  });
  res.json({ reply });
});
```

### Instrument a tool

```typescript
import { withTool } from "@syrin/sdk";

async function search(query: string): Promise<string[]> {
  return withTool("web_search", { query }, () => webSearchAPI(query));
}
```

### Checkpoints (save / restore conversation state)

```typescript
// Save before a risky operation
const checkpoint = await sdk.createCheckpoint(messages, { label: "pre-tool-call" });

// If the operation fails, restore
try {
  result = await riskyToolCall();
} catch {
  messages = await sdk.restoreCheckpoint(checkpoint.checkpointId);
}
```

### Skip telemetry for specific calls

```typescript
import { withSkip } from "@syrin/sdk";

await withSkip(() => openai.chat.completions.create({ ... })); // not tracked
```

---

## Configuration

```typescript
const sdk = await init({
  apiKey: "syrin_...",           // required
  agentId: "my-agent",          // optional — default agent for all calls
  offline: false,               // true = no network calls (local dev)
  captureContent: false,        // true = record prompt/response text (PII-sensitive)
  captureToolCalls: true,       // record tool call events
  backendUrl: "https://...",    // defaults to Syrin cloud
  otelEndpoint: "http://...",   // optional OTLP endpoint for Jaeger / Tempo
});
```

---

## API reference

### Always needed

| Symbol | What it does |
|--------|-------------|
| `init(options)` | Initialize the SDK |
| `shutdown()` | Flush events, tear down |
| `withSession(opts, fn)` | Scope events to a session |
| `withAgent(id, fn)` | Scope events to an agent |
| `cfg(key, default)` | Remote-configurable value |
| `log(message, opts)` | Emit custom event |
| `GovernanceStopError` | Catch governance stops |

### Common

| Symbol | What it does |
|--------|-------------|
| `sdk.registerAgent(id, opts)` | Register agent with dashboard |
| `sdk.registerEndpoint(name, schema)` | Register run form schema |
| `sdk.configure(overrides)` | Local config overrides |
| `onConfigChange(callback)` | React to remote config pushes |
| `onAlert(callback)` | React to backend alerts |
| `withWorkflow(id, fn)` / `withSwarm(id, fn)` | Multi-agent scoping |
| `withTool(name, args, fn)` | Instrument tool calls |
| `withMemory(name, fn)` | Instrument memory access |
| `sdk.createCheckpoint(messages)` | Save conversation state |
| `sdk.restoreCheckpoint(id)` | Restore conversation state |
| `withSkip(fn)` | Exclude a block from telemetry |
| `sdk.healthCheck()` | Ping the backend |

### Advanced (importable, not advertised)

`ConfigStore` — raw config storage  
`ConfigSync` — manual config polling (usually automatic)  
`tunable` / `tune()` — remote-tunable class decorator  
`TraceSpan` — manual custom trace spans  
`SyrinSDKCore` — raw instrumentation engine for framework authors  
`IdentityManager`, `CallInterceptor`, `ToolGovernance` — advanced runtime control

---

## Multi-instance

Most apps use the module-level helpers which target the **default** instance.
For multiple named instances:

```typescript
const sdkA = await init({ apiKey: "...", instanceName: "agent-a" });
const sdkB = await init({ apiKey: "...", instanceName: "agent-b" });

sdkA.configure({ temperature: 0.3 });
sdkB.configure({ temperature: 0.7 });
```

---

## Docs

- [Quickstart Guide](docs/quickstart.md)
- [ConfigStore, Tunable, ConfigGuard](docs/config-store.md)
- [OTel Schema Reference](docs/otel-reference.md)
- [Backend API Reference](docs/backend-api.md)
