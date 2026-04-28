---
title: "Multi-Agent Systems"
description: "Orchestrators, pipelines, parallel swarms, and graph topologies — building and observing multi-agent systems with Syrin."
weight: 52
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
- withAgent(), withWorkflow(), withSwarm() all take ASYNC CALLBACKS — not sync
- Context propagation is via AsyncLocalStorage — no manual context passing needed
- There is no automatic HANDOFF event — you must emit it manually: sdk.emit("HANDOFF", {...})
- cfg() does not exist as a module-level function — use sdk.agent("id").cfg("key", default)
-->

> **AI Agent Quick Reference** — The minimal correct multi-agent pattern:
> ```typescript
> const sdk = await init({ apiKey: "syrin_pk_..." }); // ← await
> const researcher = sdk.agent("researcher");
> const writer = sdk.agent("writer");
>
> await withSession(`u:alice:${today}`, async () => {
>   await withAgent("researcher", async (ctx) => {
>     const notes = await client.chat.completions.create({ ... });
>   });
>   await withAgent("writer", async (ctx) => {
>     const article = await client.chat.completions.create({ ... });
>   });
> });
> ```
> Common mistakes: (1) missing `await` on `withAgent()` — it returns a Promise; (2) trying to pass context manually between agents — use `AsyncLocalStorage` via `withAgent()`; (3) forgetting `sdk.emit("HANDOFF", ...)` — it does not fire automatically.

## When One Agent Just Isn't Enough

Multi-agent systems split complex tasks across specialized agents. Syrin provides first-class support for orchestration patterns: sequential pipelines, parallel swarms, hierarchical orchestrators, and arbitrary graphs — with full per-agent telemetry and independent config namespaces.

---

## Registering Sub-Agents

Tell Syrin which agents exist in your system so the dashboard shows the full topology:

```typescript
import { init } from "@syrin/sdk";

const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-orchestrator",           // the orchestrator
  agents: {                                  // sub-agents
    "researcher": { description: "Web research and data gathering" },
    "writer":     { description: "Content generation and drafting" },
    "editor":     { description: "Quality review and refinement" },
  },
});
```

Or as a plain array if you don't need descriptions at init time:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-orchestrator",
  agents: ["researcher", "writer", "editor"],
});
```

Each sub-agent gets its own config namespace in the dashboard (e.g., `agents.researcher.llm.temperature`).

---

## Topology Types

Define the relationship between agents explicitly:

```typescript
sdk.defineTopology({
  type: "pipeline",  // "orchestrator" | "pipeline" | "parallel" | "graph" | "conditional_graph" | "hybrid"
  nodes: {
    "travel-orchestrator": { role: "orchestrator" },
    "researcher":           { role: "worker", execMode: "sequential" },
    "writer":               { role: "worker", execMode: "sequential" },
    "editor":               { role: "worker", execMode: "sequential" },
  },
  edges: [
    { from: "travel-orchestrator", to: "researcher" },
    { from: "researcher",          to: "writer" },
    { from: "writer",              to: "editor" },
  ],
  entryPoint: "travel-orchestrator",
  terminalNodes: ["editor"],
});
```

Or pass topology directly to `init()`:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  agentId: "travel-orchestrator",
  agents: ["researcher", "writer", "editor"],
  topology: {
    type: "pipeline",
    nodes: {
      "travel-orchestrator": { role: "orchestrator" },
      "researcher":           { role: "worker" },
      "writer":               { role: "worker" },
      "editor":               { role: "worker" },
    },
    edges: [
      { from: "travel-orchestrator", to: "researcher" },
      { from: "researcher",          to: "writer" },
      { from: "writer",              to: "editor" },
    ],
    entryPoint: "travel-orchestrator",
    terminalNodes: ["editor"],
  },
});
```

---

## Pattern 1: Sequential Pipeline with `withAgent()`

Agents run one after another. `withAgent()` scopes each agent's LLM calls and emits `AGENT_RUN_STARTED` / `AGENT_RUN_ENDED` lifecycle events automatically.

