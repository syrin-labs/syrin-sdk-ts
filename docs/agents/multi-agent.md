---
title: "Multi-Agent Systems"
description: "Orchestrators, pipelines, parallel swarms, and graph topologies — building and observing multi-agent systems with Syrin."
weight: 51
---

## When One Agent Just Isn't Enough

Multi-agent systems split complex tasks across specialized agents — a researcher that gathers information, a writer that drafts content, an editor that refines it. Syrin provides first-class support for orchestration patterns: sequential pipelines, parallel swarms, hierarchical orchestrators, and arbitrary graphs.

### Registering Sub-Agents

Tell Syrin which agents exist in your system so the dashboard can show the full topology:

```ts
import { init } from "@syrin/sdk";

const sdk = init({
  apiKey: "...",
  agentId: "travel-orchestrator",           // the orchestrator
  agents: {                                  // sub-agents
    "researcher": { description: "Web research and data gathering" },
    "writer":     { description: "Content generation and drafting" },
    "editor":     { description: "Quality review and refinement" },
  },
});
```

You can also pass a plain array if you don't need descriptions at init time:

```ts
const sdk = init({
  apiKey: "...",
  agentId: "travel-orchestrator",
  agents: ["researcher", "writer", "editor"],
});
```

Each sub-agent gets its own config namespace in the dashboard (e.g., `agents.researcher.llm.temperature`).

---

### Topology Types

Define the relationship between agents explicitly:

```ts
sdk.defineTopology({
  type: "orchestrator",        // orchestrator | pipeline | parallel | graph | swarm | hierarchical | mesh
  nodes: {
    "travel-orchestrator": { role: "orchestrator" },
    "researcher":           { role: "worker", execMode: "parallel" },
    "writer":               { role: "worker", execMode: "sequential" },
    "editor":               { role: "worker", execMode: "sequential" },
  },
  edges: [
    { from: "travel-orchestrator", to: "researcher" },
    { from: "travel-orchestrator", to: "writer" },
    { from: "writer",              to: "editor" },
  ],
  entryPoint: "travel-orchestrator",
  terminalNodes: ["editor"],
});
```

Or pass topology directly to `init()`:

```ts
const sdk = init({
  apiKey: "...",
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

### Pattern 1: Sequential Pipeline

Agents run one after another. Each passes its output to the next.

```ts
import { init } from "@syrin/sdk";
import OpenAI from "openai";

const client = new OpenAI();
const sdk = init({ apiKey: "...", agentId: "travel-orchestrator" });

const researcher = sdk.agent("researcher");
const writer     = sdk.agent("writer");
const editor     = sdk.agent("editor");

async function runResearcher(topic: string): Promise<string> {
  const resp = await client.chat.completions.create({
    model: researcher.cfg("llm.model", "gpt-4o-mini"),
    messages: [{ role: "user", content: `Research: ${topic}` }],
  });
  return resp.choices[0].message.content ?? "";
}

async function runWriter(researchNotes: string): Promise<string> {
  const resp = await client.chat.completions.create({
    model: writer.cfg("llm.model", "gpt-4o"),
    messages: [{ role: "user", content: `Write article from: ${researchNotes}` }],
  });
  return resp.choices[0].message.content ?? "";
}

async function runEditor(draft: string): Promise<string> {
  const resp = await client.chat.completions.create({
    model: editor.cfg("llm.model", "gpt-4o-mini"),
    messages: [{ role: "user", content: `Edit for clarity and tone: ${draft}` }],
  });
  return resp.choices[0].message.content ?? "";
}

async function runPipeline(userId: string, topic: string): Promise<string> {
  return sdk.withSession({ userId, window: "day" }, async (sess) => {
    sdk.emit("HANDOFF", { from_agent: "travel-orchestrator", to_agent: "researcher" });
    const notes = await runResearcher(topic);
    sdk.emit("CHECKPOINT", { name: "research-done" });

    sdk.emit("HANDOFF", { from_agent: "researcher", to_agent: "writer" });
    const draft = await runWriter(notes);
    sdk.emit("CHECKPOINT", { name: "draft-done" });

    sdk.emit("HANDOFF", { from_agent: "writer", to_agent: "editor" });
    const final = await runEditor(draft);
    sdk.emit("CHECKPOINT", { name: "edit-done" });

    sess.feedback.positive({ reason: "Pipeline completed" });
    return final;
  });
}
```

---

### Pattern 2: Parallel with Promise.all

Agents run concurrently. Emit `AGENT_FORK` before launching and `AGENT_JOIN` after all settle.

```ts
import { init } from "@syrin/sdk";
import OpenAI from "openai";

