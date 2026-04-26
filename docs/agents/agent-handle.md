---
title: "AgentHandle"
description: "sdk.agent() returns an AgentHandle — a namespace-scoped wrapper for cfg(), field(), and agentId. One handle per agent."
weight: 50
---

## One Handle. Your Agent's Complete API.

`AgentHandle` is returned by `sdk.agent(agentId)`. It is a lightweight namespace wrapper over the SDK instance — every method is permanently scoped to that agent's config namespace (`agents.<id>.*`). Use it to declare an agent's configurable fields at startup, then read live values during request handling.

### Getting a Handle

```ts
import { init } from "@syrin/sdk";

const sdk = init({ apiKey: "...", agentId: "orchestrator" });

const researcher = sdk.agent("researcher");
const writer     = sdk.agent("writer");
const editor     = sdk.agent("editor");
```

Each call returns (or reuses) a handle for that agent ID. You can call `sdk.agent("researcher")` multiple times — you always get the same logical handle.

---

### `handle.field(key, default, opts?)`

Register a remotely-configurable field for this agent. The field appears in the dashboard config panel immediately (before any LLM calls). Returns `this` for chaining.

```ts
researcher.field("llm.model", "gpt-4o-mini", { enum: ["gpt-4o", "gpt-4o-mini"] });
researcher.field("llm.temperature", 0.7, { ge: 0, le: 2, label: "Creativity" });
researcher.field("llm.maxTokens", 2000, { ge: 100, le: 8000 });
researcher.field("prompt.systemPrompt", "You are a thorough researcher.", { multiline: true });
```

Fields are registered under `agents.researcher.*` in the dashboard.

**Field options:**

| Option | Type | Description |
|--------|------|-------------|
| `ge` | `number` | Minimum value (numeric fields) |
| `le` | `number` | Maximum value (numeric fields) |
| `enum` | `string[]` | Restricts to a fixed set of values (renders as a dropdown) |
| `label` | `string` | Human-readable label shown in the dashboard |
| `description` | `string` | Tooltip or helper text |
| `multiline` | `boolean` | Renders a textarea instead of a single-line input |

**Method chaining:**

```ts
const researcher = sdk.agent("researcher");
researcher
  .field("llm.model", "gpt-4o-mini", { enum: ["gpt-4o", "gpt-4o-mini"], label: "Model" })
  .field("llm.temperature", 0.3,      { ge: 0, le: 1, label: "Temperature" })
  .field("llm.maxTokens", 2000,       { ge: 100, le: 8000 })
  .field("prompt.systemPrompt", "You research topics thoroughly.", { multiline: true });
```

---

### `handle.cfg(key, default)`

Read a config value scoped to this agent's namespace. Always reads from `agents.<id>.<key>`, regardless of any ambient session or agent context.

```ts
// Always reads from agents.researcher.llm.model
const model = researcher.cfg("llm.model", "gpt-4o-mini");
const temp  = researcher.cfg("llm.temperature", 0.3);
const sysPr = researcher.cfg("prompt.systemPrompt", "You are a researcher.");
```

If the backend has pushed a live config value for this field, `cfg()` returns it. Otherwise it returns the default you provide. The default is also what appears as the initial value in the dashboard panel.

---

### `handle.agentId`

The agent ID string, as passed to `sdk.agent()`.

```ts
console.log(researcher.agentId); // "researcher"
```

---

### Using `cfg()` Inside `withSession`

`handle.cfg()` works both outside and inside a session block — the namespace is always the same:

```ts
async function handleRequest(userId: string, topic: string): Promise<string> {
  return sdk.withSession({ userId, window: "day" }, async () => {
    const model = researcher.cfg("llm.model", "gpt-4o-mini");
    const temp  = researcher.cfg("llm.temperature", 0.3) as number;

    const resp = await client.chat.completions.create({
      model,
      temperature: temp,
      messages: [
        { role: "system", content: researcher.cfg("prompt.systemPrompt", "You research topics thoroughly.") as string },
        { role: "user",   content: `Research: ${topic}` },
      ],
    });

    return resp.choices[0].message.content ?? "";
  });
}
```

