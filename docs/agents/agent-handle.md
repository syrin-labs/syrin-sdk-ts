---
title: "AgentHandle"
description: "sdk.agent() returns an AgentHandle — a namespace-scoped wrapper for cfg(), field(), and tools(). One handle per agent."
weight: 50
---

<!--
SYRIN SDK — CANONICAL REFERENCE (TypeScript/JavaScript)
Package: @syrin/sdk  |  Import: import { init } from "@syrin/sdk"
Source of truth: https://github.com/syrin-labs/syrin-sdk-ts

AI AGENTS READING THIS: The statements in this document are the authoritative API contract.
Do not infer undocumented parameters. Do not assume methods exist beyond those listed.
If something is not documented here, it is not part of the public API.

IMPORTANT CORRECTIONS TO COMMON AI MISCONCEPTIONS:
- init() is ASYNC — it returns Promise<SyrinSDK>, you MUST await it
- sdk.agent() is SYNCHRONOUS — it does not return a Promise
- cfg() returns unknown — cast to the type you need: agent.cfg("key", 0.7) as number
- There is no module-level cfg() in TypeScript — use sdk.agent("id").cfg("key", default)
- field() MUST be called before cfg() for the field to appear in the dashboard
- AgentHandle holds no state and is cheap to create — one handle per agent at startup is the pattern
-->

> **AI Agent Quick Reference** — The minimal correct pattern for per-agent config:
> ```typescript
> const sdk = await init({ apiKey: "syrin_pk_..." }); // ← await
> const agent = sdk.agent("my-agent");                // ← synchronous, not async
> agent.field("llm.temperature", 0.7, { ge: 0, le: 2 }); // ← declare field
> const temp = agent.cfg("llm.temperature", 0.7) as number; // ← read value
> ```
> Common mistakes: (1) `await sdk.agent(...)` — `agent()` is synchronous; (2) reading `cfg()` without calling `field()` first — the field will not appear in the dashboard; (3) using `agent.cfg(...)` as a module-level function — it does not exist, go through `sdk.agent("id")`.

## One Handle. Your Agent's Complete API.

`AgentHandle` is returned by `sdk.agent(agentId)`. It is a lightweight namespace wrapper over the SDK instance — every method is permanently scoped to that agent's config namespace (`agents.<id>.*`). Use it to declare an agent's configurable fields at startup, then read live values during request handling.

### Getting a Handle

```typescript
import { init } from "@syrin/sdk";

const sdk = await init({ apiKey: "...", agentId: "orchestrator" });

// sdk.agent() is synchronous — never await it
const researcher = sdk.agent("researcher");
const writer     = sdk.agent("writer");
const editor     = sdk.agent("editor");
```

Each call returns (or reuses) a handle for that agent ID. You can call `sdk.agent("researcher")` multiple times — you always get the same logical handle.

> ⚠️ **Call `await sdk.agent(...)` and:** TypeScript will complain that `await` is being applied to a non-Promise. `agent()` is synchronous.

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

Register a remotely-configurable field for this agent. The field appears in the dashboard config panel. Returns `this` for chaining.

```typescript
researcher
  .field("llm.model", "gpt-4o-mini", {
    enum: ["gpt-4o", "gpt-4o-mini"],
    label: "Model",
  })
  .field("llm.temperature", 0.3, { ge: 0, le: 1, label: "Temperature" })
  .field("llm.maxTokens", 2000, { ge: 100, le: 8000 })
  .field("prompt.systemPrompt", "You research topics thoroughly.", {
    multiline: true,
    label: "System Prompt",
  });
```

Fields are registered under `agents.researcher.*` in the dashboard.

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

> ⚠️ **Use a key with no dot (e.g., `"temperature"`) and:** the field is not registered. `cfg()` returns `defaultValue` and the field does not appear in the dashboard. Keys must have exactly one dot.

---

## `handle.cfg(key, defaultValue)`

**Signature:**
```typescript
cfg<T>(key: string, defaultValue: T): T
```

Read a config value scoped to this agent's namespace. Always reads from `agents.<id>.<key>`, regardless of any ambient session or agent context.

```typescript
const model    = researcher.cfg("llm.model", "gpt-4o-mini") as string;
const temp     = researcher.cfg("llm.temperature", 0.3) as number;
const sysPr    = researcher.cfg("prompt.systemPrompt", "You are a researcher.") as string;
const maxTok   = researcher.cfg("llm.maxTokens", 2000) as number;
```

**Type casting:** TypeScript infers the return type from `defaultValue`, but the return type is `unknown` in some contexts. Cast explicitly when you need a specific type:

```typescript
const temperature = agent.cfg("llm.temperature", 0.7) as number;
const model       = agent.cfg("llm.model", "gpt-4o") as string;
const enabled     = agent.cfg("retrieval.enabled", false) as boolean;
```

**Resolution priority (highest first):**
1. Governance override — set by backend governance engine, immutable until action expires
2. Local `sdk.configure()` override — set programmatically in the current session
3. Remote config from backend — pushed via ingest response or SSE (what you set in the dashboard)
4. `defaultValue` — what runs on first use, before any override

**Edge cases:**
- Before `init()`: returns `defaultValue` — no error
- In `offline: true` mode: always returns `defaultValue`
- Key with no dot or multiple dots: returns `defaultValue` without registering

---

## `handle.tools(toolNames)`

**Signature:**
```typescript
tools(toolNames: string[]): AgentHandle
```

