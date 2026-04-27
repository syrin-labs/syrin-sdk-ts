---
title: "Remote Config (cfg)"
description: "agent.cfg() declares a remotely-overridable value — set a default in code, tune it live from app.syrin.ai without redeploying."
weight: 20
---

## Deploy Once, Tune Forever

`agent.cfg()` is the core remote config primitive. Call it wherever you pass a value to your LLM — model name, temperature, system prompt, retrieval top-k, anything. The first `field()` declaration registers the field in the [Syrin dashboard](https://app.syrin.ai). From that moment on, anyone with dashboard access can change the live value without touching your code or redeploying.

```typescript
const agent = sdk.agent("travel-assistant")
  .field("llm.model",       "gpt-4o",  { enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"] })
  .field("llm.temperature", 0.7,       { ge: 0, le: 2 })
  .field("llm.max_tokens",  1000,      { ge: 1, le: 4096 })
  .field("prompt.systemPrompt", "You are a helpful travel assistant.", { multiline: true });

const response = await client.chat.completions.create({
  model:       agent.cfg("llm.model",       "gpt-4o"),
  temperature: agent.cfg("llm.temperature", 0.7),
  max_tokens:  agent.cfg("llm.max_tokens",  1000),
  messages: [
    { role: "system", content: agent.cfg("prompt.systemPrompt", "You are a helpful travel assistant.") },
    { role: "user",   content: query },
  ],
});
```

After running this once, open [app.syrin.ai → Agents → your-agent → Config](https://app.syrin.ai) — four controls appear automatically, ready to change live.

> **TypeScript difference from Python:** Config reads always go through an `AgentHandle` (`sdk.agent(id)`). There is no module-level `cfg()` in TypeScript. This ensures every field is automatically scoped to a named agent.

---

### `agent.field()` — Declaring Fields

Use `field()` to register a configurable field **before** reading it with `cfg()`. This is what makes the field appear in the dashboard config panel. `field()` returns `this` for chaining.

```typescript
agent
  .field("llm.model",       "gpt-4o",   { label: "LLM Model", enum: ["gpt-4o", "gpt-4o-mini"] })
  .field("llm.temperature", 0.7,        { ge: 0, le: 2, label: "Creativity" })
  .field("llm.maxTokens",   1000,       { ge: 1, le: 4096 })
  .field("prompt.systemPrompt", "You are an assistant.", { multiline: true, label: "System Prompt" });
```

**`field()` parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | Yes | Dot-notation key: `"section.field"` |
| `defaultValue` | `T` | Yes | Value used when no remote override is active |
| `opts.label` | `string` | No | Human-readable label in the dashboard |
| `opts.description` | `string` | No | Tooltip/helper text |
| `opts.ge` | `number` | No | Minimum value — renders slider with min bound |
| `opts.le` | `number` | No | Maximum value — renders slider with max bound |
| `opts.enum` | `unknown[]` | No | Fixed set of allowed values — renders dropdown |
| `opts.multiline` | `boolean` | No | Renders resizable textarea (use for prompts) |

---

### `agent.cfg()` — Reading Values

```typescript
cfg<T>(key: string, defaultValue: T): T
```

Returns the live value from the backend if one exists, otherwise `defaultValue`. TypeScript infers the return type from `defaultValue` — no explicit annotation needed.

---

### Key Format: `"section.field"`

Keys use dot-notation. The `section` becomes an **accordion group** in the dashboard config panel.

```typescript
agent.cfg("llm.temperature",      0.7)     // section: "llm",       field: "temperature"
agent.cfg("prompt.systemPrompt",  "...")   // section: "prompt",     field: "systemPrompt"
agent.cfg("retrieval.topK",       5)       // section: "retrieval",  field: "topK"
agent.cfg("budget.maxCostUsd",    1.0)     // section: "budget",     field: "maxCostUsd"
```

Keys with zero dots (`"temperature"`) or multiple dots (`"llm.sub.field"`) are invalid — `cfg()` returns `defaultValue` without registering.

---

### Resolution Priority

When `agent.cfg("key", defaultValue)` is called, the returned value follows this precedence (highest first):

1. **Governance / anchor override** — set by the backend's governance engine; immutable until the action expires
2. **Local `sdk.configure()` override** — set programmatically in the current session
3. **Remote config from backend** — pushed via ingest response or config polling (what you set in the dashboard)
4. **`defaultValue`** — the value you passed (what runs on first use, before any override)

---

### What You See at app.syrin.ai

After the first `field()` declaration, open [app.syrin.ai → Agents → {your-agent} → Config](https://app.syrin.ai):

#### Numeric with `ge`/`le` → Slider

```typescript
agent.field("llm.temperature", 0.7, { ge: 0, le: 2, label: "Creativity" });
```

```
╔══ llm ══════════════════════════════════════════════╗
║  Creativity     ────●──────   0.7          (0.0 — 2.0)
╚═════════════════════════════════════════════════════╝
```

#### String with `enum` → Dropdown

```typescript
agent.field("llm.model", "gpt-4o", { enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"] });
```

```
╔══ llm ══════════════════════════════════════════════╗
║  model          [gpt-4o ▾]   gpt-4o | gpt-4o-mini | gpt-4-turbo
╚═════════════════════════════════════════════════════╝
```

#### String with `multiline: true` → Textarea

```typescript
agent.field("prompt.systemPrompt", "You are an assistant.", { multiline: true });
```

```
╔══ prompt ═══════════════════════════════════════════╗
║  systemPrompt   ┌──────────────────────────────┐   ║
║                 │ You are an assistant.        │   ║
║                 └──────────────────────────────┘   ║
╚═════════════════════════════════════════════════════╝
```

#### Boolean → Toggle

```typescript
agent.field("retrieval.rerankerEnabled", false, { label: "Enable Reranker" });
```

```
╔══ retrieval ════════════════════════════════════════╗
║  Enable Reranker    ○ OFF
╚═════════════════════════════════════════════════════╝
```

### Changing a Value from the Dashboard

1. Navigate to [app.syrin.ai → Agents → {your-agent} → Config](https://app.syrin.ai)
2. Adjust a slider, dropdown, or textarea
3. Click **Save Changes**
4. On the agent's next run, `cfg()` returns the new value

**Console output before dashboard change:**
```
temperature = agent.cfg("llm.temperature", 0.7)  → 0.7
```

**Console output after dashboard change (0.7 → 1.2):**
```
temperature = agent.cfg("llm.temperature", 0.7)  → 1.2
```

No code change, no restart, no redeploy.

---

### Per-Agent Config Isolation

`sdk.agent("researcher").cfg(...)` always reads from `agents.researcher.*`. Each agent gets its own independent config section in the dashboard — changing `researcher`'s temperature does not affect `writer`'s temperature.

```typescript
const researcher = sdk.agent("researcher");
const writer     = sdk.agent("writer");

// Different dashboard controls — same key, different namespaces
const researchModel = researcher.cfg("llm.model", "gpt-4o-mini");   // agents.researcher.llm.model
const writerModel   = writer.cfg("llm.model", "gpt-4o");             // agents.writer.llm.model
```

In the dashboard:
```
Agents → researcher → Config
  llm.model: [gpt-4o-mini ▾]

Agents → writer → Config
  llm.model: [gpt-4o ▾]
```

---

### Common Patterns

#### Pattern 1: Declare Once at Startup, Read at Call Time

```typescript
// ── Module-level startup (runs once) ──
const agent = sdk.agent("chat-agent")
  .field("llm.model",       "gpt-4o",   { enum: ["gpt-4o", "gpt-4o-mini"] })
  .field("llm.temperature", 0.7,        { ge: 0, le: 2 })
  .field("llm.maxTokens",   1500,       { ge: 1 })
  .field("llm.topP",        1.0,        { ge: 0, le: 1 });

// ── Per-request (reads live values) ──
const response = await client.chat.completions.create({
  model:       agent.cfg("llm.model",       "gpt-4o"),
  temperature: agent.cfg("llm.temperature", 0.7),
  max_tokens:  agent.cfg("llm.maxTokens",   1500),
  messages,
});
```

#### Pattern 2: Feature Flags

```typescript
const agent = sdk.agent("rag-agent")
  .field("retrieval.rerankerEnabled", false, { label: "Enable Reranker" })
  .field("retrieval.topK", 5, { ge: 1, le: 50 });

const useReranker = agent.cfg("retrieval.rerankerEnabled", false) as boolean;
const topK        = agent.cfg("retrieval.topK", 5) as number;

let docs = await vectorDb.query(query, topK);
if (useReranker) {
  docs = await reranker.rerank(docs, query);
}
```

Toggle the reranker on from [app.syrin.ai](https://app.syrin.ai) without touching code.

#### Pattern 3: Budget Controls

```typescript
const agent = sdk.agent("budget-aware-agent")
  .field("budget.maxCostUsd",  1.0, { ge: 0.01, label: "Max Session Cost (USD)" })
  .field("budget.warnAtPct",   0.8, { ge: 0, le: 1, label: "Warn threshold" });

const maxCost = agent.cfg("budget.maxCostUsd", 1.0) as number;
const warnAt  = agent.cfg("budget.warnAtPct", 0.8)  as number;

if (sessionCost > maxCost * warnAt) {
  sdk.emit("BUDGET_ESTIMATION", {
    estimated_cost_usd: sessionCost,
    budget_usd: maxCost,
    message: `Session at ${(sessionCost/maxCost*100).toFixed(0)}% of budget`,
  });
  // → BUDGET_ESTIMATION event appears on the session timeline at app.syrin.ai
}
```

#### Pattern 4: Experiment Variants

```typescript
const agent = sdk.agent("ab-agent")
  .field("experiment.variant", "control", {
    enum: ["control", "treatment_a", "treatment_b"],
    label: "A/B Variant",
  });

const variant = agent.cfg("experiment.variant", "control") as string;

const systemPrompt =
  variant === "treatment_a" ? agent.cfg("prompt.systemPromptA", "Be concise.", { multiline: true }) :
  variant === "treatment_b" ? agent.cfg("prompt.systemPromptB", "Be verbose.", { multiline: true }) :
                              agent.cfg("prompt.systemPrompt",  "Default.", { multiline: true });
```

Switch variants from [app.syrin.ai](https://app.syrin.ai) — each variant's session performance shows up separately in analytics.

---

### Programmatic Local Overrides

`sdk.configure()` sets local overrides at higher priority than remote config but lower than governance anchors. Useful for test harnesses and per-request overrides.

```typescript
// Override config for the default session
sdk.configure({ "llm.temperature": 0.2, "llm.model": "gpt-4o-mini" });

// Override config for a specific session
sdk.configure({ "llm.temperature": 0.9 }, "user:alice:2026-04-27");
```

---

### Type Safety Tip

TypeScript infers the return type from `defaultValue`, but it returns `unknown` for `field()`. Cast explicitly when you need a precise type:

```typescript
const model       = agent.cfg("llm.model",       "gpt-4o") as string;
const temperature = agent.cfg("llm.temperature", 0.7)       as number;
const enabled     = agent.cfg("retrieval.enabled", false)   as boolean;
```

Alternatively, use your own string constants to avoid typos:

```typescript
const LLM = {
  MODEL:       "llm.model",
  TEMPERATURE: "llm.temperature",
  MAX_TOKENS:  "llm.maxTokens",
} as const;

agent.cfg(LLM.MODEL, "gpt-4o");
agent.cfg(LLM.TEMPERATURE, 0.7);
```

---

### Edge Cases

**Before `init()`:** `agent.cfg()` returns `defaultValue` — no error raised.

**Offline mode:**
```typescript
const sdk = await init({ apiKey: "...", offline: true });
agent.cfg("llm.model", "gpt-4o");   // → "gpt-4o" (default always returned)
```

**Key with no dot or multiple dots:** Returns `defaultValue` without registering the field.

**First call wins for type:** The field type is inferred from the first `defaultValue` seen. Later calls with a different type are coerced.
