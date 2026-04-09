# Syrin TypeScript SDK — Quickstart

Get full AI agent observability in under 5 minutes.

---

## Installation

```bash
npm install @syrin/sdk openai
```

Requires Node.js 18+ and `openai>=4.0.0`.

---

## Zero-Code Integration

Add two lines. Nothing else in your codebase changes.

```typescript
import { init } from "@syrin/sdk";
await init({ apiKey: "syrin_..." });

// Your existing OpenAI code is now fully instrumented:
import OpenAI from "openai";
const client = new OpenAI(); // reads OPENAI_API_KEY from env

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);
```

> **Important:** `await` the `init()` call. If you skip `await`, the OpenAI SDK may not be
> patched before your first call and telemetry will be silently missed.

Every call now emits a telemetry event with: model, tokens, cost, latency, session context, conversation hashes, context utilization, and more.

---

## init() Options

```typescript
const sdk = await init({
  apiKey: "syrin_...",           // or SYRIN_API_KEY env var
  agentId: "my-agent",           // optional label for this agent
  sessionId: "ses_custom",       // auto-generated if not set
  backendUrl: "https://...",     // where to POST events
  debug: false,                  // verbose logging to console
  captureContent: false,         // include prompt/response text in spans
  offline: false,                // disable all HTTP (local OTel only)
  batchIntervalMs: 5000,         // flush after N milliseconds idle
  batchSize: 50,                 // flush when N events queued
  otelExporter: "none",          // "none" | "console" | "otlp"
  otelEndpoint: "http://localhost:4318",
  loopDetection: true,           // collect loop signals (raw, backend decides)
  loopDetectionWindow: 5,        // signal window size
  toolValidation: false,         // emit tool definitions for backend validation
});
```

Returns a `SyrinSDKInstance` with additional methods (see below).

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `SYRIN_API_KEY` | Your Syrin API key | *(required)* |
| `SYRIN_BACKEND_URL` | Backend URL | `https://api.syrin.dev` |
| `SYRIN_AGENT_ID` | Agent identifier | `None` |
| `SYRIN_DEBUG` | Verbose logging | `false` |
| `SYRIN_CAPTURE_CONTENT` | Include prompt/response in spans | `false` |
| `SYRIN_OFFLINE` | Skip all HTTP calls | `false` |
| `SYRIN_OTEL_EXPORTER` | `console`, `otlp`, or `none` | `none` |
| `SYRIN_OTEL_ENDPOINT` | OTLP collector endpoint | `http://localhost:4318` |
| `SYRIN_BATCH_INTERVAL_MS` | Flush interval (ms) | `5000` |
| `SYRIN_BATCH_SIZE` | Events per flush | `50` |

---

## Remote Configuration

The backend can update your agent's parameters without any code changes.
When the SDK posts events to `/ingest`, the response may include `config_updates`.
Those updates are applied transparently to the very next call.

```typescript
// Your code stays exactly the same across all calls:
const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [...],
  temperature: 0.7,    // backend may override this
  max_tokens: 500,     // backend may override this
});
```

**Supported config keys:** `temperature`, `max_tokens`, `model`, `system_prompt`,
`disabled_tools`, `enabled_tools`.

Try it live with the mock backend:

```bash
curl -X POST http://localhost:4318/control/config \
     -H 'Content-Type: application/json' \
     -d '{"temperature": 0.1, "model": "gpt-4o-mini"}'
```

### Local Overrides

Override config locally — takes priority over remote config:

```typescript
// Set a local override for a session
sdk.configure({ temperature: 0.2 });

// Clear an override (reverts to remote config or call default)
sdk.configure({ temperature: null });

// Read the currently active config
const active = sdk.activeConfig();
console.log(active); // { temperature: 0.2, ... }
```

---

## Hooks

React to backend events without polling:

```typescript
import { onConfigChange, onAlert, init } from "@syrin/sdk";

// Register before or right after init()
onConfigChange((sessionId, updates) => {
  console.log(`Config changed for ${sessionId}:`, updates);
});

onAlert((action) => {
  const { level, message } = action as { level: string; message: string };
  if (level === "critical") {
    pagerduty.trigger(message);
  }
  console.log(`[${level.toUpperCase()}] ${message}`);
});

await init({ apiKey: "syrin_..." });
```

---

## Governance Actions

The backend can send directives that the SDK executes before the next call.

### Stop

```typescript
import { init, GovernanceStopError } from "@syrin/sdk";

await init({ apiKey: "syrin_..." });

try {
  const response = await client.chat.completions.create({ ... });
} catch (err) {
  if (err instanceof GovernanceStopError) {
    console.log(`Agent stopped: ${err.reason}`);
    console.log(`Incident: ${err.incidentId}`);
    // perform graceful cleanup
  }
}
```

The `stop` action raises `GovernanceStopError` on the **next** intercepted call after
the backend sends it.

### Inject Message

The backend sends `{ "type": "inject_message", "role": "system", "content": "..." }`.
The SDK prepends it to the message list of the next call — no code changes needed.

### Alert

The backend sends `{ "type": "alert", "level": "warning", "message": "..." }`.
The SDK fires all registered `onAlert` callbacks.

### Checkpoint & Restore (see Checkpoints section)

---

## Checkpoints

Save and restore conversation state programmatically:

