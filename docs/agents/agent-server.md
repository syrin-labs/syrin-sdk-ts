---
title: "AgentServer & MultiAgentRouter"
description: "Pre-built HTTP handlers for /agent/run, /agent/chat, and /agent/health — plug into Express, Fastify, or any Node.js framework."
weight: 51
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
- createAgentRouter() is a method on sdk, not a module-level function (use sdk.createAgentRouter())
- AgentServer is also constructed via sdk.createServer(options), not new AgentServer() directly
- router.express() returns middleware to pass to app.use(), not a route handler
-->

> **AI Agent Quick Reference** — The minimal working agent server:
> ```typescript
> import { init } from "@syrin/sdk";
> import express from "express";
> import OpenAI from "openai";
>
> const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });
> const client = new OpenAI();
>
> const router = sdk.createAgentRouter({
>   "my-agent": async (task) => {
>     const resp = await client.chat.completions.create({
>       model: "gpt-4o",
>       messages: [{ role: "user", content: task }],
>     });
>     return resp.choices[0].message.content ?? "";
>   },
> });
>
> const app = express();
> app.use(express.json());
> app.use(router.express());
> app.listen(8000);
> ```
> Common mistakes: (1) using `new MultiAgentRouter(...)` directly instead of `sdk.createAgentRouter()`; (2) forgetting `express.json()` middleware before mounting the router; (3) passing the handler function itself to `app.post()` instead of calling `router.express()`.

## HTTP Endpoints for Your Agent, Zero Routing Code

`MultiAgentRouter` and `AgentServer` give your agent a production-ready HTTP interface. They provide `POST /agent/run`, `POST /agent/chat`, and `GET /agent/:agentId/health` with session management, `AsyncLocalStorage` context propagation, and error handling built in.

---

## MultiAgentRouter (Recommended)

`MultiAgentRouter` routes requests to per-agent handler functions based on the `agent_id` in the request body. Create one via `sdk.createAgentRouter()`:

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "travel-assistant" });
const client = new OpenAI();

const router = sdk.createAgentRouter({
  "travel-assistant": async (task: string): Promise<string> => {
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: task }],
    });
    return response.choices[0].message.content ?? "";
  },
});
```

### Attaching to a Framework

**Express:**

```typescript
import express from "express";

const app = express();
app.use(express.json());
app.use(router.express());  // mounts /agent/run, /agent/chat, /agent/:id/health

app.listen(8000);
```

**Fastify:**

```typescript
import Fastify from "fastify";

const fastify = Fastify();
await fastify.register(router.fastify());

await fastify.listen({ port: 8000 });
```

---

## Endpoint Reference

### `POST /agent/run`

Execute a one-shot task.

**Request:**
```json
{
  "agent_id": "travel-assistant",
  "task": "Plan a 7-day trip to Tokyo for 2 people",
  "syrin_session_id": "ses_optional_explicit_id",
  "syrin_session_type": "production"
}
```

**Response:**
```json
{
  "ok": true,
  "session_id": "ses_a1b2c3",
  "agent_id": "travel-assistant",
  "result": "Here is a 7-day Tokyo itinerary..."
}
```

---

### `POST /agent/chat`

Multi-turn conversation.

**Request (with messages array):**
```json
{
  "agent_id": "travel-assistant",
  "messages": [
    { "role": "user", "content": "I want to visit Japan" },
    { "role": "assistant", "content": "Great choice! When are you planning to go?" },
    { "role": "user", "content": "Next April" }
  ],
  "syrin_session_id": "ses_abc123"
}
```

**Request (shorthand with task field):**
```json
{
  "agent_id": "travel-assistant",
  "task": "What's the best time to visit Kyoto?",
  "syrin_session_id": "ses_abc123"
}
```

**Response:**
```json
{
  "ok": true,
  "session_id": "ses_abc123",
  "agent_id": "travel-assistant",
  "message": "April is perfect for cherry blossoms in Kyoto..."
}
```

---

### `GET /agent/:agentId/health`

Check if an agent is registered and online.

**Response (online):**
```json
{ "ok": true, "agent_id": "travel-assistant", "status": "online" }
```

**Response (not registered):**
```json
{ "ok": true, "agent_id": "unknown-agent", "status": "offline" }
```

---

## Session Metadata Fields

Include `syrin_*` fields in any request body to control session behavior. These are stripped before passing the payload to your handler:

| Field | Type | Description |
|-------|------|-------------|
| `syrin_session_id` | `string` | Use an explicit session ID instead of auto-generating |
| `syrin_session_type` | `string` | `"production"` (default), `"chat_test"`, `"workflow_test"`, `"simulation"` |

---

## Multi-Agent Routing

Route to different agent functions based on `agent_id`:

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  agentId: "orchestrator",
  agents: ["researcher", "writer"],
});

const client = new OpenAI();

const router = sdk.createAgentRouter({
  researcher: async (task: string): Promise<string> => {
    const resp = await client.chat.completions.create({
      model: sdk.agent("researcher").cfg("llm.model", "gpt-4o-mini") as string,
      messages: [{ role: "user", content: task }],
    });
    return resp.choices[0].message.content ?? "";
  },

  writer: async (task: string): Promise<string> => {
    const resp = await client.chat.completions.create({
      model: sdk.agent("writer").cfg("llm.model", "gpt-4o") as string,
      messages: [{ role: "user", content: task }],
    });
    return resp.choices[0].message.content ?? "";
  },
});

// Now supports:
// POST /agent/run  { "agent_id": "researcher", "task": "..." }
// POST /agent/run  { "agent_id": "writer", "task": "..." }
// GET  /agent/researcher/health
// GET  /agent/writer/health
```

---

## AgentServer (Single-Agent Variant)

`AgentServer` is a simpler variant for single-agent deployments. Use it when you have one agent and want the pre-built endpoints without per-agent routing:

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";
import express from "express";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "assistant" });
const client = new OpenAI();

const server = sdk.createServer({
  onRun: async (task: string, sessionId: string): Promise<{ result: string }> => {
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: task }],
    });
    return { result: response.choices[0].message.content ?? "" };
  },
  onChat: async (
    messages: Array<{ role: string; content: string }>,
    sessionId: string
  ): Promise<{ message: string }> => {
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: messages as any,
    });
    return { message: response.choices[0].message.content ?? "" };
  },
});

const app = express();
app.use(express.json());
app.use(server.express());
```

---

## Full Express Example

```typescript
import { init } from "@syrin/sdk";
import express from "express";
import OpenAI from "openai";

const client = new OpenAI();

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  agentId: "travel-assistant",
  sessionTtlMs: 3_600_000,  // evict sessions older than 1 hour
});

const agent = sdk.agent("travel-assistant");
agent
  .field("llm.model", "gpt-4o", { enum: ["gpt-4o", "gpt-4o-mini"] })
  .field("llm.temperature", 0.7, { ge: 0, le: 2 });

const router = sdk.createAgentRouter({
  "travel-assistant": async (task: string): Promise<string> => {
    const response = await client.chat.completions.create({
      model: agent.cfg("llm.model", "gpt-4o") as string,
      temperature: agent.cfg("llm.temperature", 0.7) as number,
      messages: [
        { role: "system", content: "You are an expert travel assistant." },
        { role: "user", content: task },
      ],
    });
    return response.choices[0].message.content ?? "";
  },
});

const app = express();
app.use(express.json());
app.use(router.express());
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(8000, () => console.log("Agent server on :8000"));
```

**Test with curl:**

```bash
curl -X POST http://localhost:8000/agent/run \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "travel-assistant", "task": "Best cities in Japan for first-time visitors"}'
```
