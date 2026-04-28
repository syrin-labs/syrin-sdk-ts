---
title: "withWorkflow() & withSwarm()"
description: "Group sequential agents into named workflows and parallel agents into swarms — with lifecycle events on the dashboard timeline."
weight: 33
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
- withWorkflow() and withSwarm() are ASYNC — must be awaited
- withWorkflow() DOES emit WORKFLOW_STARTED / WORKFLOW_ENDED automatically
- withSwarm() DOES emit SWARM_STARTED / SWARM_ENDED automatically
- AGENT_FORK / AGENT_JOIN are NOT emitted automatically — emit them manually for parallel patterns
- withWorkflow() callback receives no parameter — only withAgent() receives (ctx: RunContext)
-->

> **AI Agent Quick Reference** — Sequential workflow and parallel swarm:
> ```typescript
> // Sequential pipeline
> await withWorkflow("research-write", async () => { // ← await
>   await withAgent("researcher", async () => { ... });
>   await withAgent("writer",     async () => { ... });
> });
>
> // Parallel swarm — also emit AGENT_FORK/JOIN manually
> await withSwarm("research-swarm", async () => { // ← await
>   sdk.emit("AGENT_FORK", { agents: ["r-a", "r-b"] });
>   const results = await Promise.all([runAgent("r-a"), runAgent("r-b")]);
>   sdk.emit("AGENT_JOIN", { agents: ["r-a", "r-b"] });
> });
> ```
> Common mistakes: (1) forgetting `await` on `withWorkflow()` / `withSwarm()` — they return Promises; (2) expecting `AGENT_FORK`/`AGENT_JOIN` to fire automatically — emit them manually; (3) passing the wrong callback signature — `withWorkflow` and `withSwarm` callbacks take no parameters (only `withAgent` receives `ctx`).

## Sequential and Parallel Agent Groups

`withWorkflow()` and `withSwarm()` are `AsyncLocalStorage`-scoped context functions that annotate the dashboard timeline with workflow and swarm boundaries.

- `withWorkflow()` — groups sequential agents. Emits `WORKFLOW_STARTED` / `WORKFLOW_ENDED` automatically.
- `withSwarm()` — groups parallel agents. Emits `SWARM_STARTED` / `SWARM_ENDED` automatically.

---

## `withWorkflow()` — Sequential Pipelines

**Signature:**
```typescript
function withWorkflow<T>(workflowId: string, fn: () => Promise<T>): Promise<T>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `workflowId` | `string` | Workflow identifier |
| `fn` | `() => Promise<T>` | Async callback — no parameters |

```typescript
import { withWorkflow, withAgent } from "@syrin/sdk";

await withWorkflow("research-write-pipeline", async () => {
  // WORKFLOW_STARTED emitted automatically
  // All events carry workflow_id = "research-write-pipeline"

  await withAgent("researcher", async () => {
    // researcher LLM calls
  });

  await withAgent("writer", async () => {
    // writer LLM calls
  });
  // WORKFLOW_ENDED emitted automatically
});
```

---

## `withSwarm()` — Parallel Execution

**Signature:**
```typescript
function withSwarm<T>(swarmId: string, fn: () => Promise<T>): Promise<T>
```

```typescript
import { withSwarm, withAgent } from "@syrin/sdk";

await withSwarm("research-swarm", async () => {
  // SWARM_STARTED emitted automatically

  // Emit AGENT_FORK manually before parallel execution
  sdk.emit("AGENT_FORK", {
    agents: ["researcher-climate", "researcher-hotels", "researcher-transport"],
    reason: "Parallel research",
  });

  const [climate, hotels, transport] = await Promise.all([
    withAgent("researcher-climate",    async () => { ... }),
    withAgent("researcher-hotels",     async () => { ... }),
    withAgent("researcher-transport",  async () => { ... }),
  ]);

  // Emit AGENT_JOIN manually after parallel execution
  sdk.emit("AGENT_JOIN", {
    agents: ["researcher-climate", "researcher-hotels", "researcher-transport"],
    reason: "All parallel researchers completed",
  });

  // SWARM_ENDED emitted automatically
  return [climate, hotels, transport];
});
```

---

## Lifecycle Events

| Function | On entry | On exit |
|----------|----------|---------|
| `withWorkflow()` | `WORKFLOW_STARTED` | `WORKFLOW_ENDED` |
| `withSwarm()` | `SWARM_STARTED` | `SWARM_ENDED` |
| `AGENT_FORK` | Must emit manually | — |
| `AGENT_JOIN` | — | Must emit manually |

---

## Combining Session + Workflow

```typescript
import { withSession, withWorkflow, withAgent } from "@syrin/sdk";

