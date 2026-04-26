---
title: "Installation"
description: "Install @syrin/sdk and configure environment variables. Node.js 18+ required."
weight: 2
---

## npm install and Three Env Vars

`@syrin/sdk` is a single npm package. Its only hard runtime dependencies are the OpenTelemetry API types — everything else (OpenAI, Anthropic, LangChain) is a peer dependency. If you don't use a library, you don't pay for it.

The package ships as pure ESM. It requires Node.js 18 or newer because it depends on the built-in `fetch` API introduced in that release.

---

### Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | 18 or newer |
| TypeScript | 5.0+ (optional, works with plain JS) |
| `openai` | ≥ 4.0.0 (peer dependency, optional) |
| `fetch` | Built-in from Node 18 — no polyfill needed |

The SDK enforces the Node version at runtime and throws a clear error if you are on Node 16 or below.

---

### Installing

```bash
npm install @syrin/sdk
```

Or with yarn:

```bash
yarn add @syrin/sdk
```

Or with pnpm:

```bash
pnpm add @syrin/sdk
```

Verify the install by checking the version in `package.json`:

```bash
node -e "import('@syrin/sdk').then(m => console.log('Syrin SDK loaded'))"
```

Or from TypeScript after building:

```typescript
import { init } from "@syrin/sdk";
// If this resolves without error, the package is installed correctly
```

---

### Environment Variables

The SDK reads configuration from environment variables as fallbacks when parameters are not passed to `init()`. Set these in your `.env`, deployment manifest, or shell profile.

| Variable | Description | Default |
|----------|-------------|---------|
| `SYRIN_API_KEY` | Your Syrin API key (required) | — |
| `SYRIN_BACKEND_URL` | Backend URL | `https://app.syrin.ai` |
| `SYRIN_AGENT_ID` | Agent identifier | — |
| `SYRIN_CAPTURE_CONTENT` | `"true"` to capture prompts/completions | `"false"` |
| `SYRIN_DEBUG` | `"true"` for verbose SDK logging to console | `"false"` |
| `SYRIN_OTEL_EXPORTER` | `"none"`, `"console"`, or `"otlp"` | `"none"` |
| `SYRIN_OTEL_ENDPOINT` | OTLP collector endpoint | `http://localhost:4318` |
| `SYRIN_OFFLINE` | `"true"` to disable all HTTP (useful in tests) | `"false"` |
| `SYRIN_IDLE_FLUSH_MS` | Flush the event queue after N ms of inactivity | `10000` |
| `SYRIN_BATCH_SIZE` | Flush immediately when N events are queued | `100` |

#### Setting Environment Variables

For local development, use a `.env` file with `dotenv`:

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
import "dotenv/config"; // loads .env before anything else
import { init } from "@syrin/sdk";

// apiKey and agentId are read from the environment automatically
const sdk = await init({ backendUrl: "https://app.syrin.ai" });
```

> Load `dotenv` **before** importing `@syrin/sdk`. The SDK reads `process.env` during `init()`, so values must be populated beforehand.

For production (Docker, Kubernetes):

```yaml
# docker-compose.yml
environment:
  SYRIN_API_KEY: ${SYRIN_API_KEY}
  SYRIN_BACKEND_URL: https://app.syrin.ai
  SYRIN_AGENT_ID: travel-orchestrator
```

```yaml
# Kubernetes deployment
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

### Getting an API Key

1. Go to [app.syrin.ai](https://app.syrin.ai)
2. Sign in or create an account
3. Navigate to **Settings → API Keys**
4. Click **Create Key** — copy the `syrin_pk_...` value immediately (shown only once)

Your API key authenticates both event ingest and config fetch requests. Treat it as a secret — do not commit it to source control.

---

### URL Configuration

#### Production Backend

The default backend (`https://app.syrin.ai`) works out of the box. You do not need to set `SYRIN_BACKEND_URL` for the hosted service.

#### Self-Hosted Backend

If you're running Syrin on-premises:

```bash
SYRIN_BACKEND_URL=https://syrin.internal.yourcompany.com
```

The SDK automatically normalizes the URL: trailing slashes and `/api/v1` suffixes are stripped, then `/api/v1` is appended for all requests. The following are all equivalent:

```typescript
await init({ apiKey: "...", backendUrl: "https://app.syrin.ai" });
await init({ apiKey: "...", backendUrl: "https://app.syrin.ai/" });
await init({ apiKey: "...", backendUrl: "https://app.syrin.ai/api/v1" });
```

#### Local Development

For `http://localhost`, the SDK accepts plain HTTP without extra configuration:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  backendUrl: "http://localhost:3000",
});
```

`http://127.0.0.1` and `http://localhost` are both treated as safe local addresses. All other `http://` (non-HTTPS) URLs will cause `init()` to throw — use HTTPS in non-local environments.

---

### Verifying the Installation

Run this snippet to confirm the SDK can reach your backend:

```typescript
import { init, shutdown } from "@syrin/sdk";

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  agentId: "health-check-test",
  debug: true, // logs connection details to console
});

// Emit a test event and flush it — if you see it arrive in the dashboard,
// the connection is confirmed
sdk.emit("HEALTH_CHECK", { source: "install-verification" });
await sdk.flush();

console.log("Syrin SDK connected successfully");
await shutdown();
```

If the connection fails, check:
1. `SYRIN_API_KEY` is set and starts with `syrin_pk_`
2. The backend URL is reachable from your network (`curl https://app.syrin.ai/api/v1/health`)
3. No firewall blocks outbound HTTPS to `app.syrin.ai`

---

### Optional Dependencies

The core package has no optional installs — framework integrations are peer dependencies that the SDK detects at runtime.

| Integration | Install command | Notes |
|-------------|----------------|-------|
| OpenAI instrumentation | `npm install openai` | Auto-detected; nothing else needed |
| Anthropic instrumentation | `npm install @anthropic-ai/sdk` | Uses `AnthropicAdapter` |
| LangGraph instrumentation | `npm install @langchain/langgraph` | Uses `LangGraphAdapter` |
| LangChain instrumentation | `npm install @langchain/core` | Uses `LangChainAdapter` |
| OpenTelemetry OTLP export | `npm install @opentelemetry/exporter-trace-otlp-http @opentelemetry/sdk-trace-node` | Required only if `otelExporter: "otlp"` |

All integrations are optional. The SDK will never throw at import time because a peer dependency is absent — it silently skips that instrumentation path.

---

### Proxy / Firewall Considerations

Syrin makes outbound HTTPS connections to these endpoints:

- `POST {backendUrl}/api/v1/sessions/{id}/ingest` — telemetry events (batched, fired every `idleFlushMs` or when `batchSize` is reached)
- `GET {backendUrl}/api/v1/agents/{id}/overrides` — config polling (only if `configPollIntervalMs > 0`)
- `POST {backendUrl}/api/v1/agents/{id}/heartbeat` — keepalive (every 30 s)

If your environment routes traffic through an outbound HTTP proxy, set the standard `HTTPS_PROXY` environment variable. Node's built-in `fetch` does not honor this automatically — use a proxy agent or configure your network layer accordingly for containerized environments.

---

### Uninstalling

```bash
npm uninstall @syrin/sdk
```

The SDK does not write any files during normal operation except the optional persisted config cache at `.syrin/syrin.config.json`. Remove it if you want a clean slate:

```bash
rm -rf .syrin/
```
