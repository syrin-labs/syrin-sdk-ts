# Changelog

All notable changes to `@syrin/sdk` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] — 2026-04-26

### Fixed

- **`MultiAgentRouter`** — `messages` array extraction now finds the last `role: "user"` message instead of stringifying the whole array as the task prompt. Fixes garbled AI responses when callers use the `messages` format.
- **`MultiAgentRouter`** — Response now includes `agent_id` field (was missing; Python SDK always returned it).
- **`SDK_VERSION`** constant in `src/config/config.ts` updated to `1.1.0` to match `package.json` (was hardcoded `0.1.0`).

---

## [1.0.0] — 2026-04-26

### Added

- **`MultiAgentRouter`** (`src/agent/router.ts`) — Routes `/agent/:agentId/run`, `/agent/:agentId/chat`, and `/agent/:agentId/health` to per-agent handler functions. Replaces the flat `AgentServer` routes as the primary routing pattern.
  - Express/Connect middleware via `.express()`
  - Fastify plugin via `.fastify()`
  - Wraps each call in `sessionStorage` + `agentStorage` `AsyncLocalStorage` context
  - Extracts `syrin_session_type` and `syrin_session_id` from request body; generates IDs when absent
  - Accepts `task`, `message`, or `messages[]` formats for chat endpoints

---

## [0.2.0] — 2026-04-26

### Added

- **`AgentServer`** (`src/agent/server.ts`) — Pre-built HTTP handlers exposing `POST /agent/chat`, `POST /agent/run`, and `GET /agent/:agentId/health`. Attach to any Express or Fastify app via `.express()` / `.fastify()`. Session type tagging (`syrin_session_type`) flows through automatically.
- **`SessionType`** union type (`"production" | "chat_test" | "workflow_test" | "simulation"`) added to `src/types.ts`. Stored on `SessionStore` and sent in every ingest payload so the dashboard can badge sessions by type.
- **`setSessionType()`** on `SessionStore` — sets the session type for a given session ID.
- **`createAgentRouter()`** exported from `src/index.ts` — convenience factory for `MultiAgentRouter`.
- **Global config template** on `SessionStore` — polled remote overrides now persist as a template so sessions created _after_ a poll immediately inherit the backend-pushed values. Previously, new `/run` requests started with empty config and missed already-fetched overrides.
- **travel-agent example** (`examples/travel-agent.ts`) — full multi-agent orchestrator (6 sub-agents) wired to an Express server using `createAgentRouter()`. Mirrors the Python SDK example exactly.

### Fixed

- Remote config polling: sessions created after a `GET /overrides` response now immediately reflect the fetched values (`setGlobalConfig()` replaces per-session patching).
- `TuneFieldDef` rich schema accepted by `tune()` — constraints (`ge`, `le`, `enum`) and `description` now spread into `FieldSchema` correctly (no phantom `constraints` key).
- `tune()` called after `init()` now auto-pushes the updated schema to the backend via the registered refresh callback.
- Mastra adapter full streaming support via the correct `MastraCore` stream API.
- Anthropic adapter: `system` prompt injected from top-level field (not `messages` array) to match Anthropic API format.
- `detectProvider` barrel re-export collision resolved by renaming `helpers.detectProvider` → `detectProviderFromModel`.
- `SEMRESATTRS_SERVICE_NAME` accessed via bracket notation for compatibility with newer `@opentelemetry/resources` versions.
- `BaggageSpanProcessor` typed through `unknown` intermediate cast to satisfy `SpanProcessor` interface mismatch.
- `ExpressRequest`/`ExpressResponse` and `FastifyInstance`/`FastifyRequest`/`FastifyReply` replaced `any` in router with minimal structural interfaces — no hard dependency on `express` or `fastify` packages.
- All 350 tests passing; ESLint and TypeScript strict checks clean.

### Changed

- Source reorganised from flat `src/*.ts` into use-case folders (`src/adapters/`, `src/agent/`, `src/config/`, `src/core/`, `src/interceptors/`, `src/observability/`, `src/tunable/`, `src/utils/`) for navigability at scale.
- Adapter base helpers (`emitLlmCallEvent`, `injectLlmConfig`, `extractTokens`) extracted into `src/adapters/base.ts` and shared across all framework adapters.

---

## [0.1.0] — 2026-04-09

### Added

**Core**

