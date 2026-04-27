---
title: "Session & Agent Context"
description: "withSession(), withAgent(), withWorkflow(), withSwarm() — AsyncLocalStorage-based context scoping for sessions, agents, workflows, and swarms."
weight: 30
---

## Scope Every LLM Call to a Session and Agent

The TypeScript SDK provides four `AsyncLocalStorage`-backed context functions. Each wraps your callback with the relevant scope — session ID, agent ID, workflow ID, or swarm ID — so the SDK can automatically resolve these fields for all events emitted inside, and group them correctly on the session timeline at [app.syrin.ai](https://app.syrin.ai).

```typescript
import { withSession, withAgent, withWorkflow, withSwarm } from '@syrin/sdk';
```

> **Python users:** The Python SDK uses a single unified `context()` function (sync + async). The TypeScript SDK uses four separate async functions — `withSession`, `withAgent`, `withWorkflow`, `withSwarm` — that can be nested or combined.

### `withSession()`

Scopes a callback to a session ID. All events emitted inside carry this session ID.

```typescript
import { withSession } from '@syrin/sdk';

await withSession('ses_alice_001', async () => {
  // All SDK events here are tagged with session_id = "ses_alice_001"
  const response = await client.chat.completions.create({ ... });
});
```

**Function signature:**

```typescript
function withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T>
```

---

### `withAgent()`

Scopes a callback to an agent ID. All `cfg()` calls inside the scope resolve to the `agents.<agentId>.*` namespace.

```typescript
import { withAgent } from '@syrin/sdk';

await withAgent('researcher', async () => {
  // cfg() uses agents.researcher.* namespace here
  const model = sdk.agent('researcher').cfg('llm.model', 'gpt-4o-mini');
  const response = await client.chat.completions.create({ model, ... });
});
```

**Function signature:**

```typescript
function withAgent<T>(agentId: string, fn: () => Promise<T>): Promise<T>
```

---

### `withWorkflow()`

Scopes a callback to a workflow ID. Emits `WORKFLOW_STARTED` on entry and `WORKFLOW_ENDED` on exit. Groups all agent runs inside under the same workflow ID.

```typescript
import { withWorkflow } from '@syrin/sdk';

await withWorkflow('research-write-pipeline', async () => {
  const research = await runResearcher(query);
  const article = await runWriter(research);
});
```

**Function signature:**

```typescript
function withWorkflow<T>(workflowId: string, fn: () => Promise<T>): Promise<T>
```

---

### `withSwarm()`

Scopes a callback to a swarm ID. Emits `SWARM_STARTED` on entry and `SWARM_ENDED` on exit. Groups parallel workers under the same swarm.

```typescript
import { withSwarm } from '@syrin/sdk';

await withSwarm('research-swarm', async () => {
  const results = await Promise.all([
    runResearcher('topic A'),
    runResearcher('topic B'),
    runResearcher('topic C'),
  ]);
});
```

**Function signature:**

```typescript
function withSwarm<T>(swarmId: string, fn: () => Promise<T>): Promise<T>
```

---

### Nesting Contexts

All four context functions use `AsyncLocalStorage` and can be nested freely. Inner contexts override outer contexts for their specific field only:

```typescript
import { withSession, withAgent, withWorkflow } from '@syrin/sdk';

await withSession('ses_alice', async () => {
  await withWorkflow('research-pipeline', async () => {
    await withAgent('researcher', async () => {
      // session_id  = 'ses_alice'
      // workflow_id = 'research-pipeline'
      // agent_id    = 'researcher'
      const research = await runResearch(query);
    });

    await withAgent('writer', async () => {
      // session_id  = 'ses_alice'
      // workflow_id = 'research-pipeline'
      // agent_id    = 'writer'
      const article = await runWriter(research);
    });
  });
});
```

---

### Deterministic Session IDs

The TypeScript SDK doesn't have a built-in `WindowType` / user-day pattern like the Python SDK. Build deterministic session IDs yourself:

```typescript
function userDaySession(userId: string): string {
  const today = new Date().toISOString().slice(0, 10); // "2026-04-26"
  return `u:${userId}:${today}`;
}

await withSession(userDaySession('alice'), async () => {
  const response = await client.chat.completions.create({ ... });
});
```

---

### Session Metadata

Pass metadata about the session by emitting a `SESSION_STARTED` event manually:

```typescript
await withSession('ses_alice_001', async () => {
  sdk.emit('SESSION_STARTED', {
    user_id: 'alice',
    plan: 'premium',
    region: 'us-east-1',
  });

  const response = await client.chat.completions.create({ ... });
});
```

---

### Lifecycle Events

| Trigger | Event |
|---------|-------|
| `withWorkflow()` enter | `WORKFLOW_STARTED` |
| `withWorkflow()` exit | `WORKFLOW_ENDED` |
| `withSwarm()` enter | `SWARM_STARTED` |
| `withSwarm()` exit | `SWARM_ENDED` |
| Custom via `emit()` | `SESSION_STARTED`, `AGENT_RUN_STARTED`, etc. |

> **Note:** `withSession()` and `withAgent()` do not automatically emit lifecycle events — they only set the `AsyncLocalStorage` context. Use `sdk.emit()` to emit lifecycle events when needed.

---

### HTTP Request Handler Pattern

```typescript
import { withSession, withAgent } from '@syrin/sdk';
import express from 'express';

const app = express();
app.use(express.json());

app.post('/chat', async (req, res) => {
  const { user_id, messages } = req.body;
  const sessionId = `u:${user_id}:${new Date().toISOString().slice(0, 10)}`;

  const reply = await withSession(sessionId, () =>
    withAgent('chat-bot', async () => {
      const response = await client.chat.completions.create({
        model: sdk.agent('chat-bot').cfg('llm.model', 'gpt-4o'),
        messages,
      });
      return response.choices[0].message.content ?? '';
    })
  );

  res.json({ session_id: sessionId, content: reply });
});
```

---

### Full Pipeline Example

```typescript
import { withSession, withAgent, withWorkflow } from '@syrin/sdk';
import OpenAI from 'openai';

const client = new OpenAI();

async function research(query: string): Promise<string> {
  return withAgent('researcher', async () => {
    const response = await client.chat.completions.create({
      model: sdk.agent('researcher').cfg('llm.model', 'gpt-4o-mini'),
      messages: [{ role: 'user', content: `Research: ${query}` }],
    });
    return response.choices[0].message.content ?? '';
  });
}

async function write(notes: string): Promise<string> {
  return withAgent('writer', async () => {
    const response = await client.chat.completions.create({
      model: sdk.agent('writer').cfg('llm.model', 'gpt-4o'),
      messages: [{ role: 'user', content: `Write article from: ${notes}` }],
    });
    return response.choices[0].message.content ?? '';
  });
}

async function runPipeline(userId: string, topic: string): Promise<string> {
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  return withSession(sessionId, () =>
    withWorkflow('research-write', async () => {
      sdk.log(`Starting pipeline for: ${topic}`);

      const notes = await research(topic);
      sdk.emit('CHECKPOINT', { name: 'research-done', phase: '1' });

      const article = await write(notes);
      sdk.emit('CHECKPOINT', { name: 'write-done', phase: '2' });

      return article;
    })
  );
}
```