```typescript
import { init, withSession, withAgent, withWorkflow } from "@syrin/sdk";
import OpenAI from "openai";

const client = new OpenAI();
const sdk = await init({ apiKey: "syrin_pk_...", agentId: "travel-orchestrator" });

const researcher = sdk.agent("researcher");
const writer     = sdk.agent("writer");
const editor     = sdk.agent("editor");

researcher
  .field("llm.model", "gpt-4o-mini", { enum: ["gpt-4o", "gpt-4o-mini"] })
  .field("llm.temperature", 0.3, { ge: 0, le: 1 });

writer
  .field("llm.model", "gpt-4o")
  .field("llm.temperature", 0.7, { ge: 0, le: 2 });

editor
  .field("llm.model", "gpt-4o-mini")
  .field("llm.temperature", 0.2, { ge: 0, le: 1 });

async function runPipeline(userId: string, topic: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);

  return withSession(`u:${userId}:${today}`, () =>
    withWorkflow("research-write-edit", async () => {
      // withAgent() emits AGENT_RUN_STARTED / AGENT_RUN_ENDED automatically
      const notes = await withAgent("researcher", async (ctx) => {
        sdk.emit("HANDOFF", { from_agent: "orchestrator", to_agent: "researcher" });
        const resp = await client.chat.completions.create({
          model: researcher.cfg("llm.model", "gpt-4o-mini") as string,
          temperature: researcher.cfg("llm.temperature", 0.3) as number,
          messages: [{ role: "user", content: `Research: ${topic}` }],
        });
        return resp.choices[0].message.content ?? "";
      });

      sdk.emit("CHECKPOINT", { name: "research-done" });

      const draft = await withAgent("writer", async (ctx) => {
        sdk.emit("HANDOFF", { from_agent: "researcher", to_agent: "writer" });
        const resp = await client.chat.completions.create({
          model: writer.cfg("llm.model", "gpt-4o") as string,
          temperature: writer.cfg("llm.temperature", 0.7) as number,
          messages: [{ role: "user", content: `Write article from: ${notes}` }],
        });
        return resp.choices[0].message.content ?? "";
      });

      const final = await withAgent("editor", async (ctx) => {
        sdk.emit("HANDOFF", { from_agent: "writer", to_agent: "editor" });
        const resp = await client.chat.completions.create({
          model: editor.cfg("llm.model", "gpt-4o-mini") as string,
          temperature: editor.cfg("llm.temperature", 0.2) as number,
          messages: [{ role: "user", content: `Edit for clarity: ${draft}` }],
        });
        return resp.choices[0].message.content ?? "";
      });

      return final;
    })
  );
}
```

---

## Pattern 2: Parallel with Promise.all and `withSwarm()`

Agents run concurrently. Emit `AGENT_FORK` before launching and `AGENT_JOIN` after all settle so the dashboard renders them as a parallel band.

```typescript
import { init, withSession, withSwarm, withAgent } from "@syrin/sdk";
import OpenAI from "openai";

const client = new OpenAI();
const sdk = await init({ apiKey: "syrin_pk_...", agentId: "travel-orchestrator" });

async function researchAspect(aspect: string, destination: string): Promise<string> {
  return withAgent(`researcher-${aspect}`, async () => {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: `Research ${aspect} for ${destination}` }],
    });
    return resp.choices[0].message.content ?? "";
  });
}

async function runParallelResearch(userId: string, destination: string): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const aspects = ["climate", "hotels", "food", "transport", "culture"];

  return withSession(`u:${userId}:${today}`, () =>
    withSwarm("research-swarm", async () => {
      sdk.emit("AGENT_FORK", {
        agents: aspects.map((a) => `researcher-${a}`),
        reason: `Parallel research for ${destination}`,
      });

      const results = await Promise.all(
        aspects.map((aspect) => researchAspect(aspect, destination))
      );

      sdk.emit("AGENT_JOIN", {
        agents: aspects.map((a) => `researcher-${a}`),
        reason: "All researchers completed",
      });

      return results;
    })
  );
}
```

---

## Context Propagation via AsyncLocalStorage

`withAgent()` uses `AsyncLocalStorage` — every `cfg()`, `emit()`, and LLM call inside the callback automatically inherits the agent context. No manual context passing is needed.

```typescript
await withSession("ses_alice", async () => {
  await withWorkflow("research-pipeline", async (ctx) => {
    await withAgent("researcher", async (ctx) => {
      // All events here carry:
      // session_id  = "ses_alice"
      // workflow_id = "research-pipeline"
      // agent_id    = "researcher"
      // run_id      = auto-generated
      await client.chat.completions.create({ ... });
    });

    await withAgent("writer", async (ctx) => {
      // session_id  = "ses_alice"
      // workflow_id = "research-pipeline"
      // agent_id    = "writer"
      await client.chat.completions.create({ ... });
    });
  });
});
```

