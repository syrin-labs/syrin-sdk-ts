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

Add one `await init()` call. Nothing else in your codebase changes.

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";

// SDK detects the OpenAI import and instruments it automatically
await init({ apiKey: "syrin_..." });

// Your existing code works unchanged
const client = new OpenAI(); // reads OPENAI_API_KEY from env

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);
```

> **Important:** Always `await` the `init()` call. If you skip `await`, the detection hook
> may not be installed before your first import and telemetry will be silently missed.

Every call now emits a telemetry event with: model, tokens, cost, latency, session context,
conversation hashes, context utilization, and more.

---

## How Auto-Detection Works

The SDK uses a two-phase detection system so you never need to list adapters manually:

1. **Pre-init libraries** — on `init()`, the SDK scans `require.cache` for any AI libraries
   already loaded in the Node.js process.
2. **Post-init libraries** — a `Module._load` hook catches any AI library imported after
   `init()` returns.
3. The hook is removed cleanly when you call `shutdown()`.

Detection is **usage-based, not install-based**: having `langchain` in `node_modules` does
nothing. Actually `import`ing or `require()`ing it triggers the adapter.

**Watched libraries:** `openai`, `@anthropic-ai/sdk`, `langchain`, `@langchain/langgraph`,
`@mastra/core`, `ai` (Vercel AI SDK)

When `debug: true` is set, the SDK logs each auto-installed adapter:

```
[syrin] Auto-installed OpenAIAdapter (detected in require.cache)
[syrin] Auto-installed LangGraphAdapter (detected via Module._load hook)
```

> **ESM note:** Auto-detection works for CJS modules (what most frameworks ship). For pure
> ESM-only packages, use the explicit `adapters: [...]` option as a fallback
> (see the Adapters section below).

---

## init() Options

```typescript
const sdk = await init({
  apiKey: "syrin_...",           // or SYRIN_API_KEY env var
  agentId: "my-agent",           // optional label — max 128 chars, alphanumeric + -_.@:
  sessionId: "ses_custom",       // auto-generated if not set; same validation as agentId
  backendUrl: "https://...",     // where to POST events
  debug: false,                  // verbose logging + adapter detection output
  captureContent: false,         // include prompt/response text in spans
  offline: false,                // disable all HTTP (local OTel only)
  batchIntervalMs: 5000,         // flush after N milliseconds idle
  batchSize: 50,                 // flush when N events queued
  otelExporter: "none",          // "none" | "console" | "otlp"
  otelEndpoint: "http://localhost:4318",
  loopDetection: true,           // collect loop signals (raw; backend decides)
  loopDetectionWindow: 5,        // signal window size
  toolValidation: false,         // emit tool definitions for backend validation

  // Optional: explicit adapters — for ESM packages or custom adapter ordering
  // adapters: [new LangGraphAdapter()],
});
```

Returns a `SyrinSDKInstance` with additional methods (see below).

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `SYRIN_API_KEY` | Your Syrin API key | *(required)* |
| `SYRIN_BACKEND_URL` | Backend URL | `https://api.syrin.dev` |
| `SYRIN_AGENT_ID` | Agent identifier | — |
| `SYRIN_DEBUG` | Verbose logging + adapter detection | `false` |
| `SYRIN_CAPTURE_CONTENT` | Include prompt/response in spans | `false` |
| `SYRIN_OFFLINE` | Skip all HTTP calls | `false` |
| `SYRIN_OTEL_EXPORTER` | `console`, `otlp`, or `none` | `none` |
| `SYRIN_OTEL_ENDPOINT` | OTLP collector endpoint | `http://localhost:4318` |
| `SYRIN_BATCH_INTERVAL_MS` | Flush interval (ms) | `5000` |
| `SYRIN_BATCH_SIZE` | Events per flush | `50` |

---

## Multi-Provider Support

### OpenAI

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai"; // SDK detects this import

await init({ apiKey: "syrin_..." });

const client = new OpenAI();
// Automatically instrumented — no further changes needed
```

### Anthropic

```bash
npm install @anthropic-ai/sdk
```

```typescript
import { init } from "@syrin/sdk";
import Anthropic from "@anthropic-ai/sdk"; // SDK detects this import

await init({ apiKey: "syrin_..." }); // AnthropicAdapter auto-installs

const client = new Anthropic();

const message = await client.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

Anthropic-specific telemetry captured: `input_tokens`, `output_tokens`, `stop_reason`,
tool definitions using `input_schema` format, SSE streaming events.

---

## Framework Adapters

Import your framework libraries as usual — the SDK detects them automatically.

### LangGraph

```bash
npm install @langchain/langgraph @langchain/openai @langchain/core
```

```typescript
import { init } from "@syrin/sdk";
import { StateGraph, Annotation, END, START } from "@langchain/langgraph"; // auto-detected

await init({ apiKey: "syrin_..." }); // LangGraphAdapter auto-installs

// Build your graph exactly as before — SDK instruments it transparently
```

### LangChain

```bash
npm install @langchain/core @langchain/openai
```

```typescript
import { init } from "@syrin/sdk";
import { ChatOpenAI } from "@langchain/openai"; // auto-detected

await init({ apiKey: "syrin_..." }); // LangChainAdapter auto-installs
```

### Mastra

```bash
npm install @mastra/core
```

```typescript
import { init } from "@syrin/sdk";
import { Agent } from "@mastra/core"; // auto-detected

await init({ apiKey: "syrin_..." }); // MastraAdapter auto-installs
```

### Vercel AI SDK

```bash
npm install ai @ai-sdk/openai
```

```typescript
import { init } from "@syrin/sdk";
import { generateText } from "ai"; // auto-detected

await init({ apiKey: "syrin_..." }); // VercelAIAdapter auto-installs
```

