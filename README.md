# @syrin/sdk

**AI agent observability and remote configuration for TypeScript/Node.js.**

Syrin automatically instruments your OpenAI calls with zero changes to your existing code.

## Features

- **Zero-friction setup** — two lines to instrument everything
- **Automatic instrumentation** — patches OpenAI SDK transparently
- **OpenTelemetry native** — emits `gen_ai.*` standard spans + `syrin.*` extensions
- **Remote configuration** — backend can push temperature/max_tokens/model overrides live
- **Session scoping** — per-user/per-request session isolation via `AsyncLocalStorage`
- **Streaming support** — streaming completions fully instrumented
- **Batched event delivery** — efficient HTTP batching with retry and backpressure
- **Cost tracking** — per-call and cumulative cost estimation for 20+ models

## Quick Start

```bash
npm install @syrin/sdk openai
```

```typescript
import { init } from "@syrin/sdk";

// That's it — one line
init({ apiKey: "syrin_..." });

// All your existing OpenAI code is now instrumented
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Documentation

- [Quickstart Guide](docs/quickstart.md)
- [OTel Schema Reference](docs/otel-reference.md)

## API Reference

### `init(options): SyrinSDKInstance`

Initialize the SDK and patch the OpenAI SDK.

```typescript
const sdk = init({
  apiKey: "syrin_...",           // Required (or SYRIN_API_KEY env var)
  agentId: "my-agent",           // Optional
  sessionId: "ses_custom",       // Optional: override auto-generated session ID
  backendUrl: "https://api.syrin.ai",
  otelExporter: "none",          // "none" | "console" | "otlp"
  otelEndpoint: "http://localhost:4318",
  debug: false,
  captureContent: false,
  offline: false,
  batchIntervalMs: 5000,
  batchSize: 50,
});
```

### `shutdown(): Promise<void>`

Flush remaining events and clean up.

```typescript
await shutdown();
```

### `withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T>`

Scope all OpenAI calls within `fn` to a specific session.

```typescript
await withSession("user_123", async () => {
  const response = await openai.chat.completions.create({ ... });
});
```

### `getSessionId(): string`

Get the current active session ID.

### `SyrinSDKInstance`

```typescript
sdk.sessionId    // Current session ID
sdk.config       // Active configuration
sdk.flush()      // Manually flush pending events
sdk.shutdown()   // Flush and tear down
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SYRIN_API_KEY` | — | Your Syrin API key |
| `SYRIN_AGENT_ID` | — | Agent identifier |
| `SYRIN_SESSION_ID` | — | Override session ID |
| `SYRIN_BACKEND_URL` | `https://api.syrin.ai` | Backend URL |
| `SYRIN_OTEL_EXPORTER` | `none` | `none`/`console`/`otlp` |
| `SYRIN_OTEL_ENDPOINT` | `http://localhost:4318` | OTLP endpoint |
| `SYRIN_DEBUG` | `false` | Verbose logging |
| `SYRIN_CAPTURE_CONTENT` | `false` | Capture prompts in spans |
| `SYRIN_OFFLINE` | `false` | Skip HTTP calls |
| `SYRIN_BATCH_INTERVAL_MS` | `5000` | Flush interval |
| `SYRIN_BATCH_SIZE` | `50` | Events per batch |

## Mock Backend

For local development, spin up the included mock backend:

```bash
npm run mock-backend
```

```
┌─────────────────────────────────────────────────────────┐
│  SYRIN MOCK BACKEND  •  http://localhost:4318           │
└─────────────────────────────────────────────────────────┘

[14:23:01.234] ← POST /ingest  session=ses_abc123  events=2
  LLM_CALL  gpt-4o  1250→380 tokens  $0.0213  1234ms  ✓
  LLM_CALL  gpt-4o-mini  500→200 tokens  $0.0002  456ms  ✓
[14:23:01.235] → 200 OK  { ok: true }
```

### Mock Backend Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ingest` | Receive events from SDK |
| `GET` | `/events` | View all received events |
| `POST` | `/control/config` | Queue config update for next response |
| `DELETE` | `/control/config` | Clear pending config |
| `GET` | `/health` | Health check |

Inject a config update:

```bash
curl -X POST http://localhost:4318/control/config \
     -H "Content-Type: application/json" \
     -d '{"temperature": 0.3, "max_tokens": 500}'
```

## Supported Models & Pricing

Built-in cost estimation for:

| Provider | Models |
|----------|--------|
| OpenAI | GPT-4o, GPT-4o-mini, GPT-4-turbo, GPT-3.5-turbo, o1, o1-mini, o3, o3-mini |
| Anthropic | Claude 3.5 Sonnet/Haiku, Claude 3 Opus/Sonnet/Haiku |
| Google | Gemini 1.5 Pro/Flash, Gemini 2.0 Flash |
| Others | Fallback pricing applied |

## Remote Configuration

When Syrin's backend returns `config_updates` in the ingest response, the SDK automatically applies them to subsequent calls:

```json
// Backend response
{
  "ok": true,
  "config_updates": {
    "temperature": 0.3,
    "max_tokens": 500
  }
}
```

The next call automatically uses `temperature: 0.3` and `max_tokens: 500` without any code changes.

**Safety rules:**
- o1/o3 models: `temperature` is never injected (unsupported)
- Anthropic models: `temperature` clamped to `[0, 1.0]`
- OpenAI models: `temperature` clamped to `[0, 2.0]`
- Original params object is never mutated

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Build TypeScript
npm run build

# Start mock backend
npm run mock-backend
```

## License

MIT
