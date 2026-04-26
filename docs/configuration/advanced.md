---
title: "Advanced Config"
description: "configPollIntervalMs, schemaDefaults, sessionTtlMs, multiple instances, batching, agentUrl, toolValidation, and topology registration."
weight: 22
---

## Fine-Grained Control for Production Deployments

This page covers the configuration options that most users don't need on day one but become essential in production: config persistence, polling, session TTL, multiple instances, and topology registration.

> **All time values use milliseconds.** The TypeScript SDK uses `Ms` suffixes (`idleFlushMs`, `sessionTtlMs`, `configPollIntervalMs`) instead of seconds.

### Config Polling

By default, the SDK fetches remote config overrides once at startup. Enable continuous polling for near-real-time updates when your agent doesn't expose an HTTP webhook:

```typescript
const sdk = await init({
  apiKey: '...',
  configPollIntervalMs: 30_000, // poll every 30 seconds
});
```

The polling timer is cleared automatically when `shutdown()` is called.

Polling is the fallback approach. The preferred approach for production is setting `agentUrl` so the dashboard can push config changes via webhook.

### Schema Defaults

Pre-seed the config schema with specific runtime defaults so the dashboard shows all your config fields immediately after `init()`:

```typescript
const sdk = await init({
  apiKey: '...',
  schemaDefaults: {
    'llm.model': 'gpt-4o',
    'llm.temperature': 0.7,
    'llm.max_tokens': 2000,
    'prompt.system_prompt': 'You are a helpful assistant.',
    'retrieval.top_k': 5,
  },
});
```

Keys use `"section.field"` dot-notation. These values appear in the dashboard immediately after `init()`.

> **Python users:** The Python SDK also has `scan_paths=` (auto-scan source files for `cfg()` calls), `config_dir=` (disk persistence), `config_update_allowlist=`, and `disable_remote_config=`. These are **not yet available** in the TypeScript SDK. Use `schemaDefaults=` to pre-populate the schema, and rely on backend-push or polling for runtime updates.

### Session TTL for Long-Running Servers

Prevent unbounded memory growth by auto-evicting stale sessions from the in-memory store:

```typescript
const sdk = await init({
  apiKey: '...',
  sessionTtlMs: 7_200_000, // evict sessions older than 2 hours
});
```

Without a TTL, the session store grows indefinitely in long-running HTTP servers that handle many users.

For high-traffic servers, use a shorter TTL (15–30 minutes):

```typescript
const sdk = await init({
  apiKey: '...',
  sessionTtlMs: 1_800_000, // 30 minutes
});
```

### Multiple SDK Instances

Run independent SDK instances in the same process — one per agent, one per tenant, or one per environment:

```typescript
const sdkProd = await init({
  apiKey: 'prod_key',
  agentId: 'travel-assistant',
  instanceName: 'production',
});

const sdkStaging = await init({
  apiKey: 'staging_key',
  agentId: 'travel-assistant',
  instanceName: 'staging',
  debug: true,
});

// Retrieve by name
import { getInstance, shutdown } from '@syrin/sdk';
const prod = getInstance('production');
const staging = getInstance('staging');

// Shut down individually
await shutdown('staging');
```

Module-level functions (`emit()`, `log()`, `withSession()`, etc.) always use the `'default'` instance. For non-default instances, call the method on the instance directly.

### Batching Tuning

For high-throughput agents, increase batch size and flush interval to reduce HTTP overhead:

```typescript
const sdk = await init({
  apiKey: '...',
  batchSize: 500,
  idleFlushMs: 30_000,
});
```

For near-real-time visibility during development:

```typescript
const sdk = await init({
  apiKey: '...',
  batchSize: 1,
  idleFlushMs: 1_000,
});
```

### Agent URL for Push Webhooks

Set the public URL of your agent's HTTP server so the Syrin dashboard can push config changes and trigger on-demand runs:

```typescript
const sdk = await init({
  apiKey: '...',
  agentId: 'travel-assistant',
  agentUrl: 'https://travel-agent.example.com',
});
```

The backend stores this URL. When you change config in the dashboard, the backend POSTs the update to `https://travel-agent.example.com/agent/run` immediately — no polling required.

### Tool Validation

Enable server-side validation of tool schemas and arguments:

```typescript
const sdk = await init({
  apiKey: '...',
  toolValidation: true,
});

// After a tool call, retrieve validation result
import { getToolValidation } from '@syrin/sdk';
const result = getToolValidation('tc_abc123');
// { valid: true } or { valid: false, error: "..." }
```

### Topology Registration

For multi-agent systems, register the full topology for dashboard visualization:

```typescript
const sdk = await init({
  apiKey: '...',
  agentId: 'orchestrator',
  agents: {
    researcher: { description: 'Web research' },
    writer: { description: 'Content writing' },
    editor: { description: 'Quality review' },
  },
  topology: {
    type: 'pipeline',
    nodes: {
      orchestrator: { role: 'orchestrator' },
      researcher: { role: 'worker', execMode: 'sequential' },
      writer: { role: 'worker', execMode: 'sequential' },
      editor: { role: 'worker', execMode: 'sequential' },
    },
    edges: [
      { from: 'orchestrator', to: 'researcher' },
      { from: 'researcher', to: 'writer' },
      { from: 'writer', to: 'editor' },
    ],
    entryPoint: 'orchestrator',
    terminalNodes: ['editor'],
  },
});

// Or define topology after init()
sdk.defineTopology({
  type: 'orchestrator',
  nodes: { ... },
  edges: [ ... ],
  entryPoint: 'orchestrator',
  terminalNodes: ['researcher', 'writer'],
});
```

Topology types: `"orchestrator"`, `"pipeline"`, `"parallel"`, `"graph"`, `"conditional_graph"`, `"hybrid"`.

### Mount Config Endpoint (Push Webhooks)

Mount a webhook handler so the dashboard can push config updates directly to your server:

```typescript
import express from 'express';
import { mountConfigEndpoint } from '@syrin/sdk';

const app = express();
app.use(express.json());

// Receives POST /syrin/config from the dashboard
app.post('/syrin/config', mountConfigEndpoint());

app.listen(8000);
```

Works with any framework that provides `req.body` and `res.status(n).json(body)`:

```typescript
// Fastify
fastify.post('/syrin/config', async (req, reply) => {
  return mountConfigEndpoint()(req, reply);
});

// Hono
app.post('/syrin/config', (c) => {
  return mountConfigEndpoint()(c.req, c.res);
});
```

### Config Refresh After `tune()`

After registering custom tunable fields with `tune()`, push the updated schema to the dashboard:

```typescript
import { tune, refreshSchema } from '@syrin/sdk';

const sdk = await init({ apiKey: '...', agentId: 'my-agent' });

// Register a custom tunable field
tune('retrieval.top_k', 5, { ge: 1, le: 20, description: 'Max documents to retrieve' });

// Push the updated schema to the backend
await refreshSchema();
```

### Onconflict / Re-init

Calling `init()` a second time with the same `instanceName` logs a warning and returns the existing instance. Call `shutdown()` first if you need a full re-initialize:

```typescript
await shutdown();
const sdk = await init({ apiKey: '...', agentId: 'my-agent' });
```