await withSession("ses_alice_001", async () => {
  await withWorkflow("research-pipeline", async () => {
    // Events carry both session_id = "ses_alice_001" and workflow_id = "research-pipeline"

    await withAgent("researcher", async () => {
      await runResearch("Paris");
    });

    await withAgent("writer", async () => {
      await writeReport(research);
    });
  });
});
```

---

## Nested Workflows

Workflows can be nested. The inner workflow's events carry the outer workflow's `run_id` in the `parent_run_id` field:

```typescript
await withWorkflow("outer-pipeline", async () => {
  await withWorkflow("inner-pipeline", async () => {
    // workflow_id  = "inner-pipeline"
    // parent_run_id = outer workflow's run_id
  });
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
    const resp = await client.chat.completions.create({
      model: sdk.agent("researcher").cfg("llm.model", "gpt-4o-mini") as string,
      messages: [{ role: "user", content: `Research: ${query}` }],
    });
    return resp.choices[0].message.content ?? "";
  });
}

async function write(notes: string): Promise<string> {
  return withAgent("writer", async () => {
    const resp = await client.chat.completions.create({
      model: sdk.agent("writer").cfg("llm.model", "gpt-4o") as string,
      messages: [{ role: "user", content: `Write article from: ${notes}` }],
    });
    return resp.choices[0].message.content ?? "";
  });
}

async function edit(draft: string): Promise<string> {
  return withAgent("editor", async () => {
    const resp = await client.chat.completions.create({
      model: sdk.agent("editor").cfg("llm.model", "gpt-4o-mini") as string,
      messages: [{ role: "user", content: `Edit for clarity: ${draft}` }],
    });
    return resp.choices[0].message.content ?? "";
  });
}

async function runPipeline(userId: string, topic: string): Promise<string> {
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  return withSession(sessionId, () =>
    withWorkflow("research-write-edit", async () => {
      sdk.log(`Starting pipeline for: ${topic}`);

      const notes = await research(topic);
      sdk.emit("CHECKPOINT", { name: "research-done", phase: "1" });

      const draft = await write(notes);
      sdk.emit("CHECKPOINT", { name: "draft-done", phase: "2" });

      const final = await edit(draft);
      sdk.emit("CHECKPOINT", { name: "edit-done", phase: "3" });

      return final;
    })
  );
}

const result = await runPipeline("alice", "Travel trends 2026");
```

---

## Parallel Swarm Example

```typescript
import { init, withSession, withSwarm, withAgent } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: process.env.SYRIN_API_KEY!, agentId: "orchestrator" });
const client = new OpenAI();

async function runParallelResearch(userId: string, topics: string[]): Promise<string[]> {
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  return withSession(sessionId, () =>
    withSwarm("research-swarm", async () => {
      const agentIds = topics.map((_, i) => `researcher-${i}`);

      sdk.emit("AGENT_FORK", {
        agents: agentIds,
        reason: "Parallelizing research across topics",
      });

      const results = await Promise.all(
        topics.map((topic, i) =>
          withAgent(`researcher-${i}`, async () => {
            const resp = await client.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: `Research: ${topic}` }],
            });
            return resp.choices[0].message.content ?? "";
          })
        )
      );

      sdk.emit("AGENT_JOIN", {
        agents: agentIds,
        reason: "All parallel researchers completed",
      });

      return results;
    })
  );
}
```
