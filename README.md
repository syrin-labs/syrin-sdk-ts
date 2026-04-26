# @syrin/sdk

[![npm](https://img.shields.io/npm/v/@syrin/sdk.svg)](https://npmjs.com/package/@syrin/sdk)
[![Node 18+](https://img.shields.io/badge/node-18%2B-blue.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-enabled-orange.svg)](https://opentelemetry.io/)

**Observability, remote config, and governance for AI agents** — one import, one `init()` call, zero changes to your existing code.

---

## What Syrin gives you

| Capability | What it means |
|---|---|
| **Session timeline** | Every LLM call, cost, latency, and custom event grouped by user and run |
| **Remote config** | Change model, temperature, prompts live from the dashboard — no redeploy |
| **Governance** | Stop or constrain agents at runtime from the backend |
| **Checkpoints** | Save and restore conversation state for recovery flows |
| **Custom events** | Emit structured log entries that appear on the session timeline |
| **OpenTelemetry** | Standard `gen_ai.*` spans + `syrin.*` extensions, works with any OTLP backend |
| **Feedback** | Rate sessions from your app; aggregate in the dashboard |
| **Multi-agent** | Orchestrators, pipelines, parallel workers — topology rendered on the dashboard |

---

## Install

```bash
npm install @syrin/sdk
```

Requires Node 18+. The only required runtime dependency is Node's built-in `fetch`; OpenTelemetry exporters are optional peer dependencies.

---

## Two Lines. You're Live.

```typescript
import { init } from "@syrin/sdk";

init({ apiKey: "syrin_..." });
```

That is the entire setup. Every `openai.chat.completions.create()` call in your process is now instrumented — costs tracked, latency measured, events batched to the dashboard.

---

## Core Concepts

### Sessions — Every Run Has a Home

Wrap each user request in `withSession()`. Everything inside — LLM calls, costs, custom events — appears together on the dashboard timeline under that session ID.

```typescript
import { withSession } from "@syrin/sdk";

await withSession("u:alice:2026-04-19", async () => {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
  });
});
```

Session IDs are yours to choose. Use **deterministic IDs** to group calls across requests:

| Pattern | Session ID |
|---|---|
| Random | `ses_a1b2c3` (call `generateSessionId()`) |
| User × day | `u:alice:2026-04-19` |
| User × hour | `u:alice:2026-04-19T14` |
| User × forever | `u:alice` |
| Named batch | `k:batch-etl:2026-04-19` |

```typescript
// Check what session is active inside a withSession block
import { getSessionId } from "@syrin/sdk";

await withSession("u:alice:today", async () => {
  console.log(getSessionId()); // "u:alice:today"
});
```

---

### One Config Key. Infinite Leverage.

Declare any parameter as remotely configurable. Push overrides from the dashboard and they take effect on the next call — no redeploy, no restart.

```typescript
import { sdk } from "@syrin/sdk";
// or: const myAgent = sdk.agent("chat")

const response = await openai.chat.completions.create({
  model:       myAgent.cfg("llm.model",       "gpt-4o"),
  temperature: myAgent.cfg("llm.temperature", 0.7),
  max_tokens:  myAgent.cfg("llm.max_tokens",  1024),
  messages: [
    { role: "system", content: myAgent.cfg("prompt.system", "You are helpful.") },
    { role: "user",   content: userMessage },
  ],
});
```

- **Key format:** `"section.field"` — sections appear as accordion groups in the dashboard
- **Default:** used until you push an override from the backend
- **Priority:** governance anchor → local `configure()` → remote push → default

---

### Events That Actually Mean Something

Emit structured events that appear on the session timeline with timestamp and metadata.

```typescript
sdk.emit("HANDOFF",        { from_agent: "orchestrator", to_agent: "researcher" });
sdk.emit("GUARDRAIL_INPUT",{ name: "pii_filter", passed: true });
sdk.emit("BUDGET_ESTIMATION", { estimated_cost_usd: 0.12, budget_usd: 1.0 });
sdk.emit("TOOL_SELECTED",  { tool: "web_search", query: "latest AI news" });
```

Built-in event types the dashboard understands:

| Event type | Dashboard treatment |
|---|---|
| `GUARDRAIL_INPUT` / `GUARDRAIL_OUTPUT` | Guardrail check icons on timeline |
| `CIRCUIT_BREAKER_OPEN` / `_CLOSE` | Circuit breaker markers |
| `HANDOFF` | Agent → agent arrows |
| `AGENT_FORK` / `AGENT_JOIN` | Parallel branch markers |
| `BUDGET_ESTIMATION` | Budget bar in session header |
| `CHECKPOINT` | Checkpoint pins on timeline |
| `TOOL_SELECTED` | Tool usage rows |

Any other string is stored as a raw event and shown on the timeline.

---

### The Kill Switch. (Governance)

The backend can stop an agent mid-run when a governance rule fires — cost exceeded, loop detected, and so on. Opt in and catch `GovernanceStopError`:

```typescript
import { init, GovernanceStopError } from "@syrin/sdk";

const sdk = await init({
  apiKey: "syrin_...",
  governance: { allowStop: true },   // opt in to destructive actions
});

try {
  const response = await openai.chat.completions.create({ ... });
} catch (e) {
  if (e instanceof GovernanceStopError) {
    console.warn("Agent stopped:", e.reason, "incident:", e.incidentId);
    return { error: "request_blocked", reason: e.reason };
  }
  throw e;
}
```

---

## Multi-agent Apps — `AgentHandle`

For apps with multiple agents, use `sdk.agent()` to declare each agent's config fields once and scope calls precisely. Each agent appears as a separate group in the dashboard.

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: "syrin_..." });
const openai = new OpenAI();

// ── Declare agents and their configurable fields ──────────────────────────────
const researcher = sdk.agent("researcher");
researcher.field("llm.temperature", 0.3, { ge: 0.0, le: 2.0, label: "Temperature" });
researcher.field("llm.model", "gpt-4o", { label: "Model" });
researcher.field("prompt.system", "Research thoroughly.", { multiline: true });

const writer = sdk.agent("writer");
writer.field("llm.temperature", 0.7, { ge: 0.0, le: 2.0 });
writer.field("output.format", "markdown", { enum: ["markdown", "plain", "html"] });

// ── Session + agent scope in one call ─────────────────────────────────────────
await withSession("u:alice:today", async () => {
  const response = await openai.chat.completions.create({
    model:       researcher.cfg("llm.model", "gpt-4o"),
    temperature: researcher.cfg("llm.temperature", 0.3),
    messages: [
      { role: "system", content: researcher.cfg("prompt.system", "Research thoroughly.") },
      { role: "user", content: query },
    ],
  });
});
```

---

### Multi-agent Topology

Tell the dashboard how your agents are connected:

```typescript
const sdk = await init({
  apiKey: "syrin_...",
  agentId: "travel-orchestrator",
  topology: {
    type: "orchestrator",
    nodes: {
      "researcher-agent":        { role: "worker", execMode: "sequential" },
      "hotel-finder-agent":      { role: "worker", execMode: "parallel", group: "swarm-1" },
      "transport-agent":         { role: "worker", execMode: "parallel", group: "swarm-1" },
      "events-agent":            { role: "worker", execMode: "parallel", group: "swarm-1" },
      "route-optimizer-agent":   { role: "worker", execMode: "sequential" },
      "itinerary-creator-agent": { role: "worker", execMode: "sequential" },
    },
    edges: [
      { from: "researcher-agent",     to: "hotel-finder-agent",       group: "swarm-1" },
      { from: "researcher-agent",     to: "transport-agent",           group: "swarm-1" },
      { from: "researcher-agent",     to: "events-agent",              group: "swarm-1" },
      { from: "hotel-finder-agent",   to: "route-optimizer-agent" },
      { from: "transport-agent",      to: "route-optimizer-agent" },
      { from: "events-agent",         to: "route-optimizer-agent" },
      { from: "route-optimizer-agent","to": "itinerary-creator-agent" },
    ],
    entryPoint: "researcher-agent",
    terminalNodes: ["itinerary-creator-agent"],
  },
});
```

Supported topology types: `single`, `orchestrator`, `pipeline`, `parallel`, `graph`, `conditional_graph`, `hybrid`.

Or define it after `init()`:

```typescript
sdk.defineTopology({ type: "pipeline", nodes: { ... }, edges: [...] });
```

---

### Multi-agent HTTP Router

Route `POST /agent/:agentId/run` and `POST /agent/:agentId/chat` to your agent functions automatically:

```typescript
// Express
const router = sdk.createAgentRouter({
  "researcher-agent": async (task) => {
    // task.input, task.sessionId, task.agentId available
    return { result: await runResearch(task.input) };
  },
  "writer-agent": async (task) => {
    return { result: await runWriter(task.input) };
  },
});

app.use(router.express());

// Fastify
fastify.register(router.fastify());
```

Each handler runs inside the correct agent + session context — all LLM calls inside are automatically tagged.

---

## The Full Play — Express Chat Server

```typescript
import { init, GovernanceStopError, withSession } from "@syrin/sdk";
import OpenAI from "openai";
import express from "express";

// ── Init ──────────────────────────────────────────────────────────────────────
const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  agentId: "chat-agent",
  governance: { allowStop: true },
});

