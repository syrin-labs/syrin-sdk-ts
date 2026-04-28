---
title: "Checkpoints"
description: "Save and restore conversation state — manual checkpoints before risky operations, and backend-triggered recovery."
weight: 62
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
- sdk.createCheckpoint() is ASYNC — it returns Promise<Checkpoint>, must be awaited
- sdk.restoreCheckpoint() is ASYNC — returns Promise<Array<Record<string, unknown>> | undefined>
- sdk.listCheckpoints() is SYNCHRONOUS — it reads from in-memory cache, no network call
- Checkpoints are stored in MEMORY ONLY — they are lost on process restart
- sdk.emit("CHECKPOINT", ...) is a TIMELINE ANNOTATION, NOT a state snapshot
- sdk.createCheckpoint() is the STATE SNAPSHOT function — these are two different things
-->

> **AI Agent Quick Reference** — The minimal checkpoint pattern:
> ```typescript
> const sdk = await init({ apiKey: "syrin_pk_..." }); // ← await
> const cp = await sdk.createCheckpoint(messages, { label: "pre-tool-call" }); // ← await
> // ... risky operation ...
> const restored = await sdk.restoreCheckpoint(cp.checkpointId); // ← await
> if (restored) messages = restored;
> ```
> Common mistakes: (1) confusing `sdk.emit("CHECKPOINT", ...)` (timeline annotation) with `sdk.createCheckpoint()` (state snapshot) — they are different; (2) expecting checkpoints to survive process restart — they are in-memory only; (3) forgetting `await` on `createCheckpoint()` and `restoreCheckpoint()`.

## Save Points Before Risky Operations

Your agent is 3 turns deep into a hotel-booking workflow. It's about to call an external API that has a 20% chance of returning garbage data. If the response is bad, you want to roll back to the conversation state before the call — without losing the research that led up to it.

Checkpoints are in-memory snapshots of a session's conversation state. Create one before a risky operation, restore it if something goes wrong. The Syrin backend can also trigger checkpoints and restores autonomously via governance actions.

Checkpoint events appear as ★ annotations on the session timeline at [app.syrin.ai → Sessions](https://app.syrin.ai).

---

## SDK Handles vs. You Handle

| This | SDK does it |
|------|-------------|
| Storing the messages array | You pass it; SDK stores |
| Generating a unique `checkpointId` | SDK |
| Recording `createdAt` timestamp | SDK |
| Persisting across restarts | You (serialize to your own store) |
| Backend-triggered checkpoints (governance) | SDK (when `allowCheckpoint: true`) |

---

## `sdk.createCheckpoint()`

**Signature:**
```typescript
sdk.createCheckpoint(
  messages: Array<Record<string, unknown>>,
  options?: {
    label?: string;
    metadata?: Record<string, unknown>;
    sessionId?: string;
  }
): Promise<Checkpoint>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `messages` | `Array<Record<string, unknown>>` | Yes | The current conversation message list |
| `options.label` | `string` | No | Human-readable label visible in the dashboard |
| `options.metadata` | `Record<string, unknown>` | No | Extra context attached to the checkpoint |
| `options.sessionId` | `string` | No | Defaults to the SDK's active session |

**Returns:** `Promise<Checkpoint>`

```typescript
import { init } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });

const cp = await sdk.createCheckpoint(conversationHistory, {
  label: "pre-tool-call",
  metadata: { phase: "research", turn: 4 },
});

console.log(cp.checkpointId); // "ckpt_a1b2c3..."
```

---

## `sdk.restoreCheckpoint()`

**Signature:**
```typescript
sdk.restoreCheckpoint(
  checkpointId: string
): Promise<Array<Record<string, unknown>> | undefined>
```

Returns the saved message list, or `undefined` if the checkpoint ID was not found.

```typescript
const messages = await sdk.restoreCheckpoint(cp.checkpointId);
if (messages !== undefined) {
  conversationHistory = messages;
  console.log(`Restored ${messages.length} messages`);
}
```

---

## `sdk.listCheckpoints()`

**Signature:**
```typescript
sdk.listCheckpoints(sessionId?: string): Checkpoint[]
```

Synchronous read from the local in-memory cache. No network call. Returns only checkpoints created in the current process — not checkpoints from previous runs.

```typescript
const all = sdk.listCheckpoints();
const forSession = sdk.listCheckpoints("ses_abc123");
```

---

## `Checkpoint` Interface

```typescript
interface Checkpoint {
  checkpointId: string;
  sessionId: string;
  messages: Array<Record<string, unknown>>;
  activeConfig: Record<string, unknown>;
  callCount: number;
  cumulativeCostUsd: number;
  createdAt: string;                        // ISO timestamp
  label?: string;
  metadata: Record<string, unknown>;
}
```

> ⚠️ **Checkpoints are in-memory only.** They are lost when the process restarts. For persistence across restarts, serialize the `messages` array and `checkpointId` to your own store (Redis, database) and restore from there.

---

## Pattern: Pre-Tool-Call Safety Net

```typescript
import { init, withSession } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "my-agent" });
const client = new OpenAI();

