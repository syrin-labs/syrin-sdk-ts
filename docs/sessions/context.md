---
title: "Session & Agent Context"
description: "withSession(), withAgent(), withWorkflow(), withSwarm() — AsyncLocalStorage-based context scoping for sessions, agents, workflows, and swarms."
weight: 30
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
- withSession(), withAgent(), withWorkflow(), withSwarm() are all ASYNC — must be awaited
- withAgent() callback receives (ctx: RunContext) — but ctx is optional to destructure
- withSession() does NOT emit SESSION_CRASHED automatically — emit it manually if needed
- withWorkflow() DOES emit WORKFLOW_STARTED / WORKFLOW_ENDED automatically
- withSwarm() DOES emit SWARM_STARTED / SWARM_ENDED automatically
- withSession() and withAgent() do NOT emit lifecycle events — they only set AsyncLocalStorage
- Context propagates via AsyncLocalStorage — no manual passing needed
-->

> **AI Agent Quick Reference** — Scope LLM calls to a session and agent:
> ```typescript
> import { withSession, withAgent } from "@syrin/sdk";
> await withSession("u:alice:2026-04-27", async () => {    // ← await required
>   await withAgent("researcher", async (ctx) => {          // ← await required
>     // ctx.agentId = "researcher", ctx.sessionId = "u:alice:2026-04-27"
>     await client.chat.completions.create({ ... });
>   });
> });
> ```
> Common mistakes: (1) forgetting `await` on `withSession()` or `withAgent()` — they return Promises; (2) manual context passing — AsyncLocalStorage propagates context automatically; (3) expecting `SESSION_CRASHED` to fire automatically — emit it manually if needed.

## Scope Every LLM Call to a Session and Agent

The TypeScript SDK provides four `AsyncLocalStorage`-backed context functions. Each wraps your callback with the relevant scope — session ID, agent ID, workflow ID, or swarm ID — so the SDK automatically resolves these fields for all events emitted inside.

```typescript
import { withSession, withAgent, withWorkflow, withSwarm } from "@syrin/sdk";
```

> **Python vs TypeScript:** The Python SDK uses a unified `context()` function and context managers (`with sdk.agent().session() as ctx:`). The TypeScript SDK uses four separate async callback functions — `withSession`, `withAgent`, `withWorkflow`, `withSwarm` — that can be nested freely.

---

## `withSession()`

Scopes a callback to a session ID. All events emitted inside carry this session ID.

**Signature:**
```typescript
function withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | `string` | The session ID to activate |
| `fn` | `() => Promise<T>` | Async callback |

```typescript
import { withSession } from "@syrin/sdk";

await withSession("u:alice:2026-04-24", async () => {
  // All events here are tagged with session_id = "u:alice:2026-04-24"
  const response = await client.chat.completions.create({ ... });
});
```

`SESSION_ENDED` is always emitted in the `finally` branch — even if the callback throws. `withSession()` does not emit `SESSION_CRASHED` automatically. Emit it manually if you need crash visibility:

```typescript
await withSession(sessionId, async () => {
  try {
    await runAgent();
  } catch (err) {
    sdk.emit("SESSION_CRASHED", {
      exception_type: err instanceof Error ? err.constructor.name : "Error",
      exception_message: err instanceof Error ? err.message.slice(0, 500) : String(err),
    });
    throw err;
  }
});
```

---

## `withAgent()`

Scopes a callback to an agent ID. Emits `AGENT_RUN_STARTED` on entry and `AGENT_RUN_ENDED` on exit. All `cfg()` calls inside resolve to the `agents.<agentId>.*` namespace.

**Signature:**
```typescript
function withAgent<T>(agentId: string, fn: (ctx: RunContext) => Promise<T>): Promise<T>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `agentId` | `string` | The agent ID to activate |
| `fn` | `(ctx: RunContext) => Promise<T>` | Async callback — receives RunContext |

```typescript
import { withAgent } from "@syrin/sdk";

await withAgent("researcher", async (ctx) => {
  // ctx.agentId = "researcher"
  // ctx.runId   = "run_..."
  const model = sdk.agent("researcher").cfg("llm.model", "gpt-4o-mini") as string;
  const response = await client.chat.completions.create({ model, ... });
});
```

The `ctx` parameter is optional to destructure if you don't need it:

```typescript
await withAgent("researcher", async () => {
  await client.chat.completions.create({ ... });
});
```

---

## `withWorkflow()`

Scopes a callback to a workflow ID. **Emits `WORKFLOW_STARTED` on entry and `WORKFLOW_ENDED` on exit automatically.** Groups all agent runs inside under the same workflow ID.

**Signature:**
```typescript
function withWorkflow<T>(workflowId: string, fn: () => Promise<T>): Promise<T>
```

```typescript
import { withWorkflow } from "@syrin/sdk";

await withWorkflow("research-write-pipeline", async () => {
  // WORKFLOW_STARTED emitted automatically
  const research = await runResearcher(query);
  const article  = await runWriter(research);
  // WORKFLOW_ENDED emitted automatically
});
```

