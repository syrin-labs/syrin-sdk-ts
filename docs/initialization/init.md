---
title: "init() Reference"
description: "Complete reference for all parameters of init() — types, defaults, environment variable fallbacks, and behaviour notes."
weight: 10
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
- The SDK does NOT modify LLM responses — it only intercepts and records them
- captureContent defaults to false — prompts/completions are NOT sent unless explicitly enabled
- GovernanceStopError is only thrown if allowStop: true — it is NOT thrown by default
- There is no module-level cfg() in TypeScript — use sdk.agent("id").cfg() instead
- openai must be imported BEFORE init() — imports after will NOT be instrumented automatically
- The SDK is fail-open — if it crashes, your LLM call still executes and returns normally
- Pre-init queue: LLM calls made before await init() resolves are queued and replayed automatically
-->

> **AI Agent Quick Reference** — The minimal correct `init()` call:
> ```typescript
> import OpenAI from "openai";           // ← LLM client import FIRST
> import { init } from "@syrin/sdk";
> const sdk = await init({ apiKey: "syrin_pk_..." }); // ← MUST await
> ```
> Common mistakes: (1) `const sdk = init(...)` without `await` — `sdk` is a `Promise`, not a `SyrinSDK`; (2) using a default import `import syrin from "@syrin/sdk"` — must use named export `{ init }`; (3) calling `init()` twice without `shutdown()` — logs a warning and reinitializes.

## The One Function That Runs the Whole Show

`init()` is the entry point for the Syrin TypeScript SDK. It returns a `SyrinSDK`, patches all AI libraries already loaded in the process, registers the agent schema with the backend, and starts background workers for telemetry batching, heartbeat, and config delivery via SSE.

```typescript
import OpenAI from "openai";
import { init } from "@syrin/sdk";

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "my-agent",
});

const openai = new OpenAI();
// All openai.chat.completions.create() calls are now automatically captured
```

> ⚠️ **Skip `await` on `init()` and:** `sdk` is a `Promise<SyrinSDK>`, not a `SyrinSDK`. Calling `sdk.agent(...)` throws `TypeError: sdk.agent is not a function`. This is the most common mistake.

Calling `init()` a second time with the same `instanceName` logs a warning, shuts down the existing instance, and reinitializes. Call `shutdown()` explicitly first if you need a controlled teardown.

---

## Function Signature

```typescript
async function init(options?: SyrinInitOptions): Promise<SyrinSDK>

interface SyrinInitOptions {
  // Authentication
  apiKey?: string;                // default: process.env.SYRIN_API_KEY

  // Identity
  agentId?: string;               // default: process.env.SYRIN_AGENT_ID
  sessionId?: string;             // default: auto-generated "ses_..."

  // Network
  backendUrl?: string;            // default: "https://app.syrin.ai"

  // Observability
  otelExporter?: 'none' | 'console' | 'otlp';  // default: 'none'
  otelEndpoint?: string;          // default: 'http://localhost:4318'
  captureContent?: boolean;       // default: false
  debug?: boolean;                // default: false

  // Behavior
  offline?: boolean;              // default: false
  batchSize?: number;             // default: 100
  idleFlushMs?: number;           // default: 10000
  sessionTtlMs?: number;          // default: undefined (disabled)

  // Governance opt-ins
  governance?: {
    allowStop?: boolean;          // default: false
    allowInjectMessage?: boolean; // default: false
  };

  // Multi-agent
  agents?: string[] | Record<string, { description?: string; sections?: Record<string, unknown> }>;
  topology?: AgentTopology;

  // Named instances
  instanceName?: string;          // default: 'default'
}
```

---

## Common Mistakes

| Mistake | What happens | Fix |
|---------|-------------|-----|
| `const sdk = init(...)` (no `await`) | `sdk` is a `Promise` — all method calls throw | Add `await` |
| `import syrin from "@syrin/sdk"` | `syrin` is `undefined` — named exports only | Use `import { init } from "@syrin/sdk"` |
| `init()` after constructing OpenAI client | Fine — but any LLM call *before* `await init()` resolves will be queued | Move LLM calls after `await init()` |
| Calling `init()` twice (same `instanceName`) | Warning logged, instance torn down and reinitialized | Call `await shutdown()` first |
| Missing `SYRIN_API_KEY` and no `apiKey` option | `init()` throws `SetupError: SYRIN_API_KEY is required` | Set env var or pass `apiKey` |

