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

---

## Anthropic Support

The AnthropicAdapter is installed automatically by `init()`. If `@anthropic-ai/sdk` is installed, all calls to `Anthropic` and `AnthropicBedrock` are instrumented.

```bash
npm install @anthropic-ai/sdk
```

```typescript
import { init } from "@syrin/sdk";
import Anthropic from "@anthropic-ai/sdk";

await init({ apiKey: "syrin_..." }); // AnthropicAdapter auto-installs

const client = new Anthropic();

const message = await client.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

Anthropic-specific telemetry captured: `input_tokens`, `output_tokens`, `stop_reason`, tool definitions using `input_schema` format, SSE streaming events.

**Provider detection:** The SDK reads `client.baseURL` to detect third-party OpenAI-compatible providers (OpenRouter, Together AI, Groq, Fireworks, Google, Mistral, Cohere). The detected provider appears in telemetry as `provider`.

---

## Framework Adapters

Pass framework adapters to `init({ adapters: [...] })`.

### LangGraph

```bash
npm install @langchain/langgraph @langchain/openai @langchain/core
```

```typescript
import { init } from "@syrin/sdk";
import { LangGraphAdapter } from "@syrin/sdk";

await init({
  apiKey: "syrin_...",
  adapters: [new LangGraphAdapter()],
});
```

**Events emitted:**

| Event | When | Key fields |
|---|---|---|
| `GRAPH_EXECUTION` | Per `graph.invoke()` | `graph_id`, `duration_ms`, `did_stop_early` |
| `NODE_EXECUTION` | Per node function | `node_name`, `graph_run_id`, `input_hash`, `output_hash` |

All `LLM_CALL` events inside a graph node carry `framework=langgraph`, `graph_id`, and `node_name`.

### LangChain

```bash
npm install @langchain/core @langchain/openai
```

```typescript
import { LangChainAdapter } from "@syrin/sdk";

const adapter = new LangChainAdapter();
await init({ apiKey: "syrin_...", adapters: [adapter] });

// Method 1: inject callback handler
const handler = adapter.callbackHandler();
const result = await chain.invoke(input, { callbacks: [handler] });

// Method 2: wrap() for zero-friction
const instrumented = adapter.wrap(chain);
const result2 = await instrumented.invoke(input);  // or .stream()
```

**See `docs/adapters.md` for the full adapter reference.**

---

## ConfigStore

Built-in sections: `llm`, `langgraph`, `mastra`, `vercel_ai`.

```typescript
import { ConfigStore, FieldSchema } from "@syrin/sdk";

const store = new ConfigStore();
store.registerSection("search", {
  maxResults: { name: "maxResults", type: "number", default: 10, ge: 1, le: 100 },
  provider: { name: "provider", type: "string", default: "bing",
               enum: ["bing", "google", "duckduckgo"] },
});

const results = store.get("search", "maxResults");
store.applyUpdates({ "search.maxResults": 20 });
```

---

## @tunable — Remote Control for Any Class

TypeScript decorators (`experimentalDecorators: true` in `tsconfig.json`, or TypeScript 5+ native decorators):

```typescript
import { tunable, TunableField } from "@syrin/sdk";

@tunable({ namespace: "processor" })
class DocumentProcessor {
  @TunableField({ default: 10, min: 1, max: 100 })
  batchSize = 10;

  @TunableField({ default: 0.7, min: 0.0, max: 2.0 })
  temperature = 0.7;

  @TunableField({ default: "openai", enum: ["openai", "anthropic"] })
  provider = "openai";
}

const processor = new DocumentProcessor();
// processor.temperature === 0.7 (not a marker object)
```

## tune() — Remote Control for Third-Party Objects

```typescript
import { tune, getTune } from "@syrin/sdk";
import { z } from "zod";

tune({
  target: myVectorDb,
  namespace: "vector_db",
  fields: { topK: "number", similarityThreshold: "number" },
});

// Or with Zod schema for full validation:
const VectorSchema = z.object({
  topK: z.number().min(1).max(100).default(5),
  similarityThreshold: z.number().min(0).max(1).default(0.75),
});
tune({ target: myVectorDb, namespace: "vector_db", schema: VectorSchema });

const cfg = getTune("vector_db");  // Record<string, unknown>
```

---

## ConfigGuard — Safe Config Application

```typescript
import { ConfigGuard } from "@syrin/sdk";
import { globalRegistry } from "@syrin/sdk";

const guard = new ConfigGuard({ registry: globalRegistry });

const result = guard.safeApply("processor", { temperature: 0.3 });
console.log(result.success);    // true
console.log(result.applied);    // { temperature: 0.3 }
console.log(result.rejected);   // {}

// Reject out-of-range
const result2 = guard.safeApply("processor", { temperature: 99.0 });
console.log(result2.rejected);  // { temperature: "...exceeds maximum 2" }

// Snapshot → apply → restore
const anchor = guard.takeAnchor("processor", "before risky change");
guard.safeApply("processor", { temperature: 1.9 });   // risky
guard.restoreAnchor(anchor.anchorId);                  // rollback
```

**See `docs/config-store.md` for the full ConfigGuard + ConfigFuse reference.**

---

## Running All Examples

```bash
# Start the mock backend (includes OpenAI-compatible endpoint)
npm run mock-backend

# In another terminal:
export SYRIN_BACKEND_URL=http://localhost:4318
export SYRIN_API_KEY=syrin_test
export OPENAI_API_KEY=sk-test
export OPENAI_BASE_URL=http://localhost:4318/v1

# Phase 1 examples
npx tsx examples/01-basic-chat.ts
npx tsx examples/02-streaming.ts
npx tsx examples/03-remote-config.ts
npx tsx examples/04-multi-agent.ts

# Phase 2 examples
npx tsx examples/05-anthropic.ts       # requires: npm install @anthropic-ai/sdk
npx tsx examples/06-langgraph.ts       # requires: npm install @langchain/langgraph @langchain/openai @langchain/core
npx tsx examples/07-langchain.ts       # requires: npm install @langchain/core @langchain/openai
npx tsx examples/08-config-advanced.ts # no extra deps needed
```
