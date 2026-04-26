---
title: "Introduction"
description: "@syrin/sdk — observability, remote config, and governance for AI agents in TypeScript and Node.js. One import, one await."
weight: 1
---

# @syrin/sdk

## Your AI Agent Just Got a Mission Control

Syrin is the observability, remote configuration, and governance layer for production AI agents. It instruments your existing LLM calls without requiring you to rewrite them, streams every event to the Syrin dashboard in real-time, and lets you change model parameters, prompts, and agent behavior live — without a redeploy.

Think of it as Datadog meets LaunchDarkly, purpose-built for the LLM era.

### What Syrin Does

- **Auto-instrumentation** — wraps OpenAI calls transparently at the library level. Zero changes to your existing LLM code.
- **Remote config** — the dashboard can push a new temperature, model name, or system prompt mid-run and your agent picks it up on the next call.
- **Governance** — the backend can stop a runaway agent, inject corrective messages, or trigger checkpointing when it detects loops or cost overruns.
- **Sessions** — group all LLM calls for a user into a single timeline, regardless of which process or replica handles each call.
- **Multi-agent support** — orchestrators, pipelines, parallel swarms, and arbitrary graphs are all first-class concepts.

### Initialization

Pass all configuration as fields to `init()`. The function is async — you must `await` it:

```typescript
import { init } from "@syrin/sdk";

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-orchestrator",
  backendUrl: "https://app.syrin.ai",
  captureContent: true,
});
```

`init()` validates your API key early, patches the OpenAI SDK in place, and returns the `SyrinSDKInstance` handle. From the moment `await` resolves, every OpenAI call made anywhere in the process is instrumented.

> **Always await `init()`.** If you skip `await`, the patch may not complete before your first LLM call and telemetry will be silently missed.

### 5-Minute Quickstart

Install, set two environment variables, and add three lines to your agent:

```bash
npm install @syrin/sdk openai
```

```bash
export SYRIN_API_KEY="syrin_pk_..."
export SYRIN_AGENT_ID="my-first-agent"
```

```typescript
import { init, withSession } from "@syrin/sdk";
import OpenAI from "openai";

// 1. Initialize Syrin — instruments OpenAI automatically
const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-first-agent" });

const openai = new OpenAI(); // your normal client, unmodified

// 2. Optionally scope a session per user
await withSession("u:alice:today", async () => {
  // 3. Your existing LLM call — no changes needed
  const response = await openai.chat.completions.create({
    model: sdk.agent("my-first-agent").cfg("llm.model", "gpt-4o"),
    messages: [{ role: "user", content: "Plan a trip to Tokyo" }],
  });
  console.log(response.choices[0].message.content);
});

// Events are flushed automatically at process exit
```

Open the dashboard at `https://app.syrin.ai` and watch Alice's session appear in real-time.

---

### Key Concepts

| Concept | What it is |
|---------|------------|
| **Agent** | A named AI service or component (e.g. `"travel-orchestrator"`) |
| **Session** | A group of LLM calls for one user in one time window |
| **withSession()** | Scopes all LLM calls inside to a single session ID via AsyncLocalStorage |
| **cfg()** | A remotely-overridable value — declare a default, get the live value back |
| **Governance** | Backend-driven rules that can stop, inject messages, or checkpoint your agent |
| **emit()** | Send custom lifecycle events (guardrails, handoffs, budget warnings) |

---

### Architecture Overview

```
Your Agent Code
      │
      ▼
 await init()          ← patches OpenAI at the library level
      │
      ▼
 LLM call (unchanged)  ← intercepted automatically
      │
      ▼
 Syrin Emitter         ← batches events, sends to backend
      │
      ▼
 Syrin Backend         ← stores, analyses, streams to dashboard
      │
      ▼
 Syrin Dashboard       ← live session replay, config controls, governance
```

The SDK never proxies your requests to the LLM — it wraps OpenAI's internal method directly, so latency impact is negligible and your `baseURL`, retry config, and timeout settings are all preserved.

---

### What Gets Auto-Instrumented

Out of the box, `init()` patches the following if it is installed:

- **OpenAI** (`openai.chat.completions.create`, sync and streaming, including all `baseURL` variants for OpenRouter, Together AI, Groq, etc.)

Anthropic and LangChain support is available via optional adapters — see `docs/adapters.md`. The SDK degrades gracefully if a peer dependency is not installed; it will never throw at import time because `openai` is absent.

---

### What Gets Captured Per Call

Each LLM call emits an event with:

- `model` — the model name
- `provider` — `"openai"`, `"openrouter"`, `"groq"`, etc. (auto-detected from `baseURL`)
- `input_tokens` / `output_tokens` — token counts
- `cost_usd` — estimated cost
- `duration_ms` — end-to-end latency
- `session_id` / `agent_id` / `workflow_id` — context identifiers
- `stream` — whether the call used streaming
- `config_applied` — whether a remote config override was active
- `context_utilization` — fraction of the model's context window used
- `conversation_hash` — SHA-256 fingerprint for loop detection
- `system_prompt_hash` / `tool_set_hash` — mutation detection signals

Prompt and completion text is **not** captured by default (PII-safe). Enable with `captureContent: true`.

---

### Next Steps

- [Installation](./installation) — npm install, env vars, Node.js requirements
- [Quickstart](./quickstart) — full working example with OpenAI
- [init() Reference](../init) — every parameter documented
- [Remote Config](../cfg) — `AgentHandle.cfg()` and `ConfigStore`
