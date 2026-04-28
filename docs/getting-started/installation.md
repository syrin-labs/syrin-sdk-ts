---
title: "Installation"
description: "Install @syrin/sdk and configure environment variables. Node.js 18+ required."
weight: 2
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

> **AI Agent Quick Reference** — Minimum installation:
> ```bash
> npm install @syrin/sdk
> ```
> Then in your code:
> ```typescript
> import OpenAI from "openai";           // ← import LLM clients first
> import { init } from "@syrin/sdk";
> const sdk = await init({ apiKey: "syrin_pk_..." }); // ← MUST await
> ```
> Common mistakes: (1) using a default import `import syrin from "@syrin/sdk"` — must use named imports; (2) setting `SYRIN_API_KEY` after the process starts — the SDK reads `process.env` during `init()`; (3) running on Node 16 — requires Node.js 18+.

## Install Once, Instrument Everywhere

`@syrin/sdk` is a single package with no required peer dependencies beyond Node.js 18. Install it, call `await init()`, and every OpenAI call in your process is automatically captured — no adapters, no wrappers, no per-call changes.

---

## Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | **18 or newer** |
| TypeScript | 5.0+ (optional — works with plain JS) |
| `openai` | >= 4.0.0 (peer dependency, optional) |
| `@anthropic-ai/sdk` | Any (peer dependency, optional) |
| `@google/generative-ai` or `@google/genai` | Any (peer dependency, optional) |
| `fetch` | Built-in from Node 18 — no polyfill needed |

The SDK enforces the Node version at runtime and throws a clear error if you are on Node 16 or below.

> ⚠️ **Skip the Node 18 requirement and:** `init()` will throw `SetupError: Node.js 18+ is required`. This is checked at startup, not at install time.

---

## Installing

**npm:**
```bash
npm install @syrin/sdk
```

**pnpm:**
```bash
pnpm add @syrin/sdk
```

**yarn:**
```bash
yarn add @syrin/sdk
```

**bun:**
```bash
bun add @syrin/sdk
```

---

## TypeScript Configuration

The SDK ships with full TypeScript types. No `@types/` package is needed.

Minimum `tsconfig.json` requirements:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true
  }
}
```

**Why `ES2022`?** The SDK uses `AsyncLocalStorage` which requires ES2022+ for proper type checking. Targeting below ES2022 still works at runtime but TypeScript may report type errors.

**For `@tunable` decorator support**, add:
```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

Or if using esbuild/Vite, set `target: "es2022"` in your build config — the decorator transform is included automatically.

---

## Verifying Installation

Run this snippet to confirm the package is correctly installed and exports what you expect:

```typescript
import { init } from "@syrin/sdk";
console.log(typeof init);           // "function"
console.log(init.constructor.name); // "AsyncFunction" — confirms it's async
```

To confirm the SDK can reach your backend, run a health check:

```typescript
import { init, shutdown, healthCheck } from "@syrin/sdk";

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  agentId: "health-check-test",
  debug: true,  // logs connection details to console
});

const ok = await healthCheck();
console.log(`Backend reachable: ${ok}`);
// → Backend reachable: true

await shutdown();
```

If the connection fails, check:
1. `SYRIN_API_KEY` is set and starts with `syrin_pk_`
2. The backend URL is reachable (`curl https://app.syrin.ai/api/v1/health`)
3. No firewall blocks outbound HTTPS to `app.syrin.ai`

---

## Environment Variables

The SDK reads configuration from environment variables as fallbacks when parameters are not passed to `init()`. All values are read during `init()` — set them before the process starts.

| Variable | Description | Default |
|----------|-------------|---------|
| `SYRIN_API_KEY` | Your Syrin API key (required unless passed to `init()`) | — |
| `SYRIN_BACKEND_URL` | Backend URL | `https://app.syrin.ai` |
| `SYRIN_AGENT_ID` | Agent identifier | — |
| `SYRIN_CAPTURE_CONTENT` | `"true"` to capture prompts/completions | `"false"` |
| `SYRIN_DEBUG` | `"true"` for verbose SDK logging to console | `"false"` |
| `SYRIN_OTEL_EXPORTER` | `"none"`, `"console"`, or `"otlp"` | `"none"` |
| `SYRIN_OTEL_ENDPOINT` | OTLP collector endpoint | `http://localhost:4318` |
| `SYRIN_OFFLINE` | `"true"` to disable all HTTP (useful in tests) | `"false"` |
| `SYRIN_IDLE_FLUSH_MS` | Flush the event queue after N ms of inactivity | `10000` |
| `SYRIN_BATCH_SIZE` | Flush immediately when N events are queued | `100` |
| `SYRIN_HTTP_TIMEOUT_MS` | HTTP timeout for `/ingest` in ms | `10000` |
| `SYRIN_HEARTBEAT_TIMEOUT_MS` | Heartbeat POST timeout in ms | `5000` |
| `SYRIN_HEARTBEAT_INTERVAL_MS` | Heartbeat interval in ms | `30000` |
| `SYRIN_MAX_QUEUE_SIZE` | Max in-memory events before oldest are dropped | `1000` |