---

## Parameters

### `apiKey` — Authentication

| Type | Default | Env var |
|------|---------|---------|
| `string` | `undefined` | `SYRIN_API_KEY` |

Your Syrin API key. Required — `init()` throws `SetupError` if no key is found in either the option or the environment.

```typescript
// From option
const sdk = await init({ apiKey: "syrin_pk_abc123" });

// From environment (preferred for production)
// export SYRIN_API_KEY=syrin_pk_abc123
const sdk = await init();
```

---

### `agentId` — Agent Identity

| Type | Default | Env var |
|------|---------|---------|
| `string` | `undefined` | `SYRIN_AGENT_ID` |

The agent identifier shown in the dashboard. Used as the namespace root for all config fields and telemetry. Valid characters: `a-z A-Z 0-9 - _ . @ :`, max 128 characters.

Omitting `agentId` is allowed — the SDK emits a warning and uses an anonymous namespace. For production, always set `agentId` so the dashboard shows meaningful agent names.

```typescript
const sdk = await init({ apiKey: "...", agentId: "customer-support-bot" });
```

---

### `backendUrl` — Backend URL

| Type | Default | Env var |
|------|---------|---------|
| `string` | `"https://app.syrin.ai"` | `SYRIN_BACKEND_URL` |

Must use HTTPS. `http://localhost` and `http://127.0.0.1` are allowed for local development. All other `http://` URLs cause `init()` to throw `SetupError`.

```typescript
// Production default (no need to set this)
const sdk = await init({ apiKey: "..." });

// Self-hosted
const sdk = await init({ apiKey: "...", backendUrl: "https://syrin.internal.acme.com" });

// Local dev mock backend
const sdk = await init({ apiKey: "...", backendUrl: "http://localhost:4318" });
```

---

### `captureContent` — Prompt/Completion Capture

| Type | Default | Env var |
|------|---------|---------|
| `boolean` | `false` | `SYRIN_CAPTURE_CONTENT` |

When `false` (the default), prompt messages and completion text are **not** transmitted — only metadata (token counts, cost, latency, model) is sent. This is PII-safe by default.

Set `true` to transmit actual prompt and completion content, enabling session replay in the dashboard.

```typescript
const sdk = await init({ apiKey: "...", captureContent: true });
```

> ⚠️ **Set `captureContent: true` without reviewing your prompts and:** sensitive personal information (names, emails, SSNs) is transmitted to Syrin's servers. Only enable this when your prompts are safe to transmit.

---

### `governance` — Governance Opt-ins

| Type | Default |
|------|---------|
| `{ allowStop?: boolean; allowInjectMessage?: boolean }` | `{ allowStop: false, allowInjectMessage: false }` |

All disruptive governance actions are opt-in. By default, governance stop actions from the backend are logged and discarded — your agent continues running.

```typescript
const sdk = await init({
  apiKey: "...",
  governance: {
    allowStop: true,           // backend can throw GovernanceStopError
    allowInjectMessage: true,  // backend can inject messages into conversations
  },
});
```

See [Governance](../control/governance) for complete handling patterns.

---

### `debug` — Debug Mode

| Type | Default | Env var |
|------|---------|---------|
| `boolean` | `false` | `SYRIN_DEBUG` |

Enables verbose logging. Logs every event emitted, config fetch results, and heartbeat confirmations. Never enable in production.

```typescript
const sdk = await init({ apiKey: "...", debug: true });
```

---

### `offline` — Offline Mode

| Type | Default | Env var |
|------|---------|---------|
| `boolean` | `false` | `SYRIN_OFFLINE` |

When `true`, all network calls are disabled. Events are queued in memory but never sent. Config polling and heartbeats are skipped. `cfg()` always returns defaults. Essential for unit tests.

```typescript
const sdk = await init({ apiKey: "test_key", offline: true });
```

---

### `batchSize` and `idleFlushMs` — Event Batching

| Option | Type | Default | Env var |
|--------|------|---------|---------|
| `batchSize` | `number` | `100` | `SYRIN_BATCH_SIZE` |
| `idleFlushMs` | `number` | `10000` | `SYRIN_IDLE_FLUSH_MS` |

