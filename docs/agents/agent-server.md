---
title: "AgentServer & MultiAgentRouter"
description: "Pre-built HTTP handlers for /agent/run, /agent/chat, and /agent/health — plug into Express, Fastify, or any Node.js framework."
weight: 50
---

## HTTP Endpoints for Your Agent, Zero Routing Code

`AgentServer` and `MultiAgentRouter` give your agent a production-ready HTTP interface. They provide `POST /agent/run`, `POST /agent/chat`, and `GET /agent/:agentId/health` with session management, `AsyncLocalStorage` context propagation, and error handling built in.

### MultiAgentRouter (Recommended)

`MultiAgentRouter` routes requests to per-agent handler functions based on the `agent_id` in the request body. Create one with `createAgentRouter()`:

```typescript
import { init, createAgentRouter } from '@syrin/sdk';
import OpenAI from 'openai';

const sdk = await init({ apiKey: '...', agentId: 'travel-assistant' });
const client = new OpenAI();

async function travelAgent(task: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: task }],
  });
  return response.choices[0].message.content ?? '';
}

const router = createAgentRouter({
  'travel-assistant': travelAgent,
});
```

### Attaching to a Framework

#### Express

```typescript
import express from 'express';

const app = express();
app.use(express.json());
app.use(router.express());

app.listen(8000);
// Endpoints now available:
// POST /agent/run
// POST /agent/chat
// GET  /agent/:agentId/health
```

#### Fastify

```typescript
import Fastify from 'fastify';

const fastify = Fastify();
await fastify.register(router.fastify());

await fastify.listen({ port: 8000 });
```

### Endpoint Reference

#### `POST /agent/run`

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

#### `POST /agent/chat`

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

**Request (shorthand with task or message):**
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

#### `GET /agent/:agentId/health`

Check if an agent is registered and online.

**Response (online):**
```json
{ "ok": true, "agent_id": "travel-assistant", "status": "online" }
```

**Response (not registered):**
```json
{ "ok": true, "agent_id": "unknown-agent", "status": "offline" }
```

### Session Metadata Fields

Include `syrin_*` fields in any request body to control session behavior. These are stripped before passing the payload to your handler:

| Field | Description |
|-------|-------------|
| `syrin_session_id` | Use an explicit session ID |
| `syrin_session_type` | `"production"`, `"chat_test"`, `"workflow_test"`, `"simulation"` (default: `"production"`) |

### Multi-Agent Routing

Route to different agents based on `agent_id`:

```typescript
import { createAgentRouter } from '@syrin/sdk';

async function researcher(task: string): Promise<string> {
  // ...
  return 'research results';
}

async function writer(task: string): Promise<string> {
  // ...
  return 'written content';
}

const router = createAgentRouter({
  researcher,
  writer,
});

// Now supports:
// POST /agent/run  { "agent_id": "researcher", "task": "..." }
// POST /agent/run  { "agent_id": "writer", "task": "..." }
// GET  /agent/researcher/health
// GET  /agent/writer/health
```

### AgentServer (Single-Agent Variant)

`AgentServer` is a simpler variant for single-agent deployments. It exposes the same endpoints but without per-agent routing:

```typescript
import { init, AgentServer } from '@syrin/sdk';
import OpenAI from 'openai';

const sdk = await init({ apiKey: '...', agentId: 'assistant' });
const client = new OpenAI();

const server = new AgentServer({
  onRun: async (task, sessionId) => {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: task }],
    });
    return { result: response.choices[0].message.content ?? '' };
  },
  onChat: async (messages, sessionId) => {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages,
    });
    return { message: response.choices[0].message.content ?? '' };
  },
});

// Attach to Express
const app = express();
app.use(express.json());
app.use(server.express());
```

### Full Express Example

```typescript
import { init, createAgentRouter } from '@syrin/sdk';
import express from 'express';
import OpenAI from 'openai';

const client = new OpenAI();

const sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  agentId: 'travel-assistant',
  sessionTtlMs: 3_600_000,
});

async function runTravelAgent(task: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: sdk.agent('travel-assistant').cfg('llm.model', 'gpt-4o'),
    messages: [
      { role: 'system', content: 'You are an expert travel assistant.' },
      { role: 'user', content: task },
    ],
  });
  return response.choices[0].message.content ?? '';
}

const router = createAgentRouter({ 'travel-assistant': runTravelAgent });

const app = express();
app.use(express.json());
app.use(router.express());
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(8000, () => console.log('Agent server on :8000'));
```

```bash
curl -X POST http://localhost:8000/agent/run \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "travel-assistant", "task": "Best cities in Japan for first-time visitors"}'
```
