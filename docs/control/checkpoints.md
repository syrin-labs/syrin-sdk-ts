---
title: "Checkpoints"
description: "Save and restore conversation state — manual checkpoints before risky operations, and backend-triggered recovery."
weight: 62
---

## Save Points for Your Agent, Not Just Your Game

Checkpoints are in-memory snapshots of a session's conversation state. Save before a risky operation; restore if something goes wrong. The Syrin backend can also trigger checkpoints and restores autonomously via governance actions.

Checkpoint events appear as ★ annotations on the session timeline at [app.syrin.ai → Sessions](https://app.syrin.ai), and backend-triggered checkpoints are recorded in the Governance panel.

### Manual Checkpoints

#### `sdk.createCheckpoint()`

```ts
import { getSdk } from "@syrin/sdk";

const sdk = getSdk();

const cp = await sdk.createCheckpoint(conversationHistory, {
  label: "pre-tool-call",
  metadata: { phase: "research", turn: 4 },
});

console.log(cp.checkpointId); // "ckpt_a1b2c3..."
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `messages` | `Array<Record<string, unknown>>` | The current conversation message list |
| `label` | `string` (optional) | Human-readable label visible in the dashboard |
| `metadata` | `Record<string, unknown>` (optional) | Extra context attached to the checkpoint |
| `sessionId` | `string` (optional) | Defaults to the SDK's active session |

**Returns:** `Promise<Checkpoint>` — a checkpoint object with `checkpointId`, `sessionId`, `createdAt`, and `label`.

---

#### `sdk.restoreCheckpoint()`

```ts
const messages = await sdk.restoreCheckpoint(cp.checkpointId);
if (messages !== undefined) {
  conversationHistory = messages;
  console.log(`Restored ${messages.length} messages`);
}
```

Returns the saved message list as `Array<Record<string, unknown>>`, or `undefined` if the checkpoint ID was not found.

---

#### `sdk.listCheckpoints()`

```ts
const checkpoints = sdk.listCheckpoints();
// or filter by session:
const sessionCheckpoints = sdk.listCheckpoints("sess_abc123");
```

Returns a `Checkpoint[]` from the local in-memory cache. This is synchronous and reflects only checkpoints created in the current process — no network call. The list is lost on restart.

---

### Pattern: Pre-Tool-Call Safety Net

```ts
import { getSdk } from "@syrin/sdk";
import OpenAI from "openai";

const client = new OpenAI();
const sdk = getSdk();

async function runWithRecovery(messages: Record<string, unknown>[]): Promise<string> {
  // Checkpoint before the risky tool call
  const cp = await sdk.createCheckpoint(messages, { label: "pre-tool-call" });

  try {
    const response = await client.chat.completions.create({
      model: sdk.cfg("llm.model", "gpt-4o"),
      messages: messages as any,
      tools: myTools,
    });

    const choice = response.choices[0];

    if (choice.message.tool_calls?.length) {
      const result = await executeTool(choice.message.tool_calls[0]);

      if (isSuspicious(result)) {
        // Restore to before the tool call
        const restored = await sdk.restoreCheckpoint(cp.checkpointId);
        if (restored) {
          messages.length = 0;
          messages.push(...restored);
          return "Tool result was suspicious — restored to safe state";
        }
      }

      messages.push(choice.message as any);
      messages.push({ role: "tool", content: String(result) });
    }

    return choice.message.content ?? "";
  } catch (err) {
    // On any failure, restore to checkpoint
    const restored = await sdk.restoreCheckpoint(cp.checkpointId);
    if (restored) {
      messages.length = 0;
      messages.push(...restored);
    }
    throw err;
  }
}
```

---

### Backend-Triggered Checkpoints

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

The SDK creates the checkpoint automatically before the next LLM call. Similarly, `allowRestore: true` lets the backend trigger a restore:

```json
{
  "governance": {
    "actions": [
      { "type": "restore", "checkpoint_id": "ckpt_abc123" }
    ]
  }
}
```

---

### Emitting CHECKPOINT Events

For visible milestones (not state snapshots), use `sdk.checkpoint()` or `sdk.emit("CHECKPOINT", ...)`:

```ts
// Convenience method — emits a CHECKPOINT event on the timeline
sdk.checkpoint("research-complete", { destination: "Tokyo", phase: "1" });

// Or with an explicit session ID
sdk.checkpoint("research-complete", { destination: "Tokyo" }, "sess_abc123");

// Equivalent direct emit
sdk.emit("CHECKPOINT", {
  name: "research-complete",
  label: "Research Phase Done",
  metadata: { destination: "Tokyo", phase: "1" },
});
```

These are timeline annotations, not state snapshots. They don't store messages.

---

### `Checkpoint` Interface

```ts
interface Checkpoint {
  checkpointId: string;
  sessionId: string;
  messages: Array<Record<string, unknown>>;
  activeConfig: Record<string, unknown>;
  callCount: number;
  cumulativeCostUsd: number;
  createdAt: string;
  label?: string;
  metadata: Record<string, unknown>;
}
```

Checkpoints are stored in memory only — they are lost when the process restarts. For persistence across restarts, serialize checkpoints to your own store and use `sessionId` as the key.

---

### Governance Configuration for Checkpoints

```ts
import { init } from "@syrin/sdk";

const sdk = init({
  apiKey: "...",
  governance: {
    allowCheckpoint: true,  // backend can create checkpoints (default: true)
    allowRestore: true,     // backend can restore from checkpoints (default: false)
  },
});
```

Both default to `true` for checkpoint creation and `false` for restore, since restore is the more disruptive action.