```typescript
import { init, createCheckpoint, restoreCheckpoint } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_..." });

let messages = [{ role: "user", content: "Plan a trip to Paris" }];

// Create a checkpoint before a risky operation
const cp = sdk.createCheckpoint(messages, { label: "before-tool" });
console.log(cp.checkpointId); // "ckpt_..."

// ... execute risky operation ...

// If it failed, restore
if (failed) {
  messages = sdk.restoreCheckpoint(cp.checkpointId)!;
}

// List all checkpoints for the current session
const checkpoints = sdk.listCheckpoints();
checkpoints.forEach(c => console.log(c.checkpointId, c.label));
```

The backend can also trigger checkpoint creation and restoration remotely via governance actions.
Up to 10 checkpoints per session (oldest evicted first).

---

## Tool Validation

Enable backend validation of tool calls:

```typescript
const sdk = await init({ apiKey: "syrin_...", toolValidation: true });

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [...],
  tools: [{ type: "function", function: { name: "search", ... } }],
});

if (response.choices[0].finish_reason === "tool_calls") {
  const toolCall = response.choices[0].message.tool_calls![0];

  // Available after the next ingest flush
  const result = sdk.getToolValidation(toolCall.id);
  if (result && !result.valid) {
    console.error(`Tool call rejected: ${result.error}`);
  }
}
```

---

## Multi-Agent Support

Scope individual agents to their own sessions and tag calls with workflow/swarm context:

```typescript
import { init, withAgent, withWorkflow, withSwarm } from "@syrin/sdk";
import OpenAI from "openai";

await init({ apiKey: "syrin_..." });
const client = new OpenAI();

// Agents in a sequential workflow
await withWorkflow("research-pipeline", async () => {
  const facts = await withAgent("researcher", async (ctx) => {
    console.log("run_id:", ctx.runId, "workflow:", ctx.workflowId);
    const r = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Facts about quantum computing?" }],
    });
    return r.choices[0].message.content!;
  });

  await withAgent("summariser", async () => {
    // summarise facts...
  });
});

// Agents in a parallel swarm
await withSwarm("fact-check", async (swarmCtx) => {
  console.log("swarm_id:", swarmCtx.swarmId);
  await Promise.all([
    withAgent("agent-1", async () => { /* ... */ }),
    withAgent("agent-2", async () => { /* ... */ }),
    withAgent("agent-3", async () => { /* ... */ }),
  ]);
});
```

Each agent's calls are tagged with `run_id`, `workflow_id`, and `swarm_id` in the telemetry.

### Session Scoping (lower level)

```typescript
import { withSession } from "@syrin/sdk";

// Route handler example — one session per user
app.post("/chat", async (req, res) => {
  await withSession(`user_${req.user.id}`, async () => {
    const response = await client.chat.completions.create({ ... });
    res.json(response);
  });
});
```

---

## Graceful Shutdown

Always call `shutdown()` before process exit to flush remaining events:

```typescript
import { shutdown } from "@syrin/sdk";

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

// Or use the instance returned by init():
const sdk = await init({ apiKey: "syrin_..." });
// ...
await sdk.shutdown();
```

---

## Mock Backend (Development)

Run a local backend to see all SDK traffic during development:

```bash
npm run mock-backend
# Starts at http://localhost:4318
```

Point your app at it:

```bash
SYRIN_BACKEND_URL=http://localhost:4318 SYRIN_API_KEY=test npx tsx my-agent.ts
```

**Mock backend endpoints:**

| Method | Path | Description |
|---|---|---|
| `POST` | `/ingest` | Receives SDK events |
| `GET` | `/events` | Inspect all received events |
| `POST` | `/control/config` | Inject `config_updates` |
| `DELETE` | `/control/config` | Clear pending config |
| `POST` | `/control/governance` | Inject governance actions |
| `DELETE` | `/control/governance` | Clear pending governance |
| `GET` | `/health` | Status check |

Inject a governance stop:

```bash
curl -X POST http://localhost:4318/control/governance \
     -H 'Content-Type: application/json' \
     -d '{"actions": [{"type": "stop", "reason": "loop detected", "incident_id": "inc_001"}]}'
```

---

## OpenTelemetry

Export spans to any OTLP-compatible collector:

```typescript
await init({
  apiKey: "syrin_...",
  otelExporter: "otlp",
  otelEndpoint: "http://localhost:4318",  // Jaeger, Grafana Tempo, etc.
});
```

Print spans to console for local debugging:

```typescript
await init({ apiKey: "syrin_...", otelExporter: "console" });
```

See `docs/otel-reference.md` for the full span schema.

---

## Running the Examples

```bash
# Set your keys
export OPENAI_API_KEY=sk-...
export SYRIN_BACKEND_URL=http://localhost:4318
export SYRIN_API_KEY=syrin_test

# 01 — Basic chat
npx tsx examples/01-basic-chat.ts

# 02 — Streaming
npx tsx examples/02-streaming.ts

# 03 — Remote config (watch config_updates apply live)
npx tsx examples/03-remote-config.ts

# 04 — Multi-agent workflow + swarm
npx tsx examples/04-multi-agent.ts
```

---

## Running the Tests

```bash
cd syrin-sdk-ts
npm install
npm test
```

75 tests, no internet required.