const client = new OpenAI();
const sdk = init({ apiKey: "...", agentId: "travel-orchestrator" });

async function researchAspect(aspect: string, destination: string): Promise<string> {
  const handle = sdk.agent(`researcher-${aspect}`);
  const resp = await client.chat.completions.create({
    model: handle.cfg("llm.model", "gpt-4o-mini"),
    messages: [{ role: "user", content: `Research ${aspect} for ${destination}` }],
  });
  return resp.choices[0].message.content ?? "";
}

async function runParallelResearch(userId: string, destination: string): Promise<string[]> {
  return sdk.withSession({ userId, window: "day" }, async () => {
    const aspects = ["climate", "hotels", "food", "transport", "culture"];

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
  });
}
```

---

### Pattern 3: Orchestrator with AgentHandle

Use `sdk.agent()` to get a handle for each agent, declare their config fields at startup, then use `handle.cfg()` inside request handlers:

```ts
import { init } from "@syrin/sdk";
import OpenAI from "openai";

const client = new OpenAI();
const sdk = init({ apiKey: "...", agentId: "orchestrator" });

// Declare fields at startup — they appear in the dashboard immediately
const researcher = sdk.agent("researcher");
researcher.field("llm.model", "gpt-4o-mini", { enum: ["gpt-4o", "gpt-4o-mini"] });
researcher.field("llm.temperature", 0.3, { ge: 0, le: 1, label: "Research Temperature" });
researcher.field("prompt.systemPrompt", "You research topics thoroughly.", { multiline: true });

const writer = sdk.agent("writer");
writer.field("llm.model", "gpt-4o");
writer.field("llm.temperature", 0.7, { ge: 0, le: 2 });
writer.field("prompt.systemPrompt", "You write clear, engaging articles.", { multiline: true });

async function runWithHandles(userId: string, topic: string): Promise<string> {
  return sdk.withSession({ userId, window: "day" }, async () => {
    sdk.emit("HANDOFF", { from_agent: "orchestrator", to_agent: "researcher" });

    // researcher.cfg() always reads from agents.researcher.* namespace
    const researchResp = await client.chat.completions.create({
      model: researcher.cfg("llm.model", "gpt-4o-mini"),
      temperature: researcher.cfg("llm.temperature", 0.3) as number,
      messages: [{ role: "user", content: `Research: ${topic}` }],
    });
    const notes = researchResp.choices[0].message.content ?? "";

    sdk.emit("HANDOFF", { from_agent: "researcher", to_agent: "writer" });

    const writeResp = await client.chat.completions.create({
      model: writer.cfg("llm.model", "gpt-4o"),
      temperature: writer.cfg("llm.temperature", 0.7) as number,
      messages: [{ role: "user", content: `Write article from: ${notes}` }],
    });
    return writeResp.choices[0].message.content ?? "";
  });
}
```

---

### Pattern 4: HTTP Router with `createAgentRouter`

For microservice-style deployments where each agent runs as its own HTTP handler:

```ts
import express from "express";
import { init, createAgentRouter } from "@syrin/sdk";

const sdk = init({ apiKey: "...", agentId: "orchestrator" });

// Express
const app = express();
app.use(express.json());

const agentRouter = createAgentRouter({
  "researcher-agent": async (task: string) => {
    const handle = sdk.agent("researcher-agent");
    // ... call LLM with handle.cfg() ...
    return `Research result for: ${task}`;
  },
  "writer-agent": async (task: string) => {
    const handle = sdk.agent("writer-agent");
    // ... call LLM with handle.cfg() ...
    return `Article draft: ${task}`;
  },
});

app.post("/agent/:agentId", agentRouter);
app.listen(3000);
```

For Fastify:

```ts
import Fastify from "fastify";
import { createAgentRouter } from "@syrin/sdk";

const fastify = Fastify();

fastify.post("/agent/:agentId", createAgentRouter({
  "researcher-agent": async (task) => { /* ... */ return ""; },
  "writer-agent":     async (task) => { /* ... */ return ""; },
}));