---

## HANDOFF Events

There is no automatic HANDOFF event in TypeScript. Emit it explicitly when transferring control between agents:

```typescript
sdk.emit("HANDOFF", {
  from_agent: "orchestrator",
  to_agent: "researcher",
  reason: "Delegating research phase",
  context: { topic: "Tokyo travel", urgency: "normal" },
});
```

Emit before the receiving agent's first LLM call so the dashboard records the handoff in the correct position on the timeline.

---

## AGENT_FORK / AGENT_JOIN for Parallel Patterns

Wrap parallel branches with fork/join events so the dashboard renders them as a parallel band:

```typescript
sdk.emit("AGENT_FORK", {
  agents: ["researcher-climate", "researcher-hotels", "researcher-food"],
  reason: "Parallel destination research",
});

const [climate, hotels, food] = await Promise.all([
  researchAspect("climate", destination),
  researchAspect("hotels", destination),
  researchAspect("food", destination),
]);

sdk.emit("AGENT_JOIN", {
  agents: ["researcher-climate", "researcher-hotels", "researcher-food"],
  reason: "All researchers completed",
});
```

---

## Config Isolation Per Agent

Each agent in your system gets its own config namespace. Changes to `agents.researcher.llm.temperature` never affect `agents.writer.llm.temperature`:

```typescript
// researcher handle always scoped to agents.researcher.*
const researchModel = researcher.cfg("llm.model", "gpt-4o-mini") as string;  // agents.researcher.llm.model
const researchTemp  = researcher.cfg("llm.temperature", 0.3) as number;       // agents.researcher.llm.temperature

// writer handle always scoped to agents.writer.*
const writeModel = writer.cfg("llm.model", "gpt-4o") as string;               // agents.writer.llm.model
const writeTemp  = writer.cfg("llm.temperature", 0.8) as number;              // agents.writer.llm.temperature
```

The dashboard shows each agent's section independently — you can tune researcher and writer with completely different sliders.

---

## Remote Tool Toggling

Each agent can declare the tools it uses via `handle.tools()`. These appear as on/off switches in the dashboard and can be disabled at runtime without code changes.

```typescript
const researcher = sdk.agent("researcher");
researcher
  .field("llm.model", "gpt-4o-mini")
  .field("llm.temperature", 0.3, { ge: 0, le: 1 })
  .tools(["search_destinations", "get_weather", "check_flights", "find_hotels"]);

// SDK intercepts the tools parameter and strips any tool toggled off in the dashboard
const resp = await client.chat.completions.create({
  model: researcher.cfg("llm.model", "gpt-4o-mini") as string,
  messages,
  tools: ALL_RESEARCHER_TOOLS,  // full list — disabled tools stripped automatically
});
```

---

## Observing Multi-Agent Systems in the Dashboard

Open [app.syrin.ai > Sessions](https://app.syrin.ai) and click any multi-agent session to see the full timeline:

```
Session: u:alice:2026-04-27   [workflow: research-write-edit-pipeline]

  ● SESSION_STARTED       14:32:00.001
  ● WORKFLOW_STARTED      14:32:00.002   workflow=research-write-edit-pipeline
  ● AGENT_RUN_STARTED     14:32:00.003   agentId=researcher
  ● HANDOFF               14:32:00.004   orchestrator → researcher
  ● LLM_CALL              14:32:01.243   gpt-4o-mini  in=82 out=384  $0.002
  ● CHECKPOINT            14:32:01.250   research-done
  ● AGENT_RUN_ENDED       14:32:01.251   agentId=researcher
  ● AGENT_RUN_STARTED     14:32:01.252   agentId=writer
  ● HANDOFF               14:32:01.253   researcher → writer
  ● LLM_CALL              14:32:03.810   gpt-4o  in=512 out=621  $0.012
  ● AGENT_RUN_ENDED       14:32:03.820   agentId=writer
  ● WORKFLOW_ENDED        14:32:05.112   totalCost=$0.014
  ● SESSION_ENDED         14:32:05.115
```

Navigate to [app.syrin.ai > Agents](https://app.syrin.ai) to see per-agent:

- **Topology graph** — visual representation of your agent architecture
- **Per-agent config** — independent sliders for each agent
- **Agent timeline** — per-agent cost, call count, and latency breakdown
