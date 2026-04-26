---
title: "log()"
description: "Emit structured log entries to the Syrin dashboard timeline — with levels, metadata, and session scoping."
weight: 43
---

## Application Logs on the Dashboard Timeline

`log()` emits a custom log entry that appears on the Syrin dashboard session timeline. Use it to surface application-level events alongside LLM calls — retrieval steps, business logic decisions, cost warnings, debug checkpoints — giving you a complete picture of what your agent was doing between LLM calls.

### Function Signature

```typescript
// Instance method
sdk.log(
  message: string,
  level?: 'debug' | 'info' | 'warning' | 'error',
  metadata?: Record<string, unknown>,
  sessionId?: string,
): void

// Module-level (delegates to default instance)
import { log } from '@syrin/sdk';
log(message, level?, metadata?, sessionId?): void
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `message` | `string` | required | The log message to display |
| `level` | `'debug' \| 'info' \| 'warning' \| 'error'` | `'info'` | Severity level |
| `metadata` | `Record<string, unknown> \| undefined` | `undefined` | Key/value pairs shown as a detail panel |
| `sessionId` | `string \| undefined` | `undefined` | Target session; defaults to the active session |

### Basic Usage

```typescript
import { log } from '@syrin/sdk';

// Info log
log('Retrieved 42 documents from vector store');

// Warning with metadata
log('Cost budget at 80%', 'warning', {
  spent_usd: 0.80,
  budget_usd: 1.00,
});

// Error
log('External API call failed', 'error', {
  service: 'weather_api',
  error: 'ConnectionTimeout',
});
```

### Log Levels

| Level | Color in Dashboard | When to use |
|-------|-------------------|-------------|
| `"debug"` | Gray | Detailed trace information for debugging |
| `"info"` | Blue | Normal operation milestones |
| `"warning"` | Orange | Something unexpected but not fatal |
| `"error"` | Red | Failures that affect the agent's output |

### Metadata

The `metadata` object is displayed as a collapsible key-value panel in the dashboard.

```typescript
log('Vector search complete', 'info', {
  collection: 'travel_knowledge_base',
  query: 'Tokyo hotels near Shibuya',
  results_count: 12,
  top_score: 0.94,
  latency_ms: 45,
});
```

### Common Patterns

#### Retrieval Logging

```typescript
async function retrieveDocuments(query: string): Promise<Document[]> {
  const topK = sdk.agent('rag-agent').cfg('retrieval.top_k', 5);
  const results = await vectorDb.query(query, topK);

  sdk.log(`Retrieved ${results.length} documents`, 'info', {
    collection: 'knowledge_base',
    query,
    top_score: results[0]?.score ?? 0,
  });

  return results;
}
```

#### Business Logic Milestones

```typescript
async function runTravelAgent(userRequest: string): Promise<string> {
  sdk.log('Starting travel planning', 'info', { request_length: userRequest.length });

  const destination = await extractDestination(userRequest);
  sdk.log('Destination identified', 'info', { destination });

  const budget = await extractBudget(userRequest);
  sdk.log('Budget parsed', 'info', { budget_usd: budget });

  const hotels = await searchHotels(destination);
  sdk.log(`Found ${hotels.length} hotels`, hotels.length ? 'info' : 'warning');

  return generateItinerary(destination, hotels, budget);
}
```

#### Cost Monitoring

```typescript
let cumulativeCost = 0;

function trackCost(responseCost: number): void {
  cumulativeCost += responseCost;
  const budget = sdk.agent('my-agent').cfg('budget.max_cost_usd', 1.0);

  if (cumulativeCost > budget * 0.8) {
    sdk.log(
      `Cost warning: $${cumulativeCost.toFixed(4)} of $${budget.toFixed(2)} budget used`,
      'warning',
      {
        current_cost: cumulativeCost,
        budget,
        percentage: Math.round(cumulativeCost / budget * 100),
      },
    );
  }
}
```

#### Debug Tracing

```typescript
async function complexRoutingLogic(intent: string): Promise<string> {
  sdk.log(`Starting routing for intent: ${intent}`, 'debug');

  const candidates = await getAgentCandidates(intent);
  sdk.log(`Found ${candidates.length} candidate agents`, 'debug', { candidates });

  const selected = await scoreAndSelect(candidates, intent);
  sdk.log(`Selected agent: ${selected}`, 'debug');

  return selected;
}
```

### Module vs. Instance

`log()` is available both as a module-level function and as a method on `SyrinSDKInstance`:

```typescript
import { log } from '@syrin/sdk';

// Module-level (delegates to default instance)
log('Process started', 'info', { pid: process.pid });

// Instance method (same behavior)
sdk.log('Process started', 'info', { pid: process.pid });
```

### Relationship to `emit()`

| Feature | `log()` | `emit()` |
|---------|---------|----------|
| Message text | Yes | Optional (in payload) |
| Log levels | Yes | No |
| Metadata | Yes | Yes (as payload fields) |
| Built-in event rendering | No | Yes (HANDOFF, GUARDRAIL, etc.) |
| Use case | Application logs | Lifecycle events |

Use `log()` for free-form operational text. Use `emit()` for structured lifecycle events that the dashboard renders with specialized UI (guardrails, handoffs, budget warnings).