const chat = sdk.agent("chat");
chat.field("llm.model",       "gpt-4o",                         { label: "Model" });
chat.field("llm.temperature", 0.7, { ge: 0.0, le: 2.0,          label: "Temperature" });
chat.field("llm.max_tokens",  1024, { ge: 1, le: 8192 });
chat.field("prompt.system",   "You are a helpful assistant.",   { multiline: true });

const openai = new OpenAI();
const app = express();
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { user_id = "anonymous", messages = [] } = req.body;
  const sessionId = `u:${user_id}:${new Date().toISOString().slice(0, 10)}`;

  try {
    let reply = "";
    await withSession(sessionId, async () => {
      const systemPrompt = chat.cfg("prompt.system", "You are a helpful assistant.");
      const response = await openai.chat.completions.create({
        model:       chat.cfg("llm.model",       "gpt-4o"),
        temperature: chat.cfg("llm.temperature", 0.7),
        max_tokens:  chat.cfg("llm.max_tokens",  1024),
        messages:    [{ role: "system", content: systemPrompt }, ...messages],
      });
      reply = response.choices[0].message.content ?? "";
      sdk.emit("CUSTOM_LOG", { message: "Chat completed", turns: messages.length });
    });

    res.json({ reply, session_id: sessionId });
  } catch (e) {
    if (e instanceof GovernanceStopError) {
      return res.status(503).json({ error: "blocked", reason: e.reason });
    }
    throw e;
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(3000, () => console.log("Listening on :3000"));

// Flush on shutdown
process.on("SIGTERM", async () => {
  await sdk.shutdown();
  process.exit(0);
});
```

---

## Every Knob, Mapped. (`init()` options)

```typescript
const sdk = await init({
  apiKey:          "syrin_...",       // Required — from dashboard Settings
  agentId:         "my-agent",        // Default agent ID for un-scoped calls
  backendUrl:      "https://...",     // Default: https://api.syrin.dev
  offline:         false,             // true = no network (local dev / CI)
  captureContent:  false,             // true = record prompt/response text (check PII policy)
  otelExporter:    "none",            // "none" | "console" | "otlp"
  otelEndpoint:    "http://...",      // OTLP endpoint (Jaeger, Tempo, Honeycomb, etc.)
  debug:           false,             // Verbose SDK logging
  governance: {
    allowStop:          false,        // Opt in to backend-driven agent stops
    allowInjectMessage: false,        // Opt in to backend-injected messages
  },
  idleFlushMs:     10_000,            // How long to wait before flushing a partial batch
  batchSize:       100,               // Max events per /ingest POST
  topology:        { ... },           // Optional: multi-agent topology declaration
});
```

---

## Skip Telemetry for Specific Calls

Exclude a block from all Syrin instrumentation — useful for health probes and internal calls.

```typescript
import { withSession } from "@syrin/sdk";

// Pass a special "skip" session ID — the interceptor ignores it
await withSession("__syrin_skip__", async () => {
  const probe = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "ping" }],
  });
});
```

---

## React to Config Pushes

Register a callback that fires whenever the backend pushes a config update:

```typescript
import { onConfigChange, onAlert } from "@syrin/sdk";