Events are queued and flushed in batches. A flush is triggered when either:
- The queue reaches `batchSize` events, or
- `idleFlushMs` milliseconds pass with events in the queue

Lower both for near-real-time visibility in development:

```typescript
const sdk = await init({ apiKey: "...", batchSize: 1, idleFlushMs: 1000 });
```

Increase `batchSize` for high-throughput agents to reduce HTTP overhead:

```typescript
const sdk = await init({ apiKey: "...", batchSize: 500, idleFlushMs: 30_000 });
```

---

### `sessionTtlMs` — Session Lifetime

| Type | Default |
|------|---------|
| `number \| undefined` | `undefined` (disabled) |

Auto-removes sessions from the in-memory store after `sessionTtlMs` milliseconds. Essential for long-running HTTP servers. Without a TTL, the session store grows without bound.

```typescript
const sdk = await init({
  apiKey: "...",
  sessionTtlMs: 7_200_000, // 2 hours
});
```

> ⚠️ **Omit `sessionTtlMs` in a long-running HTTP server and:** the in-memory session store grows indefinitely, eventually causing out-of-memory crashes in high-traffic deployments.

---

### `sessionId` — Initial Session ID

| Type | Default |
|------|---------|
| `string` | auto-generated `ses_<uuid>` |

Optional initial session ID. When not provided, the SDK generates one automatically. For per-request sessions, use `withSession()` instead.

```typescript
const sdk = await init({ apiKey: "...", sessionId: "ses_manual_001" });
```

---

### `otelExporter` and `otelEndpoint` — OpenTelemetry

| Option | Type | Default | Env var |
|--------|------|---------|---------|
| `otelExporter` | `'none' \| 'console' \| 'otlp'` | `'none'` | `SYRIN_OTEL_EXPORTER` |
| `otelEndpoint` | `string` | `'http://localhost:4318'` | `SYRIN_OTEL_ENDPOINT` |

`'none'` disables OTel export. `'console'` prints spans to stdout (useful for development). `'otlp'` exports to a collector (Jaeger, Tempo, Honeycomb, Datadog, etc.).

Requires `@opentelemetry/exporter-trace-otlp-http` and `@opentelemetry/sdk-trace-node` when using `'otlp'`.

```typescript
const sdk = await init({
  apiKey: "...",
  otelExporter: "otlp",
  otelEndpoint: "http://localhost:4318",
});
```

---

### `instanceName` — Named Instances

| Type | Default |
|------|---------|
| `string` | `'default'` |

Use a unique name when running multiple independent SDK instances in the same process:

```typescript
const sdkProd    = await init({ apiKey: "prod_key",    agentId: "agent-a", instanceName: "production" });
const sdkStaging = await init({ apiKey: "staging_key", agentId: "agent-a", instanceName: "staging" });

// Retrieve by name
import { getInstance, shutdown } from "@syrin/sdk";
const prod = getInstance("production");

// Shut down individually
await shutdown("staging");
```

Module-level functions (`emit()`, `log()`, `withSession()`, etc.) always use the `'default'` instance. For non-default instances, call methods on the instance directly.

---

### `agents` and `topology` — Multi-Agent Registration

| Option | Type | Default |
|--------|------|---------|
| `agents` | `string[] \| Record<string, …>` | `undefined` |
| `topology` | `AgentTopology` | `undefined` |

`agents` registers sub-agents with the backend at init time. `topology` defines the multi-agent graph structure sent to the dashboard.

```typescript
const sdk = await init({
  apiKey: "...",
  agentId: "orchestrator",
  agents: {
    "researcher": { description: "Web research agent" },
    "writer":     { description: "Content generation agent" },
  },
  topology: {
    type: "pipeline",
    nodes: {
      "orchestrator": { role: "orchestrator" },
      "researcher":   { role: "worker" },
      "writer":       { role: "worker" },
    },
    edges: [
      { from: "orchestrator", to: "researcher" },
      { from: "researcher",   to: "writer" },
    ],
    entryPoint: "orchestrator",
    terminalNodes: ["writer"],
  },
});
```

See [Multi-Agent Systems](../agents/multi-agent) for complete patterns.

---

## Return Value

`init()` returns a `Promise<SyrinSDK>`. The `SyrinSDK` interface exposes all SDK methods. Module-level helpers (`withSession`, `emit`, `log`, etc.) delegate to the default instance automatically.