fastify.listen({ port: 3000 });
```

---

### HANDOFF Events

There is no automatic context-tracking in TypeScript the way Python's async context vars work. Emit `HANDOFF` explicitly when transferring control between agents:

```ts
// Manual emit — always preferred for clarity
sdk.emit("HANDOFF", {
  from_agent: "orchestrator",
  to_agent: "researcher",
  reason: "Delegating research phase",
  context: { topic: "Tokyo travel", urgency: "normal" },
});
```

Emit before the receiving agent's first LLM call so the dashboard records the handoff in the correct position on the timeline.

---

### AGENT_FORK / AGENT_JOIN for Parallel Patterns

Wrap parallel branches with fork/join events so the dashboard renders them as a parallel band rather than sequential steps:

```ts
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

### Config Isolation Per Agent

Each agent in your system gets its own config namespace in the dashboard. Changes to `agents.researcher.llm.temperature` don't affect `agents.writer.llm.temperature`:

```ts
// researcher handle always scoped to agents.researcher.*
const researchModel = researcher.cfg("llm.model", "gpt-4o-mini");  // agents.researcher.llm.model
const researchTemp  = researcher.cfg("llm.temperature", 0.3);       // agents.researcher.llm.temperature

// writer handle always scoped to agents.writer.*
const writeModel = writer.cfg("llm.model", "gpt-4o");               // agents.writer.llm.model
const writeTemp  = writer.cfg("llm.temperature", 0.8);              // agents.writer.llm.temperature
```

The dashboard shows each agent's section independently — you can tune the researcher and writer with completely different sliders.

---

### Remote Tool Toggling

Each agent can declare the tools it uses via `handle.tools()`. These appear as on/off switches in the dashboard (Agents → agent → Config → Tools section) and can be disabled at runtime without any code changes.

```ts
const researcher = sdk.agent("researcher");
researcher
  .field("llm.model", "gpt-4o-mini")
  .field("llm.temperature", 0.3, { ge: 0, le: 1 })
  .tools(["search_destinations", "get_weather", "check_flights", "find_hotels"]);

const writer = sdk.agent("writer");
writer
  .field("llm.model", "gpt-4o")
  .tools(["format_markdown", "generate_itinerary"]);
```

**Dashboard toggle → SDK filtering flow:**

1. `tools()` registers tool names under the agent's schema section on startup.
2. The dashboard shows each tool as a toggle switch per agent.
3. Toggle a tool off and click Push — backend records `agents.researcher.tools.get_weather: false`.
4. The SDK receives the update via SSE and marks that tool as disabled for that session.
5. The next LLM call with `tools` has `get_weather` stripped automatically.

```ts
// SDK intercepts the tools parameter and strips any tool toggled off in the dashboard
const resp = await client.chat.completions.create({
  model: researcher.cfg("llm.model", "gpt-4o-mini") as string,
  messages,
  tools: ALL_RESEARCHER_TOOLS,  // full list — disabled tools are stripped before the call
});
```

Tool states are per-session and per-agent — toggling `researcher`'s `get_weather` off does not affect `writer`'s tools or any other agent.

---

### Observing Multi-Agent Systems in the Dashboard

Open [app.syrin.ai → Sessions](https://app.syrin.ai) and click any multi-agent session to see the full handoff timeline:

```
Session: u:alice:2026-04-27   [workflow: research-write-edit-pipeline]

  ● SESSION_STARTED       14:32:00.001
  ● WORKFLOW_STARTED      14:32:00.002   workflow=research-write-edit-pipeline
  ● AGENT_RUN_STARTED     14:32:00.003   agentId=researcher
  ● LLM_CALL              14:32:01.243   gpt-4o-mini  in=82 out=384  $0.002
  ● CHECKPOINT            14:32:01.250   research-done
  ● HANDOFF               14:32:01.251   researcher → writer
  ● AGENT_RUN_STARTED     14:32:01.252   agentId=writer
  ● LLM_CALL              14:32:03.810   gpt-4o  in=512 out=621  $0.012
  ● HANDOFF               14:32:03.821   writer → editor
  ● AGENT_RUN_STARTED     14:32:03.822   agentId=editor
  ● LLM_CALL              14:32:05.100   gpt-4o-mini  in=743 out=187  $0.004
  ● WORKFLOW_ENDED        14:32:05.112   totalCost=$0.018
  ● SESSION_ENDED         14:32:05.115
```

Navigate to [app.syrin.ai → Agents](https://app.syrin.ai) to see per-agent:

- **Topology graph** — visual representation of your agent architecture
- **Per-agent config** — independent sliders for researcher, writer, and editor — completely separate controls
- **Agent timeline** — per-agent cost, call count, and latency breakdown
- **Handoff trace** — visualizes the handoff chain with timestamps
- **Session replay** — see exactly which agent handled which part of the conversation
