---
title: "refreshSchema() & mountConfigEndpoint()"
description: "Push agent schema updates to the dashboard after tune(), and mount a webhook handler for config push from the dashboard."
weight: 13
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
- mountConfigEndpoint() returns a function — you call it as app.post('/syrin/config', mountConfigEndpoint())
  Do NOT call mountConfigEndpoint()(req, res) yourself
- refreshSchema() is async — it must be awaited
- The SDK does NOT modify LLM responses — it only intercepts and records them
-->

> **AI Agent Quick Reference** — After calling `tune()` to register a custom configurable field, call `await refreshSchema()` to push the new field to the dashboard:
> ```typescript
> import { tune, refreshSchema } from "@syrin/sdk";
> tune("retrieval.topK", 5, { ge: 1, le: 20 });
> await refreshSchema(); // pushes the new field to app.syrin.ai
> ```
> Common mistakes: (1) forgetting `await` on `refreshSchema()` — the push is async; (2) calling `mountConfigEndpoint()(req, res)` manually — it returns a handler function, mount it with `app.post('/syrin/config', mountConfigEndpoint())`; (3) confusing `refreshSchema()` with `agent.field()` — `field()` registers a field on an AgentHandle, `refreshSchema()` pushes the current schema to the backend.

## `refreshSchema()`

After registering custom tunable fields with `tune()`, the Syrin dashboard does not automatically know about the new fields. Call `refreshSchema()` to push the updated schema to the backend so the dashboard can render the new controls.

### Signatures

```typescript
// Module-level function (default instance)
async function refreshSchema(instanceName?: string): Promise<void>

// Instance method
sdk.refreshSchema(): Promise<void>
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `instanceName` | `string` | `'default'` | Which SDK instance to refresh |

### When to Call

Call `refreshSchema()` after:
- `tune()` — to make custom tunable fields visible in the dashboard
- Programmatically adding new config sections not declared at `init()` time

You do not need to call `refreshSchema()` after `agent.field()` — `field()` declarations are pushed to the backend automatically during `init()` and on each heartbeat.

### Examples

**After `tune()`:**

```typescript
import { init, tune, refreshSchema } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });

// Register a custom tunable field
tune("retrieval.topK", 5, { ge: 1, le: 20, description: "Max documents to retrieve" });

// Push the updated schema to the backend
await refreshSchema();
// → Dashboard now shows a slider for "retrieval.topK" under my-agent > Config
```

**Via the instance:**

```typescript
const sdk = await init({ apiKey: "syrin_pk_..." });
tune("budget.maxCostUsd", 1.0, { ge: 0.01, le: 100.0 });
await sdk.refreshSchema();
```

**For a named instance:**

```typescript
const sdkProd = await init({ apiKey: "...", instanceName: "production" });
await refreshSchema("production");
```

> ⚠️ **Skip `await` on `refreshSchema()` and:** the push may not complete before your code continues. The dashboard may not show the new field until the next heartbeat.

---

## `mountConfigEndpoint()`

`mountConfigEndpoint()` returns a request handler function that receives config pushes from the Syrin backend and applies them immediately in memory and persists them to disk (`.syrin/syrin.config.json`).

**Anti-hallucination note:** `mountConfigEndpoint()` returns a function. Mount it with `app.post('/syrin/config', mountConfigEndpoint())`. Do NOT call `mountConfigEndpoint()(req, res)` yourself in the route body — that pattern is for manual invocation, not framework mounting.

### Signature

```typescript
function mountConfigEndpoint(instanceName?: string): RequestHandler

// Where RequestHandler is:
type RequestHandler = (
  req: { body?: unknown },
  res: { status(code: number): { json(body: unknown): void }; json(body: unknown): void }
) => void
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `instanceName` | `string` | `'default'` | Which SDK instance receives the config updates |

### Request Format

The endpoint accepts a `POST` request with a JSON body of config overrides:

```json
{
  "llm.temperature": 0.5,
  "llm.model": "gpt-4o-mini",
  "prompt.systemPrompt": "You are a focused assistant."
}
```

Keys use dot-notation matching the same format as `agent.field()`. Values replace the current remote config.

### Response Format

```json
{ "ok": true, "applied": 3 }
```

Or on error:

```json
{ "ok": false, "error": "SDK not initialised" }
```

### Wiring into Express

```typescript
import express from "express";
import { init, mountConfigEndpoint } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });

const app = express();
app.use(express.json());

// Mount the config push handler
app.post("/syrin/config", mountConfigEndpoint());

app.listen(8000);
```

### Wiring into Fastify

```typescript
import Fastify from "fastify";
import { mountConfigEndpoint } from "@syrin/sdk";

const fastify = Fastify();
await fastify.register(require("@fastify/formbody"));

fastify.post("/syrin/config", async (req, reply) => {
  return mountConfigEndpoint()(req as any, reply as any);
});

await fastify.listen({ port: 8000 });
```

### Wiring into Hono

```typescript
import { Hono } from "hono";
import { mountConfigEndpoint } from "@syrin/sdk";

const app = new Hono();

app.post("/syrin/config", async (c) => {
  mountConfigEndpoint()(c.req as any, c.res as any);
  return c.res;
});
```

### What Happens on Receipt

When the endpoint receives a valid config object:

1. The config overrides are applied to the **global config template** — all new sessions inherit these values
2. The overrides are applied to all **currently active sessions** immediately
3. The overrides are **persisted to disk** at `.syrin/syrin.config.json` — they survive process restarts
4. The `applied` count in the response tells you how many keys were processed

This is the server-side complement to SSE-based real-time config delivery. If your agent is behind a firewall and SSE is not available, `mountConfigEndpoint()` lets the dashboard push config updates to your agent via webhook.

### For a Named Instance

```typescript
// Production instance receives config updates
app.post("/syrin/config/production", mountConfigEndpoint("production"));

// Staging instance receives separate config updates
app.post("/syrin/config/staging", mountConfigEndpoint("staging"));
```
