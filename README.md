# @syrin/sdk

**AI agent observability and remote configuration for TypeScript/Node.js.**

Syrin automatically instruments your AI library calls with zero changes to your existing code.
Just import your AI libraries, call `init()`, and every LLM call is fully observed.

## Features

- **Zero-friction setup** — one `await init()` call instruments everything
- **Auto-detection** — SDK detects which AI libraries you actually use and instruments them automatically
- **Multi-provider** — OpenAI, Anthropic, LangChain, LangGraph, Mastra, Vercel AI SDK
- **OpenTelemetry native** — emits `gen_ai.*` standard spans + `syrin.*` extensions
- **Remote configuration** — backend can push temperature/max_tokens/model overrides live
- **Session scoping** — per-user/per-request session isolation via `AsyncLocalStorage`
- **Streaming support** — streaming completions fully instrumented
- **Batched event delivery** — efficient HTTP batching with retry and backpressure
- **Cost tracking** — per-call and cumulative cost estimation for 20+ models
- **Governance** — backend can stop, alert, inject messages, or trigger checkpoints

## Quick Start

```bash
npm install @syrin/sdk openai
```

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";

// One line — SDK detects the OpenAI import and instruments it automatically
await init({ apiKey: "syrin_..." });

// All your existing code works unchanged
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
```

That's it. No adapter lists, no extra configuration. The SDK sees that `openai` is loaded in
your process and instruments it automatically.

## How Auto-Detection Works

When you call `await init()`, the SDK:

1. Scans `require.cache` for any AI libraries already loaded in the process.
2. Installs a `Module._load` hook to detect libraries loaded after `init()`.
3. For each detected library, auto-installs the matching adapter.
4. Removes the hook cleanly on `shutdown()`.

Detection is **usage-based, not install-based**: having `langchain` installed as a package
does not trigger its adapter — actually importing/requiring it does.

**Watched libraries:** `openai`, `@anthropic-ai/sdk`, `langchain`, `@langchain/langgraph`,
`@mastra/core`, `ai` (Vercel AI SDK)

> **Note:** Auto-detection works for CJS modules (what most frameworks ship). For pure
> ESM-only packages, use the explicit `adapters: [...]` option as a fallback.

When `debug: true` is set, the SDK logs which adapters were auto-installed.

## Documentation

- [Quickstart Guide](docs/quickstart.md)
- [Framework Adapters](docs/adapters.md)
- [ConfigStore, Tunable, ConfigGuard](docs/config-store.md)
- [OTel Schema Reference](docs/otel-reference.md)
- [Backend API Reference](docs/backend-api.md)

## API Reference

### `init(options): Promise<SyrinSDKInstance>`

Initialize the SDK. Returns a `SyrinSDKInstance` with methods for config, checkpoints, and lifecycle.

```typescript
const sdk = await init({
  apiKey: "syrin_...",           // Required (or SYRIN_API_KEY env var)
  agentId: "my-agent",           // Optional — max 128 chars, alphanumeric + -_.@:
  sessionId: "ses_custom",       // Optional — auto-generated if not set
  backendUrl: "https://api.syrin.dev",
  debug: false,                  // Logs auto-detected adapters and SDK activity
  captureContent: false,         // Include prompt/response text in spans
  offline: false,                // Disable all HTTP (local OTel only)
  batchIntervalMs: 5000,
  batchSize: 50,
  otelExporter: "none",          // "none" | "console" | "otlp"
  otelEndpoint: "http://localhost:4318",

  // Optional: explicit adapters (for ESM packages or custom ordering)
  // adapters: [new LangGraphAdapter()],
});
```

> `agentId` and `sessionId` are validated: max 128 characters, alphanumeric plus `-_.@:` only.
> A clear error is thrown if these constraints are violated.

### `shutdown(): Promise<void>`

Flush remaining events, remove the `Module._load` hook, and clean up.

```typescript
await shutdown();
// or: await sdk.shutdown();
```

Always call this before process exit.

### `configure(updates: ConfigUpdate): void`

Apply a local config override. Takes priority over remote config.
Valid keys: `temperature`, `max_tokens`, `model`, `system_prompt`, `top_p`,
`frequency_penalty`, `presence_penalty`. Setting any key to `null` clears it.

```typescript
import type { ConfigUpdate } from "@syrin/sdk";

sdk.configure({ temperature: 0.2, max_tokens: 1000 });
sdk.configure({ temperature: null }); // revert to remote config or call default
```

### `createCheckpoint(messages: MessageParam[], label?: string)`

Save conversation state. `MessageParam` has `role: 'user' | 'assistant' | 'system' | 'tool'`
plus typed content fields.

```typescript
import type { MessageParam } from "@syrin/sdk";

const messages: MessageParam[] = [{ role: "user", content: "Hello" }];
const cp = sdk.createCheckpoint(messages, "before-risky-op");
```

## Explicit Adapters (ESM fallback / custom ordering)

For pure ESM packages or when you need explicit control over adapter ordering, pass adapters
directly. User-provided adapters take precedence over auto-detection.

```typescript
import { init, LangGraphAdapter, LangChainAdapter } from "@syrin/sdk";

await init({
  apiKey: "syrin_...",
  adapters: [new LangGraphAdapter(), new LangChainAdapter()],
});
```

## Exported Types

```typescript
import type {
  ConfigUpdate,      // Typed object for configure()
  MessageParam,      // Typed message for createCheckpoint()
  ConfigVersion,     // { versionId, timestamp, section, changedKeys, valuesSnapshot, source }
  AuditEntry,        // { timestamp, section, key, oldValue, newValue, source, accepted, rejectionReason }
  SyrinEvent,        // Discriminated union of all 21 event interfaces
} from "@syrin/sdk";
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SYRIN_API_KEY` | — | Your Syrin API key |
| `SYRIN_AGENT_ID` | — | Agent identifier |
| `SYRIN_SESSION_ID` | — | Override session ID |
| `SYRIN_BACKEND_URL` | `https://api.syrin.dev` | Backend URL |
| `SYRIN_OTEL_EXPORTER` | `none` | `none`/`console`/`otlp` |
| `SYRIN_OTEL_ENDPOINT` | `http://localhost:4318` | OTLP endpoint |
| `SYRIN_DEBUG` | `false` | Verbose logging + adapter detection output |
| `SYRIN_CAPTURE_CONTENT` | `false` | Capture prompts/responses in spans |
| `SYRIN_OFFLINE` | `false` | Skip all HTTP calls |
| `SYRIN_BATCH_INTERVAL_MS` | `5000` | Flush interval (ms) |
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
| `POST` | `/control/governance` | Inject governance actions |
| `DELETE` | `/control/governance` | Clear pending governance |
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

When Syrin's backend returns `config_updates` in the ingest response, the SDK automatically
applies them to subsequent calls:

```json
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

# Run tests (480 tests)
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