### Setting Environment Variables in Local Development

Use a `.env` file with `dotenv`:

```bash
npm install dotenv
```

```bash
# .env
SYRIN_API_KEY=syrin_pk_abc123...
SYRIN_BACKEND_URL=https://app.syrin.ai
SYRIN_AGENT_ID=my-travel-agent
SYRIN_CAPTURE_CONTENT=false
```

```typescript
import "dotenv/config";          // ← load .env BEFORE importing @syrin/sdk
import OpenAI from "openai";
import { init } from "@syrin/sdk";

// apiKey and agentId are read from process.env automatically
const sdk = await init();
```

> ⚠️ **Skip loading dotenv before `init()` and:** `init()` will throw `SetupError: SYRIN_API_KEY is required` even though your `.env` file contains the key — because `process.env` was not populated when `init()` ran.

### Production Deployment

**Docker / docker-compose:**
```yaml
environment:
  SYRIN_API_KEY: ${SYRIN_API_KEY}
  SYRIN_BACKEND_URL: https://app.syrin.ai
  SYRIN_AGENT_ID: travel-orchestrator
```

**Kubernetes:**
```yaml
env:
  - name: SYRIN_API_KEY
    valueFrom:
      secretKeyRef:
        name: syrin-secrets
        key: api-key
  - name: SYRIN_AGENT_ID
    value: travel-orchestrator
```

---

## Getting an API Key

1. Go to [app.syrin.ai](https://app.syrin.ai)
2. Sign in or create an account
3. Navigate to **Settings > API Keys**
4. Click **Create Key** — copy the `syrin_pk_...` value immediately (shown only once)

Your API key authenticates both event ingest and config fetch requests. Never commit it to source control.

---

## URL Configuration

### Production Backend

The default backend (`https://app.syrin.ai`) works out of the box. You do not need to set `SYRIN_BACKEND_URL` for the hosted service.

### Self-Hosted Backend

```bash
SYRIN_BACKEND_URL=https://syrin.internal.yourcompany.com
```

The SDK normalizes the URL: trailing slashes and `/api/v1` suffixes are stripped, then `/api/v1` is appended for all requests. These are all equivalent:

```typescript
await init({ apiKey: "...", backendUrl: "https://app.syrin.ai" });
await init({ apiKey: "...", backendUrl: "https://app.syrin.ai/" });
await init({ apiKey: "...", backendUrl: "https://app.syrin.ai/api/v1" });
```

### Local Development

For `http://localhost`, the SDK accepts plain HTTP without extra configuration:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  backendUrl: "http://localhost:3000",
});
```

`http://127.0.0.1` and `http://localhost` are both treated as safe local addresses. All other `http://` (non-HTTPS) URLs will cause `init()` to throw — use HTTPS in non-local environments.

---

## Optional Dependencies

The core package has no optional installs — framework integrations are peer dependencies that the SDK detects at runtime.

| Integration | Install command | Notes |
|-------------|----------------|-------|
| OpenAI instrumentation | `npm install openai` | Auto-detected on `init()` |
| Anthropic instrumentation | `npm install @anthropic-ai/sdk` | Auto-detected on `init()` |
| Gemini instrumentation | `npm install @google/generative-ai` or `@google/genai` | Auto-detected on `init()` |
| OpenTelemetry OTLP export | `npm install @opentelemetry/exporter-trace-otlp-http @opentelemetry/sdk-trace-node` | Required only if `otelExporter: "otlp"` |

All integrations are optional. The SDK never throws at import time because a peer dependency is absent — it silently skips that instrumentation path.

---

## Proxy and Firewall Considerations

Syrin makes outbound HTTPS connections to these endpoints:

- `POST {backendUrl}/api/v1/sessions/{id}/ingest` — telemetry events (batched)
- `GET {backendUrl}/api/v1/agents/{id}/stream` — SSE config delivery
- `GET {backendUrl}/api/v1/agents/{id}/overrides` — config polling fallback
- `POST {backendUrl}/api/v1/agents/{id}/heartbeat` — keepalive (every 30s)

If your environment uses an outbound HTTP proxy, set `HTTPS_PROXY`. Node's built-in `fetch` does not honor this automatically — use a proxy agent or configure your network layer for containerized environments.

---

## Uninstalling

```bash
npm uninstall @syrin/sdk
```

The SDK writes one optional file during normal operation — the persisted config cache at `.syrin/syrin.config.json`. Remove it for a clean slate:

```bash
rm -rf .syrin/
```
