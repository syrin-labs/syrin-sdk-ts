---
title: "Advanced Config"
description: "configPollIntervalMs, schemaDefaults, sessionTtlMs, multiple instances, batching, agentUrl, toolValidation, and topology registration."
weight: 22
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
- All time values use MILLISECONDS, not seconds (idleFlushMs, sessionTtlMs, etc.)
- shutdown() is ASYNC — it returns Promise<void>, you MUST await it
- getInstance() returns null (not undefined, not throws) when the instance doesn't exist
- refreshSchema() is ASYNC — must be awaited after tune()
- mountConfigEndpoint() RETURNS a handler function — pass it to app.post(), don't call it yourself
-->

> **AI Agent Quick Reference** — The most important advanced options:
> ```typescript
> const sdk = await init({
>   apiKey: "syrin_pk_...",
>   agentId: "my-agent",
>   sessionTtlMs: 3_600_000,        // evict sessions after 1 hour
>   configPollIntervalMs: 30_000,   // poll for config every 30 seconds
>   agentUrl: "https://my-agent.example.com", // enables push webhooks
>   batchSize: 100,
>   idleFlushMs: 10_000,
> });
> ```
> Common mistakes: (1) using seconds instead of milliseconds — every time option has an `Ms` suffix; (2) calling `refreshSchema()` without `await` — the push is async and will silently not complete; (3) calling `mountConfigEndpoint()(req, res)` directly instead of passing it to `app.post()`.

## Fine-Grained Control for Production

Most applications need only `apiKey` and `agentId`. The options here become important when you're scaling up: long-running HTTP servers need session TTL; agents behind firewalls need config polling; multi-tenant setups need multiple instances.

> **All time values use milliseconds.** The TypeScript SDK uses `Ms` suffixes (`idleFlushMs`, `sessionTtlMs`, `configPollIntervalMs`, `httpTimeoutMs`, `heartbeatIntervalMs`) — never seconds.

---

## Config Polling

By default the SDK fetches remote config at `init()` time and relies on SSE for subsequent updates. Enable polling when your agent cannot maintain an SSE connection:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  configPollIntervalMs: 30_000, // poll every 30 seconds
});
```

The polling timer is cleared automatically when `shutdown()` is called.

> ⚠️ **Skip polling and no SSE and:** your agent will see only the config that was active at `init()` time. Live dashboard changes won't reach the agent until it restarts.

The preferred production approach is setting `agentUrl` so the dashboard can push config changes directly via webhook. Polling is the fallback for agents that can't receive inbound HTTP.

---

## Schema Defaults

Pre-seed the config schema so the dashboard shows all your config fields immediately after `init()`, before any user opens the dashboard:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  schemaDefaults: {
    "llm.model": "gpt-4o",
    "llm.temperature": 0.7,
    "llm.maxTokens": 2000,
    "prompt.systemPrompt": "You are a helpful assistant.",
    "retrieval.topK": 5,
  },
});
```

Keys use dot-notation `"section.field"`. These values appear in the dashboard immediately after `init()`.

> **Python vs TypeScript:** The Python SDK has `scan_paths=` (auto-scan source files for `cfg()` calls) and `config_dir=` (disk persistence). The TypeScript SDK does not have these yet. Use `schemaDefaults` to pre-populate the schema.

---

## Session TTL

The SDK keeps all active sessions in memory. Without cleanup, the in-memory store grows indefinitely in long-running HTTP servers.

Set `sessionTtlMs` to automatically evict stale sessions:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  sessionTtlMs: 3_600_000, // evict sessions older than 1 hour
});
```

For high-traffic servers:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  sessionTtlMs: 1_800_000, // 30 minutes
});
```

> ⚠️ **Skip `sessionTtlMs` in a long-running server and:** memory grows until the process crashes or gets restarted. Each user request creates a new session entry that is never cleaned up.

You can also clear sessions manually:

```typescript
import { clearStaleSessions } from "@syrin/sdk";

// Remove sessions not accessed in the last hour — call on a schedule
setInterval(() => clearStaleSessions(3_600_000), 30 * 60 * 1000);
```

---

## Multiple SDK Instances

Run independent SDK instances in the same process — one per tenant, one per environment, or one per agent role:

```typescript
import { init, getInstance, shutdown } from "@syrin/sdk";

const sdkProd = await init({
  apiKey: "prod_key",
  agentId: "travel-assistant",
  instanceName: "production",
});

const sdkStaging = await init({
  apiKey: "staging_key",
  agentId: "travel-assistant",
  instanceName: "staging",
  debug: true,
});

// Retrieve a named instance anywhere in your code
const prod = getInstance("production");    // SyrinSDKInstance | null
const staging = getInstance("staging");    // SyrinSDKInstance | null

// Shut down individually
await shutdown("staging");
await shutdown("production");
```

Module-level functions (`emit()`, `log()`, `withSession()`, etc.) always use the `"default"` instance. For non-default instances, call methods on the instance directly:

```typescript
sdkProd.emit("CHECKPOINT", { name: "step-1" });
sdkStaging.log("Debug message", "debug");
```

---

## Batching Tuning

Events are buffered in memory and flushed in two scenarios:
- The queue reaches `batchSize` events
- `idleFlushMs` milliseconds pass since the first queued event

**High-throughput production (reduce HTTP overhead):**

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  batchSize: 500,
  idleFlushMs: 30_000,
});
```

**Low-latency development (see events in real-time):**

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  batchSize: 1,
  idleFlushMs: 1_000,
});
```

**Serverless / Lambda (flush before the function returns):**

```typescript
const sdk = await init({ apiKey: "syrin_pk_..." });

// ... run agent ...

await sdk.flush();  // force flush before cold exit
```

---

## Agent URL for Push Webhooks

