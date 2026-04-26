---
title: "Remote Config (cfg)"
description: "agent.cfg() declares a remotely-overridable value — set a default in code, override it live from the dashboard without redeploying."
weight: 20
---

## Deploy Once, Tune Forever

`agent.cfg()` is the core remote config primitive. Call it wherever you pass a value to your LLM — model name, temperature, system prompt, retrieval top-k, anything. The value resolves from the session's active config (populated by remote config polling and `/ingest` response `config_updates`), falling back to your default when nothing is set remotely.

Unlike the Python SDK, TypeScript has no module-level `cfg()`. All config reads go through an `AgentHandle` obtained via `sdk.agent(id)`. This means every field is automatically scoped to a named agent — the section becomes an accordion in the Syrin dashboard under `agents.<agentId>.*`.

### The Core Pattern

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "travel-assistant" });
const agent = sdk.agent("travel-assistant");
const client = new OpenAI();

const response = await client.chat.completions.create({
  model:       agent.cfg("llm.model", "gpt-4o"),
  temperature: agent.cfg("llm.temperature", 0.7),
  max_tokens:  agent.cfg("llm.max_tokens", 1000),
  messages: [
    {
      role: "system",
      content: agent.cfg(
        "prompt.system_prompt",
        "You are a helpful travel assistant.",
      ),
    },
    { role: "user", content: "Plan a trip to Tokyo" },
  ],
});
```

### Registering Fields with `agent.field()`

Before reading a value with `cfg()`, declare the field using `agent.field()`. This registers the field in the Syrin dashboard so operators can see and override it. `field()` returns `this` for chaining.

```typescript
const agent = sdk.agent("travel-assistant")
  .field("llm.model",       "gpt-4o",    { label: "LLM Model", enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"] })
  .field("llm.temperature", 0.7,         { ge: 0.0, le: 2.0 })
  .field("llm.max_tokens",  1000,        { ge: 1, le: 4096 })
  .field("prompt.system_prompt", "You are a helpful travel assistant.", {
    multiline: true,
    label: "System Prompt",
    description: "Prepended to every LLM call as the system role.",
  });
```

#### `agent.field()` Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | Yes | Dot-notation key: `"section.field"` |
| `defaultValue` | `T` | Yes | Value to use when no remote override is active |
| `opts.label` | `string` | No | Human-readable label shown in the dashboard |
| `opts.description` | `string` | No | Tooltip/description for the field |
| `opts.ge` | `number` | No | Minimum allowed value (for numeric fields) |
| `opts.le` | `number` | No | Maximum allowed value (for numeric fields) |
| `opts.enum` | `unknown[]` | No | List of allowed values (shown as dropdown) |
| `opts.multiline` | `boolean` | No | Render as multiline textarea (for prompts) |

### `agent.cfg()` Signature

```typescript
cfg<T>(key: string, defaultValue: T): T
```

The return type matches the type of `defaultValue` — no explicit type annotation needed. TypeScript infers it automatically.

### Key Format: `"section.field"`

Keys use dot-notation. The section becomes an **accordion group** in the Syrin dashboard config panel under the agent's namespace.

```typescript
// Section "llm", field "temperature"
agent.cfg("llm.temperature", 0.7)

// Section "prompt", field "system_prompt"
agent.cfg("prompt.system_prompt", "You are a helpful assistant.")

// Custom sections
agent.cfg("retrieval.top_k", 5)
agent.cfg("budget.max_cost_usd", 1.0)
```

The SDK does not enforce any particular section names — you define them. Use whatever grouping makes sense for your dashboard operators.

### Resolution Priority

When `agent.cfg("key", defaultValue)` is called, it resolves the current value in this order:

1. **Governance / anchor override** — set by the backend's governance engine (highest priority)
2. **Local `sdk.configure()` override** — set programmatically via `sdk.configure(overrides, sessionId?)`
3. **Remote config from backend** — pushed via ingest response `config_updates` or config polling
4. **`defaultValue`** — the value you passed (lowest priority)

This means the backend can always override your default, but governance rules can always override the backend.

### Agent Namespace Awareness

Config reads are automatically scoped to the agent. When you call `agent.cfg("llm.temperature", 0.7)` on an `AgentHandle` for `"researcher"`, the SDK resolves the key as:

```
agents.researcher.llm.temperature   ← agent-scoped (checked first)
llm.temperature                     ← global key (fallback)
temperature                         ← last segment (final fallback)
```

This means each agent gets its own independent config section in the dashboard — the `researcher` agent and the `writer` agent can have different temperatures without any naming collision.

```typescript
const researcher = sdk.agent("researcher");
const writer = sdk.agent("writer");

// Different dashboard controls — same key, different namespaces
const researchModel = researcher.cfg("llm.model", "gpt-4o-mini");
const writerModel   = writer.cfg("llm.model", "gpt-4o");
```

### Constraints and Validation

Pass `ge` (greater-or-equal) and `le` (less-or-equal) in the `field()` declaration to constrain numeric fields. The dashboard renders sliders with min/max limits, and the backend validates inbound updates against these constraints.

```typescript
sdk.agent("my-agent")
  .field("llm.temperature",   0.7,  { ge: 0.0, le: 2.0 })
  .field("retrieval.top_k",   5,    { ge: 1, le: 100 })
  .field("budget.max_cost_usd", 1.0, { ge: 0.01 });
```

### Enum Fields (Dropdowns)

Pass `enum` to restrict values to a fixed list. The dashboard renders a dropdown instead of a free-form input.

```typescript
sdk.agent("my-agent")
  .field("llm.model", "gpt-4o", {
    label: "LLM Model",
    enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  })
  .field("output.format", "markdown", {
    enum: ["markdown", "json", "plain"],
    label: "Output Format",
  })
  .field("search.depth", "standard", {
    enum: ["quick", "standard", "deep"],
  });
```

### Multiline Fields (Prompts)

Use `multiline: true` for system prompts or other large text fields. The dashboard renders a resizable textarea.

```typescript
sdk.agent("my-agent").field(
  "prompt.system_prompt",
  "You are a helpful travel assistant. Be concise and friendly.",
  {
    multiline: true,
    label: "System Prompt",
    description: "This message is prepended to every LLM call as the system role.",
  }
);

// Then read it at call time
const systemPrompt = agent.cfg("prompt.system_prompt", "You are a helpful travel assistant.");
```

### Programmatic Local Overrides

`sdk.configure()` sets local overrides that take effect immediately, at higher priority than remote config but lower than governance anchors. Useful for test harnesses, per-request overrides, or staged rollouts.

```typescript
// Override config for the default session
sdk.configure({ "llm.temperature": 0.2, "llm.model": "gpt-4o-mini" });

// Override config for a specific session
sdk.configure({ "llm.temperature": 0.9 }, "user:alice:2026-04-26");
```

### Reading the Effective Config

`sdk.activeConfig(sessionId?)` returns the full resolved config for a session — useful for logging, debugging, or passing the current state to a sub-agent.

```typescript
const config = sdk.activeConfig();
console.log("Active model:", config["llm.model"]);

// For a specific session
const sessionConfig = sdk.activeConfig("user:alice:2026-04-26");
```

### Common Patterns

#### Pattern 1: All LLM Parameters in One Place

Declare all fields upfront, then read them at call time. This creates a clean separation between schema declaration and value consumption.

```typescript
const agent = sdk.agent("chat-agent")
  .field("llm.model",       "gpt-4o",   { enum: ["gpt-4o", "gpt-4o-mini"] })
  .field("llm.temperature", 0.7,        { ge: 0.0, le: 2.0 })
  .field("llm.max_tokens",  1500,       { ge: 1, le: 4096 })
  .field("llm.top_p",       1.0,        { ge: 0.0, le: 1.0 });

function buildChatParams(messages: Array<{ role: string; content: string }>) {
  return {
    model:       agent.cfg("llm.model", "gpt-4o"),
    temperature: agent.cfg("llm.temperature", 0.7),
    max_tokens:  agent.cfg("llm.max_tokens", 1500),
    top_p:       agent.cfg("llm.top_p", 1.0),
    messages,
  };
}

const response = await client.chat.completions.create(buildChatParams(history));
```

---

#### Pattern 2: Per-Agent Config Scoping

```typescript
const researcher = sdk.agent("researcher")
  .field("llm.model", "gpt-4o-mini")
  .field("prompt.system_prompt", "You research the web.", { multiline: true });

const writer = sdk.agent("writer")
  .field("llm.model", "gpt-4o")
  .field("prompt.system_prompt", "You write articles.", { multiline: true });

async function runResearcher(query: string): Promise<string> {
  return researcher.run(async () => {
    // These cfg() calls resolve under agents.researcher.* namespace
    return researcher.chat({
      client,
      messages: [
        { role: "system", content: researcher.cfg("prompt.system_prompt", "You research the web.") },
        { role: "user", content: query },
      ],
    });
  });
}

async function runWriter(research: string): Promise<string> {
  return writer.run(async () => {
    // These resolve under agents.writer.* — completely separate controls
    return writer.chat({
      client,
      messages: [
        { role: "system", content: writer.cfg("prompt.system_prompt", "You write articles.") },
        { role: "user", content: research },
      ],
    });
  });
}
```

---

#### Pattern 3: Feature Flags

```typescript
const agent = sdk.agent("rag-agent")
  .field("retrieval.reranker_enabled", false, { label: "Enable Reranker" })
  .field("retrieval.top_k", 5, { ge: 1, le: 50 });

const useReranker = agent.cfg("retrieval.reranker_enabled", false);
const topK        = agent.cfg("retrieval.top_k", 5);

let docs = await vectorDb.query(query, topK);
if (useReranker) {
  docs = await reranker.rerank(docs, query);
}
```

---

#### Pattern 4: Budget Controls

```typescript
const agent = sdk.agent("budget-aware-agent")
  .field("budget.max_cost_usd",  1.0,  { ge: 0.01, label: "Max Session Cost (USD)" })
  .field("budget.warn_at_cost_usd", 0.80, { ge: 0.01 });

const maxCost  = agent.cfg("budget.max_cost_usd", 1.0);
const warnAt   = agent.cfg("budget.warn_at_cost_usd", 0.80);

if (sessionCost > warnAt) {
  sdk.emit("BUDGET_ESTIMATION", {
    estimated_cost_usd: sessionCost,
    budget_usd: maxCost,
    message: `Session cost at $${sessionCost.toFixed(2)} (limit $${maxCost.toFixed(2)})`,
  });
}

if (sessionCost > maxCost) {
  throw new Error(`Session cost $${sessionCost.toFixed(2)} exceeds budget $${maxCost.toFixed(2)}`);
}
```

### Edge Cases

**Before `init()`:** `agent.cfg()` returns `defaultValue` gracefully — no error raised. The SDK does not need to be initialized for `cfg()` to return a sensible value.

**Non-standard `defaultValue` type:** If `defaultValue` is not `string`, `number`, or `boolean`, the field type is inferred as `string` for dashboard rendering purposes.

**Key must have exactly one dot:** `"llm.temperature"` is valid. `"temperature"` (no dot) and `"llm.sub.field"` (multiple dots) are not valid — `cfg()` returns `defaultValue` without registering the field.

**First call wins for type:** The field type is inferred from the first `defaultValue` seen for a given key. If you later call `agent.cfg("llm.temperature", "hot")` (a string), the field was already registered as `number` from the first call — the dashboard will still render it as a numeric input.

**No `ConfigKeys` enum in TypeScript:** The TS SDK uses plain string literals. Use your own string constants if you want typo prevention:

```typescript
const LLM = {
  MODEL:       "llm.model",
  TEMPERATURE: "llm.temperature",
  MAX_TOKENS:  "llm.max_tokens",
} as const;

agent.cfg(LLM.MODEL, "gpt-4o");
agent.cfg(LLM.TEMPERATURE, 0.7);
```