For details on what each framework adapter instruments and emits, see
[docs/adapters.md](adapters.md).

---

## Explicit Adapters (ESM / custom ordering)

If you need explicit control — for pure ESM packages or specific adapter ordering — pass
adapters directly. These take precedence over auto-detection.

```typescript
import { init, LangGraphAdapter } from "@syrin/sdk";

await init({
  apiKey: "syrin_...",
  adapters: [new LangGraphAdapter()],
});
```

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
  temperature: 0.7,    // backend may override this transparently
  max_tokens: 500,     // backend may override this transparently
});
```

**Supported config keys:** `temperature`, `max_tokens`, `model`, `system_prompt`,
`top_p`, `frequency_penalty`, `presence_penalty`.

Try it live with the mock backend:

```bash
curl -X POST http://localhost:4318/control/config \
     -H 'Content-Type: application/json' \
     -d '{"temperature": 0.1, "model": "gpt-4o-mini"}'
```

### Local Overrides

Override config locally — takes priority over remote config.
`configure()` takes a typed `ConfigUpdate` object.

```typescript
import type { ConfigUpdate } from "@syrin/sdk";

// Set a local override
const update: ConfigUpdate = { temperature: 0.2, max_tokens: 1000 };
sdk.configure(update);

// Clear an override (reverts to remote config or call default)
sdk.configure({ temperature: null });

// Read the currently active config
const active = sdk.activeConfig();
console.log(active); // { temperature: 0.2, ... }
```

Valid keys for `ConfigUpdate`: `temperature`, `max_tokens`, `model`, `system_prompt`,
`top_p`, `frequency_penalty`, `presence_penalty`.

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

---

## Checkpoints

Save and restore conversation state programmatically.
`createCheckpoint()` takes a typed `MessageParam[]` array.

```typescript
import { init } from "@syrin/sdk";
import type { MessageParam } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_..." });

const messages: MessageParam[] = [
  { role: "user", content: "Plan a trip to Paris" },
];

// Create a checkpoint before a risky operation
const cp = sdk.createCheckpoint(messages, "before-tool");
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

`MessageParam` has `role: 'user' | 'assistant' | 'system' | 'tool'` plus typed content,
`name?`, and `tool_call_id?` fields.

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

Scope individual agents to their own sessions and tag calls with workflow/swarm context.
Each context function emits lifecycle events on enter and exit.

```typescript
import { init, withAgent, withWorkflow, withSwarm } from "@syrin/sdk";
import OpenAI from "openai";

await init({ apiKey: "syrin_..." });
const client = new OpenAI();

// withWorkflow emits WORKFLOW_STARTED / WORKFLOW_ENDED
await withWorkflow("research-pipeline", async () => {

  // withAgent emits AGENT_RUN_STARTED / AGENT_RUN_ENDED (with duration_ms)
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

// withSwarm emits SWARM_STARTED / SWARM_ENDED
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

Always call `shutdown()` before process exit to flush remaining events and remove
the `Module._load` hook:

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

See [docs/otel-reference.md](otel-reference.md) for the full span schema.

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

# 05 — Anthropic (requires: npm install @anthropic-ai/sdk)
npx tsx examples/05-anthropic.ts

# 06 — LangGraph (requires: npm install @langchain/langgraph @langchain/openai @langchain/core)
npx tsx examples/06-langgraph.ts

# 07 — LangChain (requires: npm install @langchain/core @langchain/openai)
npx tsx examples/07-langchain.ts

# 08 — Advanced config
npx tsx examples/08-config-advanced.ts
```

---

## Running the Tests

```bash
cd syrin-sdk-ts
npm install
npm test
```

480 tests, no internet required.

---

## ConfigStore

Built-in sections: `llm`, `langgraph`, `mastra`, `vercel_ai`.

```typescript
import { ConfigStore } from "@syrin/sdk";
import type { FieldSchema } from "@syrin/sdk";

const store = new ConfigStore();
store.registerSection("search", {
  maxResults: { name: "maxResults", type: "number", default: 10, ge: 1, le: 100 },
  provider: { name: "provider", type: "string", default: "bing",
               enum: ["bing", "google", "duckduckgo"] },
} satisfies Record<string, FieldSchema>);

store.set("search", "maxResults", 20);
```

Extended features: allowlist/blocklist per section, per-key anchors, version history,
audit log, and source tracking. See [docs/config-store.md](config-store.md).

---

## @tunable — Remote Control for Any Class

TypeScript decorators (`experimentalDecorators: true` in `tsconfig.json`, or TypeScript 5+
native decorators):

```typescript
import { tunable, TunableField } from "@syrin/sdk";

@tunable({ namespace: "processor" })
class DocumentProcessor {
  batchSize = TunableField({ default: 10, min: 1, max: 100 });
  temperature = TunableField({ default: 0.7, min: 0.0, max: 2.0 });
  provider = TunableField({ default: "openai", enum: ["openai", "anthropic"] });
}

const processor = new DocumentProcessor();
// processor.temperature === 0.7 (not a marker object)
```

## ConfigGuard — Safe Config Application

```typescript
import { ConfigGuard } from "@syrin/sdk";
import { globalRegistry } from "@syrin/sdk";

const guard = new ConfigGuard({ registry: globalRegistry });

const result = guard.safeApply("processor", { temperature: 0.3 });
console.log(result.success);    // true
console.log(result.applied);    // { temperature: 0.3 }
console.log(result.rejected);   // {}

// Snapshot → apply → restore
const anchor = guard.takeAnchor("processor", "before risky change");
guard.safeApply("processor", { temperature: 1.9 });
guard.restoreAnchor(anchor.anchorId);  // rollback
```

See [docs/config-store.md](config-store.md) for the full ConfigGuard + ConfigFuse reference.
