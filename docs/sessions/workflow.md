---
title: "withWorkflow() & withSwarm()"
description: "Group sequential agents into named workflows and parallel agents into swarms — with lifecycle events on the dashboard timeline."
weight: 33
---

## Sequential and Parallel Agent Groups

`withWorkflow()` and `withSwarm()` are `AsyncLocalStorage`-scoped context functions that annotate the dashboard timeline with workflow and swarm boundaries.

- `withWorkflow()` — groups sequential agents. Emits `WORKFLOW_STARTED` / `WORKFLOW_ENDED`.
- `withSwarm()` — groups parallel agents. Emits `SWARM_STARTED` / `SWARM_ENDED`.

### `withWorkflow()` Basic Usage

```typescript
import { withWorkflow, withAgent } from '@syrin/sdk';

await withWorkflow('research-write-pipeline', async () => {
  // All events inside carry workflow_id = "research-write-pipeline"

  await withAgent('researcher', async () => {
    // researcher agent
  });

  await withAgent('writer', async () => {
    // writer agent
  });
});
```

**Function signature:**

```typescript
function withWorkflow<T>(workflowId: string, fn: () => Promise<T>): Promise<T>
```

### `withSwarm()` Basic Usage

```typescript
import { withSwarm } from '@syrin/sdk';

await withSwarm('research-swarm', async () => {
  // Parallel execution — all events carry swarm_id = "research-swarm"
  const [resultA, resultB, resultC] = await Promise.all([
    runResearcher('topic A'),
    runResearcher('topic B'),
    runResearcher('topic C'),
  ]);
  return [resultA, resultB, resultC];
});
```

**Function signature:**

```typescript
function withSwarm<T>(swarmId: string, fn: () => Promise<T>): Promise<T>
```

### Lifecycle Events

| Event | When |
|-------|------|
| `WORKFLOW_STARTED` | Entering `withWorkflow()` |
| `WORKFLOW_ENDED` | Exiting `withWorkflow()` normally |
| `SWARM_STARTED` | Entering `withSwarm()` |
| `SWARM_ENDED` | Exiting `withSwarm()` normally |

These appear on the dashboard session timeline as boundary markers.

### Combining Session + Workflow

```typescript
import { withSession, withWorkflow, withAgent } from '@syrin/sdk';

await withSession('ses_alice_001', async () => {
  await withWorkflow('research-pipeline', async () => {
    // Events carry both session_id and workflow_id

    await withAgent('researcher', async () => {
      const research = await runResearch('Paris');
    });

    await withAgent('writer', async () => {
      const report = await writeReport(research);
    });
  });
});
```

### Nested Workflows

Workflows can be nested. The inner workflow's events carry the outer workflow's `run_id` in the `parent_run_id` field:

```typescript
await withWorkflow('outer-pipeline', async () => {
  await withWorkflow('inner-pipeline', async () => {
    // inner workflow_id = "inner-pipeline"
    // parent_run_id    = outer workflow's run_id
  });
});
```

### Full Pipeline Example

```typescript
import { withSession, withAgent, withWorkflow } from '@syrin/sdk';
import OpenAI from 'openai';

const client = new OpenAI();

async function research(query: string): Promise<string> {
  return withAgent('researcher', async () => {
    const resp = await client.chat.completions.create({
      model: sdk.agent('researcher').cfg('llm.model', 'gpt-4o-mini'),
      messages: [{ role: 'user', content: `Research: ${query}` }],
    });
    return resp.choices[0].message.content ?? '';
  });
}

async function write(notes: string): Promise<string> {
  return withAgent('writer', async () => {
    const resp = await client.chat.completions.create({
      model: sdk.agent('writer').cfg('llm.model', 'gpt-4o'),
      messages: [{ role: 'user', content: `Write article from: ${notes}` }],
    });
    return resp.choices[0].message.content ?? '';
  });
}

async function edit(draft: string): Promise<string> {
  return withAgent('editor', async () => {
    const resp = await client.chat.completions.create({
      model: sdk.agent('editor').cfg('llm.model', 'gpt-4o-mini'),
      messages: [{ role: 'user', content: `Edit for clarity: ${draft}` }],
    });
    return resp.choices[0].message.content ?? '';
  });
}

async function runPipeline(userId: string, topic: string): Promise<string> {
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  return withSession(sessionId, () =>
    withWorkflow('research-write-edit', async () => {
      sdk.log(`Starting pipeline for: ${topic}`);

      const notes = await research(topic);
      sdk.emit('CHECKPOINT', { name: 'research-done', phase: '1' });

      const draft = await write(notes);
      sdk.emit('CHECKPOINT', { name: 'draft-done', phase: '2' });

      const final = await edit(draft);
      sdk.emit('CHECKPOINT', { name: 'edit-done', phase: '3' });

      return final;
    })
  );
}

const result = await runPipeline('alice', 'Travel trends 2026');
```

### Parallel Swarm Example

```typescript
import { withSession, withSwarm } from '@syrin/sdk';

async function runParallelResearch(userId: string, topics: string[]): Promise<string[]> {
  const sessionId = `u:${userId}:${new Date().toISOString().slice(0, 10)}`;

  return withSession(sessionId, () =>
    withSwarm('research-swarm', async () => {
      sdk.emit('AGENT_FORK', {
        agents: topics.map((_, i) => `researcher-${i}`),
        reason: 'Parallelizing research',
      });

      const results = await Promise.all(
        topics.map((topic, i) =>
          withAgent(`researcher-${i}`, async () => {
            const resp = await client.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [{ role: 'user', content: `Research: ${topic}` }],
            });
            return resp.choices[0].message.content ?? '';
          })
        )
      );

      sdk.emit('AGENT_JOIN', {
        agents: topics.map((_, i) => `researcher-${i}`),
        reason: 'All parallel researchers completed',
      });

      return results;
    })
  );
}
```