onConfigChange((sessionId, updates) => {
  console.log(`Config updated for session ${sessionId}:`, updates);
});

onAlert((action) => {
  if (action["level"] === "critical") {
    pagerduty.trigger(String(action["message"]));
  }
});
```

---

## Feedback — Let Users Rate Runs

Rate a session from anywhere in your app:

```typescript
// Single session rating
await sdk.sessions.rate("u:alice:2026-04-19", "positive");
await sdk.sessions.rate("u:alice:2026-04-19", "negative", { reason: "Wrong output" });

// Fluent builder
await sdk.sessions.withId("u:alice:2026-04-19").rate("positive", { voterId: "reviewer-1" });

// Batch rating
await sdk.sessions.rateBatch([
  { sessionId: "ses_001", rating: "positive" },
  { sessionId: "ses_002", rating: "negative", reason: "Hallucinated" },
]);
```

Errors: `AlreadyRatedError` (409), `SessionNotFoundError` (404), `ValidationError` (422).

---

## Checkpoints — Roll Back to Any Point

```typescript
// Save state before a risky operation
const checkpoint = await sdk.createCheckpoint(messages, { label: "before-tool-call" });

try {
  const toolResult = await callRiskyTool();
  messages.push({ role: "tool", content: toolResult });
} catch {
  // Restore to pre-tool state on failure
  const restored = await sdk.restoreCheckpoint(checkpoint.checkpointId);
  if (restored) messages = restored;
  console.warn("Tool failed — restored to checkpoint", checkpoint.checkpointId);
}

