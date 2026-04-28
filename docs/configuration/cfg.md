---
title: "Remote Config (cfg)"
description: "agent.cfg() declares a remotely-overridable value — set a default in code, tune it live from app.syrin.ai without redeploying."
weight: 20
---

<!--
SYRIN SDK — CANONICAL REFERENCE (TypeScript/JavaScript)
Package: @syrin/sdk  |  Import: import { init } from "@syrin/sdk"
Source of truth: https://github.com/syrin-labs/syrin-sdk-ts

AI AGENTS READING THIS: The statements in this document are the authoritative API contract.
Do not infer undocumented parameters. Do not assume methods exist beyond those listed.
If something is not documented here, it is not part of the public API.

IMPORTANT CORRECTIONS TO COMMON AI MISCONCEPTIONS:
- There is NO module-level cfg() in TypeScript — use sdk.agent("id").cfg("key", default)
- sdk.agent() is SYNCHRONOUS — never await it
- field() MUST be called before cfg() for the field to appear in the dashboard
- cfg() returns unknown — cast explicitly: agent.cfg("key", 0.7) as number
- Keys MUST have exactly one dot: "section.field" — keys without dots are ignored silently
- init() is ASYNC — must be awaited before calling sdk.agent()
-->

> **AI Agent Quick Reference** — The minimal correct remote config pattern:
> ```typescript
> const sdk = await init({ apiKey: "syrin_pk_..." }); // ← await
> const agent = sdk.agent("my-agent");               // ← synchronous, NOT async
> agent.field("llm.temperature", 0.7, { ge: 0, le: 2 }); // ← declare first
> const temp = agent.cfg("llm.temperature", 0.7) as number; // ← read live value
> ```
> Common mistakes: (1) module-level `cfg("key", value)` — it does not exist; use `sdk.agent("id").cfg(...)`; (2) `await sdk.agent(...)` — `agent()` is synchronous; (3) calling `cfg()` without calling `field()` first — the field won't appear in the dashboard.

## Deploy Once, Tune Forever

Your agent runs in production. A stakeholder wants to test a lower temperature — without a deploy, without a PR, without waking you up.

`agent.cfg()` makes that possible. Call it wherever you pass a value to your LLM — model name, temperature, system prompt, retrieval top-k. The first `field()` call registers the field in the [Syrin dashboard](https://app.syrin.ai). From that moment on, anyone with dashboard access can change the live value and see results on the next request.

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "travel-assistant" });
const client = new OpenAI();