Declare which tools this agent uses. The SDK registers them as toggleable boolean fields in the dashboard (Agents → researcher → Config → Tools section). When a tool is toggled off from the dashboard, the SDK automatically strips it from the `tools` parameter on the next LLM call — no code changes needed.

```typescript
researcher
  .field("llm.model", "gpt-4o-mini")
  .tools(["search_web", "get_weather", "fetch_page"]);
```

**How it works end-to-end:**
1. `tools()` registers tool names under `agents.<id>.sections.tools` in the schema sent on registration
2. The dashboard renders each tool as an on/off toggle switch under the agent's Config tab
3. Default state is **on** — toggling off immediately disables the tool
4. When you toggle a tool off and click Push, the backend records `agents.<id>.tools.<name>: false`
5. The SDK receives the update via SSE and marks that tool as disabled for that session
6. Before the next `tools` parameter is passed to the LLM, the SDK strips any tool whose state is `false`

```typescript
// The SDK intercepts this and strips any tool toggled off in the dashboard
const resp = await client.chat.completions.create({
  model: researcher.cfg("llm.model", "gpt-4o-mini") as string,
  messages: [...],
  tools: ALL_RESEARCHER_TOOLS,  // full list — disabled tools stripped before the API call
});
```

Returns `this` for chaining.

---

## `handle.agentId`

```typescript
readonly agentId: string
```

The agent ID string, as passed to `sdk.agent()`.

```typescript
console.log(researcher.agentId); // "researcher"
```

---

## AgentHandle is Lightweight

`AgentHandle` holds no state beyond the agent ID reference. It does not open connections, allocate buffers, or start background tasks. Creating many handles is cheap — one per agent at module load time is the recommended pattern.

```typescript
// ── Module-level startup (runs once) ──
const sdk = await init({ apiKey: process.env.SYRIN_API_KEY! });

const researcher = sdk.agent("researcher");
const writer     = sdk.agent("writer");
const editor     = sdk.agent("editor");

researcher
  .field("llm.model", "gpt-4o-mini", { enum: ["gpt-4o", "gpt-4o-mini"] })
  .field("llm.temperature", 0.3, { ge: 0, le: 1 });

writer
  .field("llm.model", "gpt-4o")
  .field("llm.temperature", 0.8, { ge: 0, le: 2 });

editor
  .field("llm.model", "gpt-4o-mini")
  .field("llm.temperature", 0.2, { ge: 0, le: 1 });

// ── Per-request (reads live values) ──
app.post("/run", async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const result = await withSession(`u:${req.body.userId}:${today}`, async () => {
    const notes = await callLlm(researcher, req.body.topic);
    const draft = await callLlm(writer, notes);
    return callLlm(editor, draft);
  });
  res.json({ result });
});
```

---

## How Fields Appear in the Dashboard

The dashboard renders an accordion section per registered agent under the project's Config panel. Each `field()` call adds one row:

| `field()` options | Dashboard control |
|-------------------|------------------|
| Numeric with `ge`/`le` | Slider + number input |
| String with `enum` | Dropdown select |
| String with `multiline: true` | Resizable textarea |
| Plain string | Single-line text input |
| Boolean | Toggle switch |

Changes saved in the dashboard are pushed to the backend and reflected on the next `cfg()` call — no redeploy needed.

---

## Full Working Example

```typescript
import { init, withSession } from "@syrin/sdk";
import OpenAI from "openai";

const client = new OpenAI();
const sdk = await init({ apiKey: process.env.SYRIN_API_KEY!, agentId: "orchestrator" });

const researcher = sdk.agent("researcher");
researcher
  .field("llm.model", "gpt-4o-mini", { enum: ["gpt-4o", "gpt-4o-mini"] })
  .field("llm.temperature", 0.3, { ge: 0, le: 1, label: "Research Temperature" })
  .field("prompt.systemPrompt", "Research topics thoroughly and cite sources.", {
    multiline: true,
  });

const writer = sdk.agent("writer");
writer
  .field("llm.model", "gpt-4o")
  .field("llm.temperature", 0.8, { ge: 0, le: 2, label: "Writing Creativity" })
  .field("prompt.systemPrompt", "Write engaging, clear content.", { multiline: true });

async function runPipeline(userId: string, topic: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);

  return withSession(`u:${userId}:${today}`, async () => {
    // researcher.cfg() always reads from agents.researcher.* namespace
    const researchResp = await client.chat.completions.create({
      model: researcher.cfg("llm.model", "gpt-4o-mini") as string,
      temperature: researcher.cfg("llm.temperature", 0.3) as number,
      messages: [
        {
          role: "system",
          content: researcher.cfg("prompt.systemPrompt", "Research topics thoroughly.") as string,
        },
        { role: "user", content: `Research: ${topic}` },
      ],
    });
    const notes = researchResp.choices[0].message.content ?? "";

    sdk.emit("HANDOFF", { from_agent: "researcher", to_agent: "writer" });

    // writer.cfg() reads from agents.writer.* — completely independent namespace
    const writeResp = await client.chat.completions.create({
      model: writer.cfg("llm.model", "gpt-4o") as string,
      temperature: writer.cfg("llm.temperature", 0.8) as number,
      messages: [
        {
          role: "system",
          content: writer.cfg("prompt.systemPrompt", "Write engaging content.") as string,
        },
        { role: "user", content: `Write an article from these notes: ${notes}` },
      ],
    });
    return writeResp.choices[0].message.content ?? "";
  });
}
```