```typescript
const sdk = await init({ apiKey: "...", agentId: "my-agent" });

// Use the instance directly
sdk.emit("TASK_COMPLETE", { duration: 1200 });
sdk.agent("my-agent").field("llm.temperature", 0.7, { ge: 0, le: 2 });

// Or use module-level functions (same behavior for the default instance)
import { emit, withSession } from "@syrin/sdk";
emit("TASK_COMPLETE", { duration: 1200 });
```

---

## Module-Level Helpers

After `await init()`, these module-level functions are available:

| Function | Signature | Description |
|----------|-----------|-------------|
| `getInstance(name?)` | `(name?: string) => SyrinSDK \| null` | Return a named SDK instance |
| `shutdown(name?)` | `async (name?: string) => void` | Flush and shut down named instance |
| `withSession(id, fn)` | `async (id: string, fn: () => Promise<T>) => Promise<T>` | Scope callback to a session |
| `withAgent(id, fn)` | `async (id: string, fn: (ctx: RunContext) => Promise<T>) => Promise<T>` | Scope callback to an agent |
| `withWorkflow(id, fn)` | `async (id: string, fn: (ctx: RunContext) => Promise<T>) => Promise<T>` | Scope callback to a workflow |
| `withSwarm(id, fn)` | `async (id: string, fn: (ctx: RunContext) => Promise<T>) => Promise<T>` | Scope callback to a swarm |
| `emit(type, data?)` | `(type: string, data?: Record<string, unknown>) => void` | Emit custom event |
| `log(msg, level?, meta?)` | `(msg: string, level?: string, meta?: Record<string, unknown>) => void` | Emit structured log |
| `checkpoint(label, meta?)` | `(label: string, meta?: Record<string, unknown>) => void` | Emit checkpoint event |
| `getSessionId()` | `() => string` | Get current active session ID |
| `healthCheck()` | `async () => Promise<boolean>` | Check backend reachability |
| `diagnose()` | `() => SyrinDiagnostics \| null` | Get live diagnostic snapshot |
| `refreshSchema(name?)` | `async (name?: string) => void` | Re-push agent schema to backend |
| `mountConfigEndpoint(name?)` | `(name?: string) => RequestHandler` | Returns config push webhook handler |
| `configure(overrides, sessionId?)` | `(overrides: Record<string, unknown>) => void` | Apply local config overrides |

---

## Error Handling

`init()` throws `SetupError` (a subclass of `SyrinError`) for configuration errors:

```typescript
import { SetupError } from "@syrin/sdk";

try {
  const sdk = await init(); // no apiKey
} catch (err) {
  if (err instanceof SetupError) {
    console.error(err.message); // "SYRIN_API_KEY is required..."
  }
}
```

Network errors during registration are non-fatal — `init()` succeeds and the SDK operates in a degraded state (local defaults only, events queued for retry) until the backend becomes reachable.

---

## Clean Shutdown

In long-running servers, call `shutdown()` on exit to flush buffered events before the process dies:

```typescript
import { init, shutdown } from "@syrin/sdk";

const sdk = await init({ apiKey: "...", agentId: "my-agent" });

process.on("SIGTERM", async () => {
  await shutdown();   // flushes all pending events
  process.exit(0);
});

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
```

Short-lived scripts flush automatically via a `beforeExit` handler registered by the SDK. Long-running servers should always call `shutdown()` explicitly on exit signals.

> ⚠️ **Skip `shutdown()` in a long-running server and:** up to `batchSize` events (default 100) may be lost on process exit because the queue never flushed.

---

## Pre-Init Queue (TypeScript-only Feature)

The SDK maintains a pre-init queue. If any LLM call fires after `import OpenAI from "openai"` but before `await init()` resolves, the call still executes normally (fail-open), and the resulting telemetry event is queued and replayed once `init()` completes.

This means module-level OpenAI imports are always safe:

```typescript
import OpenAI from "openai";  // ← safe — imports LLM client
import { init } from "@syrin/sdk";

// Any code here that calls openai is fine — events will be replayed
const openai = new OpenAI();

// Now init
const sdk = await init({ apiKey: "syrin_pk_..." });
// Pre-init queue replayed here — any LLM events fired between
// the import and this line are now sent to Syrin
```

See [Lazy Init](./lazy-init) for the full explanation.