- `init(options)` — single entry point. Initialises the SDK, registers the agent with the backend (`POST /agents/:agentId/register`), applies returned `configDelta`, starts heartbeat and optional config polling.
- `SyrinCore` — central coordinator: governance enforcement, config injection, telemetry dispatch, OTel bridge, checkpoint management.
- `SessionStore` — `AsyncLocalStorage`-backed session lifecycle with `getOrCreate()`, `activeConfig()`, `applyConfigUpdate()`, `session_ids()`.
- `agent()`, `workflow()`, `swarm()` — `AsyncLocalStorage`-scoped context helpers for multi-agent tracing.
- `cfg(key, default)` — reads the active session's remote config for the current agent namespace.
- `configure(overrides)` — applies config overrides to the current session.
- `activeConfig()` — returns the current session's full config map.
- `tune(field, default, options?)` — registers a tunable field and `@tunable` decorator for class properties.
- `feedback.submit(sessionId, rating, reason?)` — submits a `thumbs_up` / `thumbs_down` rating to the backend.
- `shutdown()` — flushes the event queue and stops background threads.

**Observability**

- `Emitter` — batched event queue. Sends `LLM_CALL`, `AGENT_START`, `AGENT_END`, `TOOL_CALL`, `GOVERNANCE_ACTION`, `EXPERIMENT_ASSIGNED`, `GRAPH_EXECUTION`, `NODE_EXECUTION`, `HITL_INTERRUPT`, and custom events to `POST /ingest`.
- `OTelBridge` — exports spans via `@opentelemetry/sdk-trace-node`. Supports `"console"`, `"otlp"`, and `"none"` exporters.
- `CheckpointClient` — HTTP-backed checkpoint save/restore with in-memory fallback.
- `HeartbeatManager` — `POST /agents/:agentId/heartbeat` every 30 s; sends `stopped: true` on `shutdown()`.
- `ConfigSync` — polls `GET /agents/:agentId/overrides` on a configurable interval; applies deltas to all live sessions.

**Framework adapters** (auto-installed on `init()`)

- **OpenAI** — prototype-patches `openai.chat.completions.create` (sync + streaming). Normalises params, extracts tool definitions and call results, wraps streams.
- **Anthropic** — patches `anthropic.messages.create` (sync + streaming). Handles top-level `system` prompt field. Enriches with `FrameworkContext`.
- **LangChain** — patches `ChatOpenAI._generate` and `on_llm_start` callback. Handles sync and async code paths.
- **LangGraph** — patches `StateGraph.addNode`, `Pregel.invoke`/`ainvoke`, and `interrupt()`. Emits `GRAPH_EXECUTION`, `NODE_EXECUTION`, `HITL_INTERRUPT` events; injects remote config at node entry.
- **Mastra** — patches `Agent.prototype.generate` and `.stream`. Extracts model/provider from `agent.model`.
- **Vercel AI SDK** — patches `generateText` and `streamText`. Handles both object and stream-result forms.

**Governance**

- `GovernancePolicy` type with configurable `allowRun`, `allowConfigUpdates`, `allowCheckpoint`, `allowRestore`, `allowInjectMessage` flags.
- `GovernancePresets` — `PERMISSIVE`, `MODERATE`, `STRICT`, `AUDIT_ONLY` presets.
- Backend-driven `stop`, `config_update`, and `inject_message` actions processed from ingest responses.

**Config**

- `ConfigStore` — `get` / `set` / `watch` API for remote config values. Namespaced by agent ID.
- `ConfigGuard` — validates config changes against registered field schemas before applying.
- Remote config delta applied on `register()` response and on each poll interval.

**Types and utilities**

- `FieldSchema` type with `name`, `type`, `default`, and optional `constraints` (`ge`, `le`, `enum`) and `description`.
- `generateId(prefix)` — generates collision-resistant IDs.
- `detectProviderFromModel(model)` — infers provider name from model string.
- Full TypeScript strict mode (`"strict": true`) throughout; no `any` in public API surface.

**Testing**

- 75 unit tests at Phase 1 GA; 324 tests after Phase 2 + adapters; 350 tests at 0.2.0.
- Mock backend (`mock-backend/server.ts`) — Express server with `/ingest`, `/checkpoints`, `/agents/:id/register`, `/agents/:id/overrides` endpoints used by integration tests.
- Pre-commit checks: `tsc`, ESLint strict, no-`any` grep, `vitest`.
