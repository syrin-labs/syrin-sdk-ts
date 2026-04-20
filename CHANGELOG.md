# Changelog

All notable changes to `@syrin/sdk` (TypeScript) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [1.0.0] - 2026-04-20

First stable release of the Syrin TypeScript SDK. Zero-friction observability and
remote control for AI agents — one import, one `await init()` call, no changes
to existing agent logic.

### Added

#### Core instrumentation
- **OpenAI adapter** — patches `OpenAI.prototype.chat.completions.create` at the
  prototype level (sync, async, streaming). Captures full telemetry per call:
  model, provider, token counts, cost, finish reason, latency, and conversation hash.
- **Anthropic adapter** — patches `Anthropic.prototype.messages.create`
  (sync, async, streaming). Normalises Anthropic response format to the shared event
  schema.
- **LangChain adapter** — callback-based instrumentation via a custom handler.
  Emits `CHAIN_EXECUTION` and `LLM_CALL` events. Injects remote config via
  `RunnableConfig`. Deduplicates LLM events when the Tier 1 prototype patch is active.
- **LangGraph adapter** — patches graph invocation and node execution. Emits
  `GRAPH_EXECUTION` and `NODE_EXECUTION` events. Supports HITL checkpoints.
  Injects `recursion_limit`, `thread_id`, and other graph config.
- **Mastra adapter** — patches `Agent.generate` and `Agent.stream`. Emits `AGENT_RUN`
  events. Resolves agent instructions from async `getInstructions()`. Injects LLM
  config into Mastra's `generateOptions`.
- **Vercel AI SDK adapter** — patches `generateText`, `streamText`, and
  `generateObject`. Captures token usage from both legacy (`promptTokens`) and new
  Responses API (`inputTokens`) field names.

#### Auto-detection
- Adapters install automatically — no `adapters: [...]` argument needed.
- Libraries imported **before** `init()` are detected via `require.cache` scan.
- Libraries imported **after** `init()` are detected via a `Module._load` hook
  installed at startup and removed on `shutdown()`.
- Supported packages: `openai`, `@anthropic-ai/sdk`, `@langchain/core`,
  `@langchain/langgraph`, `@mastra/core`, `ai`, `@ai-sdk/openai`.

#### Two-Tier adapter architecture
- **Tier 1** (provider adapters) owns `LLM_CALL` events — fires once per raw API call.
- **Tier 2** (framework adapters) owns orchestration events and sets `FrameworkContext`
  via `AsyncLocalStorage` so Tier 1 can enrich events with framework metadata.
- Each async branch gets an isolated store — no cross-contamination between concurrent
  agent runs.
- Both tiers coexist without conflict; adapters are idempotent and fail-open.

#### Config system
- `ConfigStore` — namespaced, versioned, validated config sections: `llm`, `langgraph`,
  `mastra`, `vercel_ai`, `crewai`, `agno`, `ag2`, plus `agents.<id>.*` per-agent sections.
- Priority stack (highest → lowest): governance override → anchors → local → remote → defaults.
- `ConfigGuard` — wraps a config apply with health-check + auto-revert on failure.
- `ConfigFuse` — circuit breaker that stops accepting config updates after N failures.
- `ConfigAnchor` — user-locked values that survive remote config updates.
- `AutoRevert` — automatically rolls back config if a health check fails within a TTL.
- Config persistence to disk (`.syrin/config.json`) — survives process restarts.
- Config history ring buffer (default 50 versions) and audit log (default 1000 entries).

#### AgentHandle API
```typescript
const researcher = sdk.agent('researcher', { captureContent: true });
researcher
  .field('llm.temperature', 0.3, { ge: 0, le: 2 })
  .field('llm.model', 'gpt-4o')
  .field('prompt.system_prompt', 'Research thoroughly.', { multiline: true });

const ctx = await researcher.session(
  { userId: 'alice', window: 'day' },
  async (ctx) => {
    const temp = researcher.cfg('llm.temperature', 0.3) as number;
    // ... call your LLM
  }
);
```

