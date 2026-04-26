---
title: "emit()"
description: "Emit custom lifecycle events — guardrails, handoffs, budget warnings, agent forks, checkpoints, and anything else you want on the dashboard timeline."
weight: 42
---

## Tell the Dashboard What's Really Happening

`emit()` sends a named lifecycle event to the Syrin dashboard. Use it to surface production-grade signals that aren't LLM calls: guardrail checks, circuit breakers, handoffs between agents, budget estimates, tool selections, and custom milestones.

All active context fields (`agent_id`, `session_id`, `run_id`, `workflow_id`, `swarm_id`, `parent_run_id`) are automatically resolved and merged into the event — you only need to provide the event-specific payload.

### Function Signature

```typescript
// Instance method
sdk.emit(eventType: string, payload?: Record<string, unknown>, sessionId?: string): void

// Module-level (delegates to default instance)
import { emit } from '@syrin/sdk';
emit(eventType: string, payload?: Record<string, unknown>, sessionId?: string): void
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `eventType` | `string` | The event type string (see built-in types below) |
| `payload` | `Record<string, unknown> \| undefined` | Optional fields merged into the event |
| `sessionId` | `string \| undefined` | Target session; defaults to the current active session |

### Built-in Event Types

These event types are rendered with special UI in the dashboard:

#### `GUARDRAIL_INPUT` / `GUARDRAIL_OUTPUT`

Record the result of a guardrail check on the input or output of an LLM call.

```typescript
// Before calling the LLM
sdk.emit('GUARDRAIL_INPUT', {
  name: 'pii_filter',
  passed: true,
  message: null,
});

// After the LLM responds
sdk.emit('GUARDRAIL_OUTPUT', {
  name: 'toxicity_filter',
  passed: false,
  message: 'Response contained potentially harmful content',
});
```

Payload fields:
- `name` (string) — guardrail name
- `passed` (boolean) — whether the guardrail passed
- `message` (string | null) — optional explanation

---

#### `CIRCUIT_BREAKER_OPEN` / `CIRCUIT_BREAKER_CLOSE`

Signal that a circuit breaker tripped or recovered.

```typescript
sdk.emit('CIRCUIT_BREAKER_OPEN', {
  reason: '5 consecutive timeouts',
  failure_count: 5,
  threshold: 5,
});

// Later, when the service recovers
sdk.emit('CIRCUIT_BREAKER_CLOSE', {
  reason: 'Service healthy again',
});
```

---

#### `HANDOFF`

Signal that control is passing from one agent to another.

```typescript
sdk.emit('HANDOFF', {
  from_agent: 'orchestrator',
  to_agent: 'researcher',
  reason: 'Starting research phase',
  context: { topic: 'Tokyo travel', depth: 'standard' },
});
```

---

#### `AGENT_FORK` / `AGENT_JOIN`

Signal the start and end of a parallel agent execution.

```typescript
const agents = ['researcher-1', 'researcher-2', 'researcher-3'];

sdk.emit('AGENT_FORK', {
  agents,
  reason: 'Parallelizing research across three topics',
});

const results = await Promise.all(agents.map(a => runAgent(a)));

sdk.emit('AGENT_JOIN', {
  agents,
  reason: 'All parallel researchers completed',
});
```

---

#### `WORKER_SPAWNED`

Signal that a new worker agent was dynamically created.

```typescript
sdk.emit('WORKER_SPAWNED', {
  worker_agent: 'specialist-tokyo',
  reason: 'User requested Tokyo-specific research',
});
```

---

#### `BUDGET_ESTIMATION`

Signal cost estimation or budget threshold warnings.

```typescript
const sessionCost = calculateSessionCost();
const budget = sdk.agent('my-agent').cfg('budget.max_cost_usd', 1.0);

if (sessionCost > budget * 0.8) {
  sdk.emit('BUDGET_ESTIMATION', {
    estimated_cost_usd: sessionCost,
    budget_usd: budget,
    message: `Session at ${Math.round(sessionCost / budget * 100)}% of budget`,
  });
}
```

---

#### `TOOL_SELECTED`

Signal which tool the agent decided to use (useful before the actual tool call).

```typescript
sdk.emit('TOOL_SELECTED', {
  tool_name: 'web_search',
  reason: 'User asked for current information',
  alternatives: ['database_query', 'cached_data'],
});
```

---

#### `CHECKPOINT`

Mark a milestone in your workflow. Appears as an annotation on the session timeline.

```typescript
sdk.emit('CHECKPOINT', {
  name: 'research-complete',
  label: 'Research Phase Done',
  metadata: { destination: 'Tokyo', documents_found: 42 },
});

// Or via the convenience method
sdk.checkpoint('research-complete', { phase: '1' });
```

### Custom Events

Any string not in the built-in list is accepted and rendered as a generic event in the dashboard:

```typescript
sdk.emit('ITINERARY_GENERATED', {
  destination: 'Tokyo',
  days: 7,
  total_cost_usd: 3200.0,
});

sdk.emit('USER_PREFERENCE_DETECTED', {
  preference: 'budget_travel',
  confidence: 0.87,
});

sdk.emit('EXTERNAL_API_CALLED', {
  service: 'booking.com',
  latency_ms: 340,
  result_count: 15,
});
```

### Context Auto-Resolution

When `emit()` is called inside a `withSession` / `withAgent` / `withWorkflow` block, the event automatically picks up all active context fields:

```typescript
import { withSession, withAgent } from '@syrin/sdk';

await withSession('ses_alice', async () => {
  await withAgent('researcher', async () => {
    sdk.emit('GUARDRAIL_INPUT', { name: 'pii', passed: true });
    // The emitted event contains:
    // session_id = 'ses_alice'
    // agent_id = 'researcher'
  });
});
```

### Full Example: Guardrail Pattern

```typescript
import { withSession, withAgent } from '@syrin/sdk';
import OpenAI from 'openai';

const client = new OpenAI();

async function safeLlmCall(userMessage: string, sessionId: string): Promise<string> {
  return withSession(sessionId, () =>
    withAgent('safe-assistant', async () => {
      // Input guardrail
      const { passed, reason } = await piiFilter.check(userMessage);
      sdk.emit('GUARDRAIL_INPUT', {
        name: 'pii_filter',
        passed,
        message: reason ?? null,
      });
      if (!passed) return "I can't process that request due to privacy constraints.";

      // LLM call
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: userMessage }],
      });
      const output = response.choices[0].message.content ?? '';

      // Output guardrail
      const toxicityScore = await toxicityModel.score(output);
      sdk.emit('GUARDRAIL_OUTPUT', {
        name: 'toxicity_filter',
        passed: toxicityScore < 0.5,
        message: toxicityScore >= 0.5 ? `Score: ${toxicityScore.toFixed(2)}` : null,
      });
      if (toxicityScore >= 0.5) return "I can't provide that response.";

      return output;
    })
  );
}
```

### Module vs. Instance

`emit()` is available both as a module-level function and as a method on `SyrinSDKInstance`:

```typescript
import { emit } from '@syrin/sdk';

// Module-level (delegates to default instance)
emit('HANDOFF', { from_agent: 'orchestrator', to_agent: 'researcher' });

// Instance method (same behavior)
sdk.emit('HANDOFF', { from_agent: 'orchestrator', to_agent: 'researcher' });
```
