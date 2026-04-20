# Changelog

All notable changes to `@syrin/sdk` (TypeScript) are documented here.

---

## [Unreleased]

## [1.0.0] - 2026-04-20

First stable release. One import, one `await init()` call — existing agent code works unchanged.

### Added

- **OpenAI instrumentation** — intercepts `chat.completions.create` (sync, async, streaming) with zero code changes
- **Auto-detection** — detects OpenAI via `require.cache` on `init()` and via `Module._load` hook for later imports
- **Remote config** — backend can push `temperature`, `max_tokens`, `model`, and other fields mid-run via `/ingest` response
- **Governance** — backend can stop a run, inject messages, trigger alerts, or checkpoint/restore conversation state
- **AgentHandle** — per-agent config scoping with `sdk.agent("name").field(...).session(...)`
- **Sessions** — track runs by `userId`, `window`, `key`; supports workflow and swarm grouping
- **OTel spans** — one span per LLM call with `gen_ai.*` conventions and `syrin.*` extensions
- **Telemetry signals** — conversation hash, mutation hash, context utilization, tool-set hash, call depth
- **Config guards** — `ConfigGuard`, `ConfigFuse`, `ConfigAnchor`, `AutoRevert` for safe remote config changes
- **`@tunable`** — mark class fields as remotely tunable at runtime
- **Schema registration** — `registerAgent()` and `registerEndpoint()` wire the Syrin dashboard
- **Mock backend** — Express dev server to inspect SDK traffic locally

### Technical

- 578 tests passing · Node.js ≥ 18 · ESM with `exports` map · deps: `opentelemetry-sdk`

---

[Unreleased]: https://github.com/syrin-labs/syrin-sdk-ts/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/syrin-labs/syrin-sdk-ts/releases/tag/v1.0.0
