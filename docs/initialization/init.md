---
title: "init() Reference"
description: "Complete reference for all parameters of init() — types, defaults, environment variable fallbacks, and behaviour notes."
weight: 10
---

## The One Function That Runs the Whole Show

`init()` is the entry point for the Syrin TypeScript SDK. It returns a `SyrinSDKInstance`, patches all AI libraries already imported in the process, registers the agent schema with the backend, and starts background workers for telemetry batching, heartbeat, and config polling.

```typescript
import { init } from "@syrin/sdk";

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "my-agent",
});
```

**Always `await init()`.** The OpenAI patch is applied asynchronously — skipping `await` means the patch may not complete before your first LLM call and telemetry will be silently missed.

Calling `init()` a second time with the same `instanceName` logs a warning and returns the existing instance. Call `shutdown()` first if you need a full reinitialize.

---

### Function Signature

```typescript
export async function init(options: SyrinInitOptions = {}): Promise<SyrinSDKInstance>

export interface SyrinInitOptions {
  apiKey?: string;
  agentId?: string;
  sessionId?: string;
  backendUrl?: string;
  otelExporter?: 'none' | 'console' | 'otlp';
  otelEndpoint?: string;
  debug?: boolean;
  captureContent?: boolean;
  offline?: boolean;
  batchSize?: number;
  idleFlushMs?: number;
  toolValidation?: boolean;
  sessionTtlMs?: number;
  agentUrl?: string;
  instanceName?: string;
  configPollIntervalMs?: number;
  schemaDefaults?: Record<string, unknown>;
  agents?: string[] | Record<string, { description?: string; sections?: Record<string, unknown> }>;
  topology?: AgentTopology;
}
```

---

### Parameters

#### Authentication

| Option | Type | Default | Env var |
|--------|------|---------|---------|
| `apiKey` | `string` | `undefined` | `SYRIN_API_KEY` |

Your Syrin API key. Required — `init()` throws if no key is found in either the option or the environment.

```typescript
// From option
const sdk = await init({ apiKey: "syrin_pk_abc123" });

// From environment (preferred for production)
// export SYRIN_API_KEY=syrin_pk_abc123
const sdk = await init();
```

---

#### Agent Identity

| Option | Type | Default | Env var |
|--------|------|---------|---------|
| `agentId` | `string` | `undefined` | `SYRIN_AGENT_ID` |

The agent identifier shown in the dashboard. Used as the namespace root for all config fields and telemetry. Valid characters: `a-z A-Z 0-9 - _ . @ :`, max 128 characters.

```typescript
const sdk = await init({ apiKey: "...", agentId: "customer-support-bot" });
```

Omitting `agentId` is allowed — the SDK emits a warning and uses an anonymous namespace. Not recommended for production.

---

#### Backend URL

| Option | Type | Default | Env var |
|--------|------|---------|---------|
| `backendUrl` | `string` | `"https://app.syrin.ai"` | `SYRIN_BACKEND_URL` |

The Syrin backend URL. Must use HTTPS. `http://localhost` and `http://127.0.0.1` are allowed for local development.

```typescript
// Production default
const sdk = await init({ apiKey: "..." });

// Custom backend
const sdk = await init({ apiKey: "...", backendUrl: "https://syrin.internal.acme.com" });

// Local dev
const sdk = await init({ apiKey: "...", backendUrl: "http://localhost:4000" });
```

---

#### Content Capture

| Option | Type | Default | Env var |
|--------|------|---------|---------|
| `captureContent` | `boolean` | `false` | `SYRIN_CAPTURE_CONTENT` |

When `false` (the default), prompt messages and completion text are **not** transmitted to the Syrin backend — only metadata (token counts, cost, latency, model) is sent. This is PII-safe by default.

Set `true` to transmit actual prompt and completion content, enabling session replay in the dashboard.

```typescript
const sdk = await init({ apiKey: "...", captureContent: true });
```

---

#### Session

| Option | Type | Default |
|--------|------|---------|
| `sessionId` | `string` | auto-generated (`ses_<uuid>`) |

Optional initial session ID. When not provided, the SDK generates one automatically. You can scope sessions per-request with `withSession()`.

```typescript
const sdk = await init({ apiKey: "...", sessionId: "ses_manual_001" });
```