type Message = { role: string; content: string };

async function runWithRecovery(messages: Message[]): Promise<string> {
  // Snapshot before the risky operation
  const cp = await sdk.createCheckpoint(messages, { label: "pre-tool-call" });

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: messages as any,
      tools: myTools,
    });

    const choice = response.choices[0];

    if (choice.message.tool_calls?.length) {
      const result = await executeTool(choice.message.tool_calls[0]);

      if (isSuspicious(result)) {
        // Roll back to before the tool call
        const restored = await sdk.restoreCheckpoint(cp.checkpointId);
        if (restored) {
          messages.length = 0;
          messages.push(...(restored as Message[]));
          return "Tool result was suspicious — restored to safe state";
        }
      }

      messages.push(choice.message as any);
      messages.push({ role: "tool", content: String(result) });
    }

    return choice.message.content ?? "";
  } catch (err) {
    // On any failure, restore to the checkpoint
    const restored = await sdk.restoreCheckpoint(cp.checkpointId);
    if (restored) {
      messages.length = 0;
      messages.push(...(restored as Message[]));
    }
    throw err;
  }
}
```

---

## Backend-Triggered Checkpoints

When `allowCheckpoint: true` in your governance policy, the backend can trigger checkpoint creation via governance actions:

```json
{
  "governance": {
    "actions": [
      { "type": "checkpoint", "label": "auto-checkpoint-high-cost" }
    ]
  }
}
```

The SDK creates the checkpoint automatically before the next LLM call. With `allowRestore: true`, the backend can also trigger a restore:

```json
{
  "governance": {
    "actions": [
      { "type": "restore", "checkpoint_id": "ckpt_abc123" }
    ]
  }
}
```

Configure via the `governance` option in `init()`:

```typescript
const sdk = await init({
  apiKey: "syrin_pk_...",
  governance: {
    allowCheckpoint: true,  // backend can create checkpoints
    allowRestore: false,    // backend cannot restore (more disruptive — opt-in separately)
  },
});
```

---

## Timeline Annotations vs. State Snapshots

There are two different checkpoint concepts in the SDK — they are not the same:

| | `sdk.createCheckpoint()` | `sdk.emit("CHECKPOINT", ...)` |
|-|--------------------------|-------------------------------|
| **Purpose** | State snapshot — saves message array | Timeline annotation — marks a milestone |
| **Restorable** | Yes, via `sdk.restoreCheckpoint()` | No — annotation only |
| **Dashboard** | ★ Checkpoint with state metadata | ★ Checkpoint annotation on timeline |
| **Network** | Stores in memory, syncs to backend | Emits to ingest pipeline |

Use `sdk.createCheckpoint()` when you need rollback capability. Use `sdk.emit("CHECKPOINT", ...)` or `sdk.checkpoint()` when you want a visible milestone in the session timeline without needing rollback.

```typescript
// Timeline annotation (milestone, no rollback):
sdk.emit("CHECKPOINT", { name: "research-complete", phase: "1" });
sdk.checkpoint("research-complete", { phase: "1" });  // convenience alias

// State snapshot (restorable):
const cp = await sdk.createCheckpoint(messages, { label: "pre-tool-call" });
```

---

## Governance Configuration for Checkpoints

```typescript
import { init } from "@syrin/sdk";

const sdk = await init({
  apiKey: "syrin_pk_...",
  governance: {
    allowCheckpoint: true,   // backend can create checkpoints (default: true)
    allowRestore: false,     // backend can restore from checkpoints (default: false)
  },
});
```

Restore is the more disruptive action — it mutates your agent's conversation state. Enable it only when you've designed your agent to handle unexpected state resets gracefully.