const agent = sdk.agent("travel-assistant")
  .field("llm.model",          "gpt-4o",   { enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"] })
  .field("llm.temperature",    0.7,        { ge: 0, le: 2 })
  .field("llm.maxTokens",      1000,       { ge: 1, le: 4096 })
  .field("prompt.systemPrompt","You are a helpful travel assistant.", { multiline: true });

const response = await client.chat.completions.create({
  model:       agent.cfg("llm.model",          "gpt-4o") as string,
  temperature: agent.cfg("llm.temperature",    0.7)       as number,
  max_tokens:  agent.cfg("llm.maxTokens",      1000)      as number,
  messages: [
    { role: "system", content: agent.cfg("prompt.systemPrompt", "You are a helpful travel assistant.") as string },
    { role: "user",   content: query },
  ],
});
```

After running this once, open [app.syrin.ai → Agents → travel-assistant → Config](https://app.syrin.ai) — four controls appear, ready to change live.

---

## `handle.field(key, defaultValue, opts?)`

**Signature:**
```typescript
field<T>(key: string, defaultValue: T, opts?: FieldOptions): AgentHandle

interface FieldOptions {
  ge?: number;          // minimum value (renders slider with lower bound)
  le?: number;          // maximum value (renders slider with upper bound)
  enum?: unknown[];     // fixed set of values (renders dropdown)
  label?: string;       // human-readable label in the dashboard
  description?: string; // tooltip or helper text
  multiline?: boolean;  // renders resizable textarea (use for prompts)
}
```

Register a remotely-configurable field. Returns `this` for chaining.

**Parameter reference:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | `string` | Yes | Dot-notation key: `"section.field"`. Exactly one dot required. |
| `defaultValue` | `T` | Yes | Value used when no remote override is active |
| `opts.ge` | `number` | No | Minimum value — renders slider with lower bound |
| `opts.le` | `number` | No | Maximum value — renders slider with upper bound |
| `opts.enum` | `unknown[]` | No | Fixed set of allowed values — renders dropdown |
| `opts.label` | `string` | No | Human-readable label in the dashboard |
| `opts.description` | `string` | No | Tooltip or helper text |
| `opts.multiline` | `boolean` | No | Renders resizable textarea (use for prompts) |

> ⚠️ **Use a key with no dot (e.g., `"temperature"`) and:** the field is not registered. `cfg()` returns `defaultValue` and nothing appears in the dashboard. Keys must have exactly one dot.

---

## `handle.cfg(key, defaultValue)`

**Signature:**
```typescript
cfg<T>(key: string, defaultValue: T): T
```

Returns the live value from the backend if one exists, otherwise `defaultValue`. TypeScript infers the return type from `defaultValue` — cast explicitly for type-safe usage:

```typescript
const model    = agent.cfg("llm.model",       "gpt-4o") as string;
const temp     = agent.cfg("llm.temperature", 0.7)       as number;
const sysPr    = agent.cfg("prompt.systemPrompt", "...") as string;
const enabled  = agent.cfg("retrieval.enabled", false)   as boolean;
```

**Resolution priority (highest first):**
1. **Governance override** — set by backend governance engine; immutable until action expires
2. **Local `sdk.configure()` override** — set programmatically in the current session
3. **Remote config from backend** — pushed via ingest response or config poll (what you set in the dashboard)
4. **`defaultValue`** — what runs on first use, before any override

**Edge cases:**

| Scenario | Behavior |
|----------|----------|
| Before `init()` | Returns `defaultValue` — no error |
| `offline: true` mode | Always returns `defaultValue` |
| Key with no dot (`"temperature"`) | Returns `defaultValue` without registering |
| Key with multiple dots (`"llm.sub.field"`) | Returns `defaultValue` without registering |

---

## Key Format: `"section.field"`

The `section` becomes an **accordion group** in the dashboard config panel. The `field` is the control inside that group.

```typescript
agent.cfg("llm.temperature",      0.7)    // section: "llm",      field: "temperature"
agent.cfg("prompt.systemPrompt",  "...")  // section: "prompt",    field: "systemPrompt"
agent.cfg("retrieval.topK",       5)      // section: "retrieval", field: "topK"
agent.cfg("budget.maxCostUsd",    1.0)    // section: "budget",    field: "maxCostUsd"
```

---

## What You See at app.syrin.ai

After the first `field()` call, open [app.syrin.ai → Agents → {your-agent} → Config](https://app.syrin.ai):

**Numeric with `ge`/`le` → Slider**

```typescript
agent.field("llm.temperature", 0.7, { ge: 0, le: 2, label: "Creativity" });
```
```
╔══ llm ═══════════════════════════════════════════════╗
║  Creativity     ────●──────   0.7          (0.0 — 2.0)
╚══════════════════════════════════════════════════════╝
```

**String with `enum` → Dropdown**

```typescript
agent.field("llm.model", "gpt-4o", { enum: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"] });
```
```
╔══ llm ═══════════════════════════════════════════════╗
║  model          [gpt-4o ▾]
╚══════════════════════════════════════════════════════╝
```

**String with `multiline: true` → Textarea**

```typescript
agent.field("prompt.systemPrompt", "You are an assistant.", { multiline: true });
```
```
╔══ prompt ════════════════════════════════════════════╗
║  systemPrompt   ┌──────────────────────────────────┐ ║
║                 │ You are an assistant.             │ ║
║                 └──────────────────────────────────┘ ║
╚══════════════════════════════════════════════════════╝
```

**Boolean → Toggle**

```typescript
agent.field("retrieval.rerankerEnabled", false, { label: "Enable Reranker" });
```
```
╔══ retrieval ═════════════════════════════════════════╗
║  Enable Reranker    ○ OFF
╚══════════════════════════════════════════════════════╝
```

---

## Per-Agent Config Isolation

`sdk.agent("researcher").cfg(...)` always reads from `agents.researcher.*`. Each agent gets its own independent config section — changing researcher's temperature never affects writer's temperature.

```typescript
const researcher = sdk.agent("researcher");
const writer     = sdk.agent("writer");

const researchModel = researcher.cfg("llm.model", "gpt-4o-mini") as string;  // agents.researcher.llm.model
const writerModel   = writer.cfg("llm.model", "gpt-4o")          as string;  // agents.writer.llm.model
```

In the dashboard:
```
Agents → researcher → Config
  llm.model: [gpt-4o-mini ▾]

Agents → writer → Config
  llm.model: [gpt-4o ▾]
```

---

## Common Patterns

### Pattern 1: Declare Once at Startup, Read at Call Time

```typescript
// ── Module-level startup (runs once) ──────────────────────────────────────
const agent = sdk.agent("chat-agent")
  .field("llm.model",       "gpt-4o",   { enum: ["gpt-4o", "gpt-4o-mini"] })
  .field("llm.temperature", 0.7,        { ge: 0, le: 2 })
  .field("llm.maxTokens",   1500,       { ge: 1 })
  .field("llm.topP",        1.0,        { ge: 0, le: 1 });

// ── Per-request (reads live values each call) ──────────────────────────────
const response = await client.chat.completions.create({
  model:       agent.cfg("llm.model",       "gpt-4o")   as string,
  temperature: agent.cfg("llm.temperature", 0.7)         as number,
  max_tokens:  agent.cfg("llm.maxTokens",   1500)        as number,
  messages,
});
```

### Pattern 2: Feature Flags

```typescript
const agent = sdk.agent("rag-agent")
  .field("retrieval.rerankerEnabled", false, { label: "Enable Reranker" })
  .field("retrieval.topK", 5, { ge: 1, le: 50 });

const useReranker = agent.cfg("retrieval.rerankerEnabled", false) as boolean;
const topK        = agent.cfg("retrieval.topK", 5)                as number;

let docs = await vectorDb.query(query, topK);
if (useReranker) {
  docs = await reranker.rerank(docs, query);
}
```

Toggle the reranker on from [app.syrin.ai](https://app.syrin.ai) — no code change.

### Pattern 3: Budget Controls

```typescript
const agent = sdk.agent("budget-aware-agent")
  .field("budget.maxCostUsd", 1.0, { ge: 0.01, label: "Max Session Cost (USD)" })
  .field("budget.warnAtPct",  0.8, { ge: 0, le: 1, label: "Warn threshold" });

const maxCost = agent.cfg("budget.maxCostUsd", 1.0) as number;
const warnAt  = agent.cfg("budget.warnAtPct",  0.8) as number;

if (sessionCost > maxCost * warnAt) {
  sdk.emit("BUDGET_ESTIMATION", {
    estimated_cost_usd: sessionCost,
    budget_usd: maxCost,
    message: `Session at ${(sessionCost / maxCost * 100).toFixed(0)}% of budget`,
  });
}
```

### Pattern 4: A/B Experiment Variants

```typescript
const agent = sdk.agent("ab-agent")
  .field("experiment.variant", "control", {
    enum: ["control", "treatment_a", "treatment_b"],
    label: "A/B Variant",
  });

const variant = agent.cfg("experiment.variant", "control") as string;

const systemPrompt =
  variant === "treatment_a" ? "Be concise." :
  variant === "treatment_b" ? "Be verbose." :
                              "Default.";
```

Switch variants from the dashboard — each variant's session performance shows up separately in analytics.

---

## Programmatic Local Overrides

`sdk.configure()` sets local overrides at higher priority than remote config but lower than governance. Useful in test harnesses:

```typescript
// Override config for the default session
sdk.configure({ "llm.temperature": 0.2, "llm.model": "gpt-4o-mini" });

// Override config for a specific session
sdk.configure({ "llm.temperature": 0.9 }, "user:alice:2026-04-27");
```

---

## Type Safety

TypeScript infers the return type from `defaultValue`, but in some contexts the return is `unknown`. Cast explicitly:

```typescript
const model   = agent.cfg("llm.model",       "gpt-4o") as string;
const temp    = agent.cfg("llm.temperature", 0.7)       as number;
const enabled = agent.cfg("retrieval.enabled", false)   as boolean;
```

To avoid typos, define your key constants:

```typescript
const LLM = {
  MODEL:       "llm.model",
  TEMPERATURE: "llm.temperature",
  MAX_TOKENS:  "llm.maxTokens",
} as const;

agent.cfg(LLM.MODEL, "gpt-4o") as string;
agent.cfg(LLM.TEMPERATURE, 0.7) as number;
```