---

#### OpenTelemetry

| Option | Type | Default |
|--------|------|---------|
| `otelExporter` | `'none' \| 'console' \| 'otlp'` | `'none'` |
| `otelEndpoint` | `string` | `'http://localhost:4318'` |

`otelExporter` accepts `'none'` (disabled), `'console'` (print to stdout), or `'otlp'` (export to a collector).

```typescript
// Send spans to a local Jaeger or Tempo collector
const sdk = await init({
  apiKey: "...",
  otelExporter: "otlp",
  otelEndpoint: "http://localhost:4318",
});
```

---

#### Debug Mode

| Option | Type | Default |
|--------|------|---------|
| `debug` | `boolean` | `false` |

Enables verbose logging. Useful during development to see every event emitted, config fetch results, and heartbeat confirmations.

```typescript
const sdk = await init({ apiKey: "...", debug: true });
```

---

#### Offline Mode

| Option | Type | Default |
|--------|------|---------|
| `offline` | `boolean` | `false` |

When `true`, all network calls are disabled. Events are queued in memory but never sent. Config polling and heartbeats are skipped. `cfg()` returns defaults. Ideal for unit tests.

```typescript
const sdk = await init({ apiKey: "...", offline: true });
```

---

#### Event Batching

| Option | Type | Default |
|--------|------|---------|
| `batchSize` | `number` | `100` |
| `idleFlushMs` | `number` | `10000` |

Events are queued and flushed in batches. A flush is triggered when either:
- The queue reaches `batchSize` events, or
- `idleFlushMs` milliseconds pass with events in the queue

Lower both values for near-real-time visibility in development:

```typescript
const sdk = await init({ apiKey: "...", batchSize: 1, idleFlushMs: 1000 });
```

Increase `batchSize` for high-throughput agents to reduce HTTP overhead.

---

#### Tool Validation

| Option | Type | Default |
|--------|------|---------|
| `toolValidation` | `boolean` | `false` |

When `true`, tool definitions and call arguments are sent to the backend for schema validation. Results are available via `sdk.getToolValidation(toolCallId)`.

```typescript
const sdk = await init({ apiKey: "...", toolValidation: true });
```

---

#### Session TTL

| Option | Type | Default |
|--------|------|---------|
| `sessionTtlMs` | `number \| undefined` | `undefined` |

Auto-removes sessions from the in-memory store after `sessionTtlMs` milliseconds. Essential for long-running HTTP servers that handle many users — without this, the session store grows unboundedly.

```typescript
const sdk = await init({
  apiKey: "...",
  sessionTtlMs: 7_200_000, // 2 hours
});
```

---

#### Agent URL

| Option | Type | Default |
|--------|------|---------|
| `agentUrl` | `string \| undefined` | `undefined` |

The public HTTP URL of this agent's own server. When set, the Syrin backend stores it so the dashboard can trigger on-demand runs and push config changes directly to the agent.

```typescript
const sdk = await init({
  apiKey: "...",
  agentUrl: "https://myagent.example.com",
});
```

---

#### Multiple Instances

| Option | Type | Default |
|--------|------|---------|
| `instanceName` | `string` | `'default'` |

Name for this SDK instance. Use a unique name when running multiple independent SDK instances in the same process:

```typescript
const sdkA = await init({ apiKey: "...", agentId: "service-a", instanceName: "service-a" });
const sdkB = await init({ apiKey: "...", agentId: "service-b", instanceName: "service-b" });

// Retrieve later by name
import { getInstance } from "@syrin/sdk";
const sdkA = getInstance("service-a");
```

---

#### Config Polling

| Option | Type | Default |
|--------|------|---------|
| `configPollIntervalMs` | `number` | `0` (disabled) |

Interval in milliseconds at which the SDK polls `/agents/{id}/overrides` for remote config changes. `0` disables polling.

Enable when your agent doesn't expose an HTTP endpoint (i.e. can't receive push webhooks):

```typescript
const sdk = await init({
  apiKey: "...",
  configPollIntervalMs: 30_000, // poll every 30 seconds
});
```

---

#### Schema Defaults

| Option | Type | Default |
|--------|------|---------|
| `schemaDefaults` | `Record<string, unknown> \| undefined` | `undefined` |

