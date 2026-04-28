# Changelog

All notable changes to `@syrin/sdk` are documented here.

---

## [1.2.0] — 2026-04-28

### Added

- **Anthropic instrumentation** — `anthropic.messages.create` (sync, async, streaming) is now intercepted automatically on `init()`. All telemetry fields, governance actions, and remote config injection work identically to OpenAI.
- **Gemini instrumentation** — `@google/genai` (the current SDK) is instrumented for sync and async calls.
- **OTel spans for all providers** — `gen_ai.*` + `syrin.*` OpenTelemetry spans now emitted for Anthropic and Gemini calls, matching OpenAI.
- **`MultiAgentRouter`** — route multiple named agents through a single server. Wire up Express or Fastify with `.express()` / `.fastify()`. Each route is automatically scoped to its own agent context and session.
- **`AgentServer`** — pre-built HTTP handlers exposing `POST /agent/chat`, `POST /agent/run`, and `GET /agent/:agentId/health`.
- **`flush()`** — manually flush all queued events to the backend immediately.
- **`refresh_schema()`** — re-register the agent schema with the backend after adding new `field()` declarations.
- **`mount_config_endpoint()`** — returns a framework-agnostic handler for exposing a `/config` endpoint that applies remote config overrides to all active sessions.
- **Session type tagging** — `"production"`, `"chat_test"`, `"workflow_test"`, and `"simulation"` session types surface in the dashboard. Pass `syrin_session_type` in the request body or set it via `setSessionType()`.

### Changed

- **Clean public API surface** — `init()` and `getInstance()` now return the `SyrinSDK` interface instead of the internal `SyrinSDKInstance` class. Internal types (`SyrinCore`, `ConfigStore`, `NormalizedCallParams`) are no longer exported.
- **`@google/generative-ai` (legacy) support dropped** — only `@google/genai` is instrumented. The deprecated package is no longer patched or listed in `peerDependencies`.

### Fixed

- **Rate-limit handling (HTTP 429)** — emitter reads `Retry-After` and pauses all flushes for the backoff window instead of immediately re-queuing the batch.
- **Billing-limit handling (HTTP 402)** — events are dropped with a warning instead of silently re-queued.
- **Auth errors not re-queued (HTTP 401/403)** — auth failures now log a clear warning and drop the batch. Re-queuing auth errors masked the real problem.
- **Queue overflow sentinel** — when the 1,000-event queue is full, the oldest event is replaced with a `QUEUE_OVERFLOW` sentinel carrying the dropped event ID and type. Previously events were silently discarded.
- **Retry cap on re-queued batches** — failed batches are now dropped after 3 delivery attempts with a warning, preventing indefinite queue growth during backend outages.
- **`[Syrin SDK]` log prefix** — all `console.*` output now uses a consistent `[Syrin SDK]` prefix.

---

## [1.0.0] — 2026-04-26

First stable release.

### Features

- **OpenAI instrumentation** — prototype-patches `openai.chat.completions.create` (sync + streaming)
- **Remote config** — backend can push `temperature`, `max_tokens`, `model`, and custom fields mid-run
- **Governance** — `stop`, `inject_message`, `config_update`, `checkpoint`, and `restore` actions
- **AgentHandle** — per-agent config scoping via `sdk.agent("name").field(...).run()/.session()`
- **Sessions** — `AsyncLocalStorage`-scoped session lifecycle; workflow and swarm grouping
- **OTel spans** — `gen_ai.*` + `syrin.*` attributes on every LLM call
- **Config guards** — `ConfigGuard`, `ConfigFuse`, `ConfigAnchor`, `AutoRevert`
- **`@tunable`** — decorator for remotely configurable class properties

---

[1.2.0]: https://github.com/syrin-labs/syrin-sdk-ts/compare/v1.0.0...v1.2.0
[1.0.0]: https://github.com/syrin-labs/syrin-sdk-ts/releases/tag/v1.0.0