#### Session management
- `sdk.context()` — module-level async context for session + agent scope.
- `AgentHandle.session(options, fn)` — combined session + agent scope with `userId`,
  `window`, `key` dimensions.
- `AgentHandle.run(fn)` — agent scope only (no session tracking).
- `sdk.workflow(id, fn)` / `sdk.swarm(id, fn)` — first-class workflow and swarm
  context managers with ID propagation across nested calls.
- `SessionStore` backed by `AsyncMutex` for safe concurrent access.

#### Governance protocol
- `GovernanceStopError` — thrown when the backend sends a `stop` action.
- `inject_message` — backend can prepend messages into the next LLM call.
- `alert` — fires the `onAlert` user hook with a structured payload.
- `checkpoint` / `restore` — backend-triggered conversation checkpointing.

#### Observability
- **OTel spans** — one span per LLM call with full `gen_ai.*` semantic conventions
  plus `syrin.*` extension attributes (agentId, sessionId, cost, framework, etc.).
- Span exporters: `console`, `otlp`, or `none` (default). Configurable via
  `SYRIN_OTEL_EXPORTER` and `SYRIN_OTEL_ENDPOINT` env vars.
- Batched HTTP emitter: flushes every 10 s or 100 events (whichever comes first).
  Queue of up to 1 000 events; oldest dropped on overflow. Failed POSTs re-queued once.
- 30-second heartbeat keeps the backend session alive.
- Config polling syncs remote config on a configurable interval.

#### Telemetry signals per LLM call
- `conversationHash` — SHA-256 of the full message thread (loop detection signal).
- `mutationHash` — hash of only the new messages added this turn.
- `contextUtilization` — `total_tokens / model_context_window` (0.0–1.0).
- `toolSetHash` — hash of the active tool definitions.
- `modelConfigHash` — hash of temperature, max_tokens, model, etc.
- `callDepth` — nesting depth within the current agent run.
- `traceId` / `runId` / `workflowId` / `swarmId` for distributed tracing.

#### `@tunable` decorator
- Mark class fields as remotely tunable at runtime.
- `tune("ClassName.field", value)` — override any tunable value programmatically.
- `TunableRegistry` — central registry; backend can push value changes via
  `config_updates`. Auto-refreshes config schema on `tune()` calls.

#### Schema registration
- `sdk.registerAgent(config)` — registers per-agent observability settings and
  config-field schema with the Syrin dashboard.
- `sdk.registerEndpoint(endpoint, schema)` — registers endpoint input schema
  (Zod schema or plain dict) so the dashboard can render a "Run Agent" form.
- Auto-detection of `cfg()` call defaults from source code via static scanner.

#### Developer experience
- `await init()` — single async call, all options optional, env vars as fallback.
- `sdk.shutdown()` — flushes pending events, clears intervals, removes patches.
- `sdk.configure()` — local config override, synchronous.
- `sdk.configSnapshot()` — safe, redacted debug dump of current config state.
- `mock-backend` — Express dev server that displays all SDK traffic and lets you
  inject config responses interactively.
- 8 example scripts covering every integration pattern.
- Full ESM package with `exports` map and declaration maps for IDE navigation.

#### Built-in pricing table
Model costs (USD/1M tokens) for GPT-4o, GPT-4o-mini, GPT-4-turbo, GPT-3.5-turbo,
o1, o1-mini, o3, o3-mini, Claude 3.5 Sonnet, Claude 3.5 Haiku, Claude 3 Opus.
Temperature clamping per provider (Anthropic hard-capped at 1.0; o1/o3 models exempt).

### Technical

- **721 tests** passing (Vitest, msw for mock HTTP).
- Requires Node.js ≥ 18.
- Zero required runtime dependencies beyond standard Node built-ins and
  `opentelemetry-sdk` packages.
- All adapter imports are lazy (`require()` inside `install()`) — if a library is
  not installed, its adapter silently skips installation.
- Fail-open guarantee: SDK crash never blocks the underlying LLM call.
- Published as ESM with CJS compatibility via `exports` map.

---

[Unreleased]: https://github.com/syrin-labs/syrin-sdk-ts/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/syrin-labs/syrin-sdk-ts/releases/tag/v1.0.0