Pre-seeds the config schema with runtime defaults before the first backend registration. Keys use `"namespace.field"` dot-notation.

Useful when you want the dashboard to show the agent's actual running values immediately:

```typescript
const sdk = await init({
  apiKey: "...",
  schemaDefaults: {
    "llm.model": "gpt-4o",
    "llm.temperature": 0.7,
    "prompt.system": "You are a travel assistant.",
  },
});
```

---

#### Multi-Agent Registration

| Option | Type | Default |
|--------|------|---------|
| `agents` | `string[] \| Record<string, …> \| undefined` | `undefined` |
| `topology` | `AgentTopology \| undefined` | `undefined` |

`agents` registers sub-agents with the backend at init time. Accepts a list of agent ID strings (minimal) or a record of full agent definitions:

```typescript
// List form — SDK auto-generates minimal schemas
const sdk = await init({
  apiKey: "...",
  agents: ["researcher", "writer", "editor"],
});

// Record form — full definitions
const sdk = await init({
  apiKey: "...",
  agents: {
    "researcher": { description: "Web research agent" },
    "writer": { description: "Content generation agent" },
  },
});
```

`topology` defines the multi-agent graph structure sent to the dashboard:

```typescript
const sdk = await init({
  apiKey: "...",
  agents: ["researcher", "writer"],
  topology: {
    type: "orchestrator",
    nodes: {
      "root":       { role: "orchestrator" },
      "researcher": { role: "worker", execMode: "parallel" },
      "writer":     { role: "worker", execMode: "parallel" },
    },
    edges: [
      { from: "root", to: "researcher" },
      { from: "root", to: "writer" },
    ],
    entryPoint: "root",
    terminalNodes: ["researcher", "writer"],
  },
});
```

When `topology` is omitted and `agents` is provided, the SDK auto-infers an `orchestrator` topology.

---

### Return Value

`init()` returns a `Promise<SyrinSDKInstance>`. The instance exposes all SDK methods directly, and module-level helpers (`withSession`, `cfg`, `emit`, etc.) delegate to the default instance automatically.

```typescript
const sdk = await init({ apiKey: "...", agentId: "my-agent" });

// Module-level functions use the default instance
import { withSession, emit } from "@syrin/sdk";
await withSession("u:alice", async () => {
  const model = sdk.agent("my-agent").cfg("llm.model", "gpt-4o");
  // ...
  emit("TASK_COMPLETE", { duration: 1200 });
});

// Or use the instance directly
sdk.emit("TASK_COMPLETE", { duration: 1200 });
```

---

### Module-Level Helpers

After `init()`, the following module-level functions are available:

| Function | Description |
|----------|-------------|
| `getInstance(name?)` | Return a named SDK instance (default: `'default'`) |
| `shutdown(name?)` | Flush and shut down the named instance |
| `withSession(id, fn)` | Scope a callback to a session via `AsyncLocalStorage` |
| `withAgent(id, fn)` | Scope a callback to an agent context |
| `withWorkflow(id, fn)` | Scope a callback to a workflow context |
| `emit(type, data)` | Emit a custom event on the current session |
| `cfg(key, default)` | Read a remotely-configurable value for the current agent |

---

### Error Handling

`init()` throws for configuration errors:

```typescript
try {
  const sdk = await init(); // no apiKey
} catch (err) {
  console.error(err); // "SYRIN_API_KEY is required..."
}
```

Network errors during registration are non-fatal — `init()` succeeds and the SDK operates in a degraded state (local defaults only) until the backend becomes reachable.

---

### Clean Shutdown

In long-running servers, call `shutdown()` on exit to flush buffered events:

```typescript
import { init, shutdown } from "@syrin/sdk";

const sdk = await init({ apiKey: "...", agentId: "my-agent" });

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
```

Short-lived scripts that run to completion flush automatically via a `beforeExit` handler registered by the SDK.

---

### Next Steps

- [Quickstart](../getting-started/quickstart) — full working example
- [Remote Config](../configuration/cfg) — `cfg()` in depth, field registration, `tune()`
- [Sessions & Context](../sessions/sessions) — `withSession()`, `withAgent()`, `withWorkflow()`
- [Governance](../control/governance) — stop, inject, checkpoint, restore