---

### AgentHandle is Lightweight

`AgentHandle` holds no state beyond the agent ID reference. It does not open connections, allocate buffers, or start background tasks. Creating many handles is cheap — one per agent at module load time is the recommended pattern.

```ts
// Declare once at startup (module scope)
const sdk = init({ apiKey: process.env.SYRIN_API_KEY! });

const researcher = sdk.agent("researcher");
const writer     = sdk.agent("writer");
const editor     = sdk.agent("editor");

researcher
  .field("llm.model", "gpt-4o-mini", { enum: ["gpt-4o", "gpt-4o-mini"] })
  .field("llm.temperature", 0.3,      { ge: 0, le: 1 });

writer
  .field("llm.model", "gpt-4o")
  .field("llm.temperature", 0.8, { ge: 0, le: 2 });

editor
  .field("llm.model", "gpt-4o-mini")
  .field("llm.temperature", 0.2, { ge: 0, le: 1 });

// Use in request handlers (Express, Fastify, etc.)
app.post("/run", async (req, res) => {
  const result = await sdk.withSession({ userId: req.body.userId, window: "day" }, async () => {
    const notes = await callLlm(researcher, req.body.topic);
    const draft = await callLlm(writer, notes);
    return callLlm(editor, draft);
  });
  res.json({ result });
});
```

---

### How Fields Appear in the Dashboard

The dashboard renders an accordion section per registered agent under the project's Config panel. Each `field()` call adds one row:

- **Numeric fields** with `ge`/`le` render as a slider + number input.
- **String fields** with `enum` render as a dropdown select.
- **String fields** with `multiline: true` render as a resizable textarea.
- **Plain string fields** render as a single-line text input.
- **Boolean fields** render as a toggle.

Changes saved in the dashboard are pushed to the backend and reflected immediately on the next `cfg()` call — no redeploy needed.

---

### Full Example

```ts
import { init } from "@syrin/sdk";
import OpenAI from "openai";

const client = new OpenAI();
const sdk = init({ apiKey: process.env.SYRIN_API_KEY!, agentId: "orchestrator" });

const researcher = sdk.agent("researcher");
researcher
  .field("llm.model", "gpt-4o-mini", { enum: ["gpt-4o", "gpt-4o-mini"] })
  .field("llm.temperature", 0.3, { ge: 0, le: 1, label: "Research Temperature" })
  .field("prompt.systemPrompt", "Research topics thoroughly and cite sources.", { multiline: true });

const writer = sdk.agent("writer");
writer
  .field("llm.model", "gpt-4o")
  .field("llm.temperature", 0.8, { ge: 0, le: 2, label: "Writing Creativity" })
  .field("prompt.systemPrompt", "Write engaging, clear content.", { multiline: true });

async function runPipeline(userId: string, topic: string): Promise<string> {
  return sdk.withSession({ userId, window: "day" }, async (sess) => {
    sdk.emit("HANDOFF", { from_agent: "orchestrator", to_agent: "researcher" });

    const researchResp = await client.chat.completions.create({
      model: researcher.cfg("llm.model", "gpt-4o-mini") as string,
      temperature: researcher.cfg("llm.temperature", 0.3) as number,
      messages: [
        { role: "system", content: researcher.cfg("prompt.systemPrompt", "Research topics thoroughly.") as string },
        { role: "user",   content: `Research: ${topic}` },
      ],
    });
    const notes = researchResp.choices[0].message.content ?? "";

    sdk.emit("HANDOFF", { from_agent: "researcher", to_agent: "writer" });

    const writeResp = await client.chat.completions.create({
      model: writer.cfg("llm.model", "gpt-4o") as string,
      temperature: writer.cfg("llm.temperature", 0.8) as number,
      messages: [
        { role: "system", content: writer.cfg("prompt.systemPrompt", "Write engaging content.") as string },
        { role: "user",   content: `Write an article from these notes: ${notes}` },
      ],
    });
    const article = writeResp.choices[0].message.content ?? "";

    sess.feedback.positive({ reason: "Article generated successfully" });
    return article;
  });
}
```