---

## `withSwarm()`

Scopes a callback to a swarm ID. **Emits `SWARM_STARTED` on entry and `SWARM_ENDED` on exit automatically.** Groups parallel workers under the same swarm.

**Signature:**
```typescript
function withSwarm<T>(swarmId: string, fn: () => Promise<T>): Promise<T>
```

```typescript
import { withSwarm } from "@syrin/sdk";

await withSwarm("research-swarm", async () => {
  // SWARM_STARTED emitted automatically
  const results = await Promise.all([
    runResearcher("topic A"),
    runResearcher("topic B"),
    runResearcher("topic C"),
  ]);
  // SWARM_ENDED emitted automatically
});
```

---

## Lifecycle Events Summary

| Function | On entry | On exit (normal) | On exit (error) |
|----------|----------|------------------|-----------------|
| `withSession()` | none | `SESSION_ENDED` | `SESSION_ENDED` |
| `withAgent()` | `AGENT_RUN_STARTED` | `AGENT_RUN_ENDED` | `AGENT_RUN_ENDED` |
| `withWorkflow()` | `WORKFLOW_STARTED` | `WORKFLOW_ENDED` | `WORKFLOW_ENDED` |
| `withSwarm()` | `SWARM_STARTED` | `SWARM_ENDED` | `SWARM_ENDED` |

---

## Nesting Contexts

All four context functions use `AsyncLocalStorage` and can be nested freely. Inner contexts override outer contexts for their specific field only:

```typescript
await withSession("ses_alice", async () => {
  await withWorkflow("research-pipeline", async () => {
    await withAgent("researcher", async (ctx) => {
      // session_id  = "ses_alice"
      // workflow_id = "research-pipeline"
      // agent_id    = "researcher"
      // run_id      = auto-generated
      const research = await runResearch(query);
    });

    await withAgent("writer", async (ctx) => {
      // session_id  = "ses_alice"
      // workflow_id = "research-pipeline"
      // agent_id    = "writer"
      const article = await runWriter(research);
    });
  });
});
```

---

## Deterministic Session IDs

Build session IDs yourself — the TypeScript SDK doesn't have a built-in `WindowType` enum:

```typescript
function userDaySession(userId: string): string {
  const today = new Date().toISOString().slice(0, 10); // "2026-04-26"
  return `u:${userId}:${today}`;
}

await withSession(userDaySession("alice"), async () => {
  const response = await client.chat.completions.create({ ... });
});
```

Common window patterns:

| Window | Formula | Example |
|--------|---------|---------|
| Day | `u:${userId}:${now.slice(0,10)}` | `u:alice:2026-04-24` |
| Hour | `u:${userId}:${now.slice(0,13)}` | `u:alice:2026-04-24T14` |
| Forever | `u:${userId}` | `u:alice` |

---

## HTTP Request Handler Pattern

```typescript
import express from "express";
import OpenAI from "openai";
import { init, withSession, withAgent } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "chat-bot" });
const client = new OpenAI();
const app = express();
app.use(express.json());

app.post("/chat", async (req, res) => {
  const { userId, messages } = req.body;
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  const reply = await withSession(sessionId, () =>
    withAgent("chat-bot", async () => {
      const response = await client.chat.completions.create({
        model: sdk.agent("chat-bot").cfg("llm.model", "gpt-4o") as string,
        messages,
      });
      return response.choices[0].message.content ?? "";
    })
  );

  res.json({ session_id: sessionId, content: reply });
});
```

---

## Full Pipeline Example

```typescript
import { init, withSession, withAgent, withWorkflow } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: process.env.SYRIN_API_KEY!, agentId: "orchestrator" });
const client = new OpenAI();

async function research(query: string): Promise<string> {
  return withAgent("researcher", async () => {
    const response = await client.chat.completions.create({
      model: sdk.agent("researcher").cfg("llm.model", "gpt-4o-mini") as string,
      messages: [{ role: "user", content: `Research: ${query}` }],
    });
    return response.choices[0].message.content ?? "";
  });
}

async function write(notes: string): Promise<string> {
  return withAgent("writer", async () => {
    const response = await client.chat.completions.create({
      model: sdk.agent("writer").cfg("llm.model", "gpt-4o") as string,
      messages: [{ role: "user", content: `Write article from: ${notes}` }],
    });
    return response.choices[0].message.content ?? "";
  });
}

async function runPipeline(userId: string, topic: string): Promise<string> {
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  return withSession(sessionId, () =>
    withWorkflow("research-write", async () => {
      sdk.log(`Starting pipeline for: ${topic}`);
      const notes = await research(topic);
      sdk.emit("CHECKPOINT", { name: "research-done" });
      const article = await write(notes);
      sdk.emit("CHECKPOINT", { name: "write-done" });
      return article;
    })
  );
}
```