Set `agentUrl` to your agent's public HTTPS base URL. The Syrin backend stores this URL and pushes config updates directly to your server — no polling required:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-assistant",
  agentUrl: "https://travel-agent.example.com",
});
```

Then mount the config endpoint in your server:

```typescript
import express from "express";
import { mountConfigEndpoint } from "@syrin/sdk";

const app = express();
app.use(express.json());

// Dashboard pushes to POST /syrin/config
app.post("/syrin/config", mountConfigEndpoint());

app.listen(8000);
```

> ⚠️ **Call `mountConfigEndpoint()(req, res)` directly and:** you are calling the handler yourself, not mounting it. The correct pattern is `app.post('/syrin/config', mountConfigEndpoint())` — the return value of `mountConfigEndpoint()` is the handler function to pass to the router.

---

## Tool Validation

Enable server-side validation of tool schemas and arguments:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  toolValidation: true,
});
```

After a tool call, retrieve the validation result:

```typescript
import { getToolValidation } from "@syrin/sdk";

const result = getToolValidation("tc_abc123");
// { valid: true } or { valid: false, error: "Missing required field: destination" }
```

---

## Topology Registration

Register the full agent topology so the dashboard can render a visual graph of your multi-agent system.

Pass `topology` directly to `init()`:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "orchestrator",
  agents: {
    researcher: { description: "Web research and data gathering" },
    writer:     { description: "Content generation and drafting" },
    editor:     { description: "Quality review and refinement" },
  },
  topology: {
    type: "pipeline",
    nodes: {
      orchestrator: { role: "orchestrator" },
      researcher:   { role: "worker", execMode: "sequential" },
      writer:       { role: "worker", execMode: "sequential" },
      editor:       { role: "worker", execMode: "sequential" },
    },
    edges: [
      { from: "orchestrator", to: "researcher" },
      { from: "researcher",   to: "writer" },
      { from: "writer",       to: "editor" },
    ],
    entryPoint: "orchestrator",
    terminalNodes: ["editor"],
  },
});
```

Or define topology after `init()`:

```typescript
sdk.defineTopology({
  type: "orchestrator",
  nodes: {
    orchestrator: { role: "orchestrator" },
    researcher:   { role: "worker" },
    writer:       { role: "worker" },
  },
  edges: [
    { from: "orchestrator", to: "researcher" },
    { from: "orchestrator", to: "writer" },
  ],
  entryPoint: "orchestrator",
  terminalNodes: ["researcher", "writer"],
});
```

**Topology types:**

| Type | When to use |
|------|-------------|
| `"orchestrator"` | One coordinator dispatches to workers |
| `"pipeline"` | Agents run in sequence, output of one feeds next |
| `"parallel"` | Agents run concurrently, results merged |
| `"graph"` | Arbitrary directed graph |
| `"conditional_graph"` | Graph with conditional edge routing |
| `"hybrid"` | Mix of sequential and parallel |

---

## Config Refresh After `tune()`

`agent.field()` declarations are pushed to the backend automatically during `init()`. But `tune()` — the lower-level tunable field registration — requires an explicit `refreshSchema()` call:

```typescript
import { init, tune, refreshSchema } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });

// Register a custom tunable field
tune("retrieval.topK", 5, { ge: 1, le: 20, description: "Max documents to retrieve" });

// Push the updated schema to the backend
await refreshSchema();
// → Dashboard now shows a slider for retrieval.topK
```

> ⚠️ **Skip `await` on `refreshSchema()` and:** the push may not complete before your code continues. The dashboard may not show the new field until the next heartbeat (30 seconds).

---

## Re-Initializing the SDK

Calling `init()` a second time with the same `instanceName` logs a warning and returns the existing instance — it does not reinitialize. To fully reinitialize, call `shutdown()` first:

```typescript
import { init, shutdown } from "@syrin/sdk";

// Full reinit
await shutdown();
const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });
```

---

## Complete Parameter Reference

All `init()` options related to production configuration:

| Option | Type | Default | Env Var | Description |
|--------|------|---------|---------|-------------|
| `sessionTtlMs` | `number` | none | `SYRIN_SESSION_TTL_MS` | Auto-evict sessions older than this |
| `configPollIntervalMs` | `number` | none | `SYRIN_POLL_INTERVAL_MS` | Remote config poll interval |
| `agentUrl` | `string` | none | `SYRIN_AGENT_URL` | Agent's public URL for push webhooks |
| `batchSize` | `number` | `100` | `SYRIN_BATCH_SIZE` | Events per flush |
| `idleFlushMs` | `number` | `10000` | `SYRIN_IDLE_FLUSH_MS` | Flush interval (ms) |
| `httpTimeoutMs` | `number` | `10000` | `SYRIN_HTTP_TIMEOUT_MS` | HTTP timeout for `/ingest` |
| `heartbeatIntervalMs` | `number` | `30000` | `SYRIN_HEARTBEAT_INTERVAL_MS` | Heartbeat interval |
| `heartbeatTimeoutMs` | `number` | `5000` | `SYRIN_HEARTBEAT_TIMEOUT_MS` | Heartbeat POST timeout |
| `pollTimeoutMs` | `number` | `10000` | `SYRIN_POLL_TIMEOUT_MS` | Config poll GET timeout |
| `maxQueueSize` | `number` | `1000` | `SYRIN_MAX_QUEUE_SIZE` | Max in-memory events before oldest dropped |
| `instanceName` | `string` | `"default"` | — | Name for multiple instances |
| `toolValidation` | `boolean` | `false` | — | Enable server-side tool validation |
| `schemaDefaults` | `Record<string, unknown>` | `{}` | — | Pre-seed config schema |
| `topology` | `TopologyDefinition` | none | — | Multi-agent topology for dashboard |