// List all checkpoints for a session
const cps = sdk.listCheckpoints("u:alice:today");
```

---

## Runtime Tunability — `@tunable` Decorator

Mark class properties as remotely configurable. The dashboard can push new values at runtime without a redeploy.

```typescript
import { tunable, TunableField } from "@syrin/sdk";

@tunable({ namespace: "document-processor" })
class DocumentProcessor {
  batchSize   = TunableField({ default: 10,  ge: 1,   le: 100 });
  temperature = TunableField({ default: 0.7, ge: 0.0, le: 2.0 });
  model       = TunableField({ default: "gpt-4o" });
}

const processor = new DocumentProcessor();
// processor.batchSize   → 10 (or whatever the dashboard has pushed)
// processor.temperature → 0.7
```

Or register an existing object programmatically:

```typescript
import { tune, getTune } from "@syrin/sdk";

tune({
  target: myConfig,
  namespace: "inference",
  fields: {
    temperature: { type: "number", default: 0.7, ge: 0.0, le: 2.0 },
    model:        { type: "string", default: "gpt-4o" },
  },
});

const current = getTune("inference"); // { temperature: 0.7, model: "gpt-4o" }
```

---

## Environment Variables

All `init()` options can be set via environment variables:

| Variable | Equivalent `init()` option |
|---|---|
| `SYRIN_API_KEY` | `apiKey` |
| `SYRIN_BACKEND_URL` | `backendUrl` |
| `SYRIN_AGENT_ID` | `agentId` |
| `SYRIN_DEBUG` | `debug` |
| `SYRIN_CAPTURE_CONTENT` | `captureContent` |
| `SYRIN_OTEL_EXPORTER` | `otelExporter` |
| `SYRIN_OTEL_ENDPOINT` | `otelEndpoint` |
| `SYRIN_OFFLINE` | `offline` |
| `SYRIN_IDLE_FLUSH_MS` | `idleFlushMs` |
| `SYRIN_BATCH_SIZE` | `batchSize` |

---

## API Reference

### Lifecycle

| Symbol | Description |
|---|---|
| `init(options)` | Initialize the SDK, returns `SyrinSDKInstance` |
| `shutdown()` | Flush all pending events and tear down |
| `sdk.flush()` | Flush pending events immediately |
| `sdk.refreshSchema()` | Re-push agent schema to the backend |
| `sdk.configSnapshot()` | Returns active config with API key masked |

### Sessions & Scoping

| Symbol | Description |
|---|---|
| `withSession(id, fn)` | Scope all LLM calls in `fn` to session `id` |
| `getSessionId()` | Returns the active session ID (inside `withSession`) |
| `sdk.agent(name)` | Returns an `AgentHandle` with `.field()`, `.cfg()`, `.run()` |

### Config

| Symbol | Description |
|---|---|
| `sdk.agent(id).cfg(key, default)` | Declare + read a remotely configurable value |
| `sdk.agent(id).field(key, default, opts)` | Register a field in the dashboard config panel |
| `sdk.configure(overrides, sessionId?)` | Push local config overrides programmatically |
| `sdk.activeConfig(sessionId?)` | Returns the effective config for a session |

### Events & Hooks

| Symbol | Description |
|---|---|
| `sdk.emit(eventType, payload?, sessionId?)` | Emit a custom lifecycle event |
| `sdk.checkpoint(label, metadata?, sessionId?)` | Emit a CHECKPOINT event |
| `onConfigChange(fn)` | Hook: called when backend pushes a config update |
| `onAlert(fn)` | Hook: called on backend governance alerts |
| `sdk.onContextInjection(fn)` | Hook: called when backend injects context |
| `sdk.getPendingInjections(sessionId?)` | Pop and return pending context injections |

### Governance

| Symbol | Description |
|---|---|
| `GovernanceStopError` | Thrown when backend sends a STOP action |
| `GovernanceStopError.reason` | Human-readable reason string |
| `GovernanceStopError.incidentId` | Dashboard incident ID |
| `GovernanceStopError.driftScore` | Loop/drift score that triggered the stop |

### Feedback

| Symbol | Description |
|---|---|
| `sdk.sessions.rate(id, rating, opts?)` | Rate a session `"positive"` or `"negative"` |
| `sdk.sessions.withId(id).rate(rating)` | Fluent version of `rate()` |
| `sdk.sessions.rateBatch(items)` | Rate multiple sessions concurrently |
| `sdk.sessions.start({ sessionId, successCriteria? })` | Start a session with criteria, returns feedback handle |
| `AlreadyRatedError` | Thrown on 409 — session already rated |
| `SessionNotFoundError` | Thrown on 404 |
| `ValidationError` | Thrown on 422 |

### Checkpoints

| Symbol | Description |
|---|---|
| `sdk.createCheckpoint(messages, opts?)` | Save conversation state |
| `sdk.restoreCheckpoint(checkpointId)` | Restore saved conversation state |
| `sdk.listCheckpoints(sessionId?)` | List all local checkpoints for a session |

### Multi-agent

| Symbol | Description |
|---|---|
| `sdk.defineTopology(topology)` | Declare agent graph after `init()` |
| `sdk.createAgentRouter(fns)` | Route `/agent/:id/run|chat` to handler functions |
| `sdk.createServer(opts)` | Create an `AgentServer` for manual route mounting |
| `AgentServer.mountExpress(app)` | Mount on Express |
| `AgentServer.fastifyPlugin()` | Register as Fastify plugin |

### Advanced (importable directly)

| Symbol | Description |
|---|---|
| `tunable(opts)` | Class decorator: marks fields as remotely tunable |
| `TunableField(opts)` | Marks a class property as tunable (use inside `@tunable` class) |
| `tune(opts)` | Programmatic registration of an existing object |
| `getTune(namespace)` | Read current tunable values for a namespace |
| `globalRegistry` | The global `TunableRegistry` singleton |
| `SyrinCore` | Raw instrumentation engine for framework authors |
| `ConfigStore` | Typed key-value config store with validation and history |

---

## Docs

### Getting Started
- [Introduction](docs/getting-started/introduction.md)
- [Installation](docs/getting-started/installation.md)
- [Quickstart](docs/getting-started/quickstart.md)

### Sessions
- [Sessions & Windows](docs/sessions/sessions.md)
- [withSession()](docs/sessions/with-session.md)

### Configuration
- [Remote Config — cfg()](docs/configuration/cfg.md)

### Observability
- [Auto-instrumentation & events](docs/observability/observability.md)
- [OTel span reference](docs/otel-reference.md)

### Control
- [Governance](docs/control/governance.md)
- [Feedback](docs/control/feedback.md)
- [Checkpoints](docs/control/checkpoints.md)

### Multi-Agent
- [Multi-agent systems](docs/agents/multi-agent.md)
- [AgentHandle](docs/agents/agent-handle.md)

### Reference
- [Backend API](docs/backend-api.md)
- [Adapter system](docs/adapters.md)
- [Config store internals](docs/config-store.md)
