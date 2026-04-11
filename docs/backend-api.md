# Syrin Backend API Reference

All requests require authentication via an API key sent in one of three ways:

| Method | Example |
|---|---|
| `Authorization` header | `Authorization: Bearer syrin_abc123` |
| Request body field | `"api_key": "syrin_abc123"` |
| Query parameter (SSE only) | `?api_key=syrin_abc123` |

Base URL: configured as `SYRIN_BACKEND_URL` (default `https://api.syrin.dev`).

---

## Health

### `GET /health`

Returns `200 OK` if the backend is running. No auth required.

```bash
curl http://localhost:4000/health
# → {"ok":true,"uptime":42.3}
```

---

## Ingest

### `POST /ingest`

Submit a batch of telemetry events from an SDK session. The SDK calls this automatically;
you rarely need to call it directly.

**Request body:**

```json
{
  "api_key": "syrin_abc123",
  "session_id": "ses_550e8400",
  "agent_id": "my-agent",
  "sdk": { "language": "typescript", "version": "0.1.0" },
  "events": [
    {
      "event_id": "evt_123",
      "event_type": "LLM_CALL",
      "timestamp": "2026-04-11T12:00:00.000Z",
      "duration_ms": 1240,
      "model": "gpt-4o",
      "provider": "openai",
      "input_tokens": 250,
      "output_tokens": 80,
      "cost_usd": 0.00143,
      "stream": false,
      "error": null,
      "config_applied": false
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `session_id` | Yes | UUID or string identifying the session. Max 128 chars, alphanumeric + `-_.@:` |
| `agent_id` | No | Identifies the agent. Max 128 chars, alphanumeric + `-_.@:` |
| `sdk` | No | SDK language + version metadata |
| `events` | Yes | Array of events (max 500 per request) |

**Supported `event_type` values:**

| Event type | When emitted |
|---|---|
| `LLM_CALL` | Every LLM API call (OpenAI, Anthropic, Mastra, Vercel AI) |
| `LLM_ERROR` | LLM API error |
| `SESSION_STARTED` | First event in a new session |
| `SESSION_ENDED` | On `shutdown()` or `deleteSession()` |
| `AGENT_RUN_STARTED` | On `withAgent()` enter |
| `AGENT_RUN_ENDED` | On `withAgent()` exit |
| `WORKFLOW_STARTED` | On `withWorkflow()` enter |
| `WORKFLOW_ENDED` | On `withWorkflow()` exit |
| `SWARM_STARTED` | On `withSwarm()` enter |
| `SWARM_ENDED` | On `withSwarm()` exit |
| `CHAIN_EXECUTION` | Per LangChain `chain.invoke()` |
| `GRAPH_EXECUTION` | Per LangGraph `graph.invoke()` |
| `NODE_EXECUTION` | Per LangGraph node invocation |
| `HITL_INTERRUPT` | When LangGraph `interrupt()` is called |
| `TOOL_CALL` | When an LLM tool call is made |
| `TOOL_RESULT` | When a tool result is received |
| `CONFIG_APPLIED` | When remote config is applied to a call |
| `GOVERNANCE_TRIGGERED` | When any governance action fires |
| `APPROVAL_REQUESTED` | HITL approval requested |
| `APPROVAL_GRANTED` | HITL approval granted |
| `APPROVAL_REJECTED` | HITL approval rejected |

**Response:**

```json
{
  "ok": true,
  "config_updates": {
    "temperature": 0.3,
    "model": "gpt-4o-mini"
  },
  "governance": {
    "actions": [],
    "loop_detected": false,
    "drift_score": null,
    "incident_id": null
  }
}
```

`config_updates` is sparse — only changed fields are included. The SDK applies these to
the next call automatically. Setting a field to `null` clears any active override.

**Governance actions** the backend can include in the response:

| Action type | Effect |
|---|---|
| `stop` | SDK raises `GovernanceStopError` on next intercepted call |
| `inject_message` | SDK prepends a message to the next call's message list |
| `alert` | SDK fires all registered `onAlert` callbacks |
| `checkpoint` | SDK saves a conversation checkpoint |
| `restore` | SDK restores a previously saved checkpoint |

```bash
curl -X POST http://localhost:4000/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "syrin_abc123",
    "session_id": "ses_test",
    "agent_id": "my-agent",
    "events": [{
      "event_id": "evt_001",
      "event_type": "LLM_CALL",
      "timestamp": "2026-04-11T12:00:00Z",
      "model": "gpt-4o",
      "input_tokens": 100,
      "output_tokens": 50,
      "duration_ms": 800
    }]
  }'
```

---

## Agents

### `POST /agents/:agent_id/register`

Register an agent with the backend. Called automatically by the SDK on `init()`.

```bash
curl -X POST http://localhost:4000/agents/my-agent/register \
  -H "Authorization: Bearer syrin_abc123" \
  -H "Content-Type: application/json" \
  -d '{
    "sdk": { "language": "typescript", "version": "0.1.0" }
  }'
# → {"ok":true,"agentId":"my-agent","registered":true}
```

---

### `GET /agents`

List all registered agents with stats (event count, session count, last seen).

```bash
curl http://localhost:4000/agents \
  -H "Authorization: Bearer syrin_abc123"
# → {"ok":true,"agents":[{"agentId":"my-agent","eventCount":42,...}]}
```

---

### `GET /agents/:agent_id`

Get a single agent with its current pending config overrides.

```bash
curl http://localhost:4000/agents/my-agent \
  -H "Authorization: Bearer syrin_abc123"
# → {"ok":true,"agent":{...},"overrides":{"temperature":0.3}}
```

---

### `GET /agents/:agent_id/overrides`

Get only the pending config overrides for an agent.

```bash
curl http://localhost:4000/agents/my-agent/overrides \
  -H "Authorization: Bearer syrin_abc123"
# → {"ok":true,"overrides":{"temperature":0.3,"max_tokens":500}}
```

---

### `POST /agents/:agent_id/config`

Push config overrides to an agent. The SDK picks these up on the next `/ingest` response
and applies them to the next LLM call.

```json
{
  "overrides": {
    "temperature": 0.1,
    "model": "gpt-4o-mini",
    "maxTokens": 500
  },
  "reason": "Cost reduction during load spike",
  "expires_at": "2026-04-11T13:00:00Z"
}
```

| Field | Description |
|---|---|
| `overrides` | Map of param → value. Use `null` to clear a field back to the model default. |
| `reason` | Optional human-readable reason (stored for audit) |
| `expires_at` | ISO 8601 timestamp when the override expires (optional) |

**Supported override keys:**

| Key | Type | Effect |
|---|---|---|
| `temperature` | number | Clamp temperature on next call |
| `maxTokens` | number | Cap output token limit |
| `model` | string | Swap model transparently |
| `topP` | number | Nucleus sampling parameter |
| `frequencyPenalty` | number | Frequency penalty |
| `presencePenalty` | number | Presence penalty |
| `systemPrompt` | string \| null | Inject or override system prompt |
| `disabledTools` | string[] | Remove listed tools from the call |
| `enabledTools` | string[] | Allowlist — only keep these tools |

```bash
# Tighten temperature + swap to cheaper model
curl -X POST http://localhost:4000/agents/my-agent/config \
  -H "Authorization: Bearer syrin_abc123" \
  -H "Content-Type: application/json" \
  -d '{"overrides":{"temperature":0.1,"model":"gpt-4o-mini"},"reason":"cost spike"}'

# Clear a single override (set to null)
curl -X POST http://localhost:4000/agents/my-agent/config \
  -H "Authorization: Bearer syrin_abc123" \
  -H "Content-Type: application/json" \
  -d '{"overrides":{"temperature":null}}'
```

Response:
```json
{"ok":true,"configId":"cfg_550e8400","agentId":"my-agent"}
```

---

### `DELETE /agents/:agent_id/config/:field_path`

Clear a single config field for an agent.

```bash
curl -X DELETE http://localhost:4000/agents/my-agent/config/temperature \
  -H "Authorization: Bearer syrin_abc123"
# → {"ok":true,"cleared":"temperature"}
```

---

### `GET /agents/:agent_id/events`

Retrieve stored events for an agent, with optional filtering.

**Query parameters:**

| Param | Description | Default |
|---|---|---|
| `session_id` | Filter by session | all |
| `event_type` | Filter by event type (e.g. `LLM_CALL`, `GRAPH_EXECUTION`) | all |
| `limit` | Max events to return | 50 |
| `offset` | Pagination offset | 0 |

```bash
# Last 20 LLM_CALL events for a specific session
curl "http://localhost:4000/agents/my-agent/events?event_type=LLM_CALL&session_id=ses_abc&limit=20" \
  -H "Authorization: Bearer syrin_abc123"
```

Response:
```json
{
  "ok": true,
  "events": [
    {
      "id": 1,
      "eventId": "evt_123",
      "eventType": "LLM_CALL",
      "sessionId": "ses_abc",
      "agentId": "my-agent",
      "timestamp": "2026-04-11T12:00:00.000Z",
      "durationMs": 1240,
      "model": "gpt-4o",
      "inputTokens": 250,
      "outputTokens": 80,
      "costUsd": "0.00143"
    }
  ]
}
```

---

### `GET /agents/:agent_id/sessions`

List sessions for an agent.

**Query parameters:** `limit` (default 20, max 100), `offset` (default 0)

```bash
curl "http://localhost:4000/agents/my-agent/sessions?limit=10" \
  -H "Authorization: Bearer syrin_abc123"
# → {"ok":true,"sessions":[{"sessionId":"ses_abc","eventCount":12,...}]}
```

---

### `GET /agents/:agent_id/stream`

Server-Sent Events (SSE) stream — receives config updates pushed in real-time.
The SDK connects to this when `sse: true` is set in `init()`.

Auth via query param (browsers/EventSource cannot set headers):

```typescript
const es = new EventSource(
  `http://localhost:4000/agents/my-agent/stream?api_key=syrin_abc123`
);
es.addEventListener("config_update", (e) => {
  const updates = JSON.parse(e.data);
  console.log("Config update:", updates);
});
```

```bash
curl -N "http://localhost:4000/agents/my-agent/stream?api_key=syrin_abc123" \
  -H "Accept: text/event-stream"
```

Events emitted:
```
event: config_update
data: {"temperature":0.3,"model":"gpt-4o-mini"}

: heartbeat
```

A `config_update` event is sent immediately on connect with all current pending overrides,
then again whenever `POST /agents/:agent_id/config` is called.

---

## Input Validation

`agent_id` and `session_id` values are validated on all endpoints:

- Maximum 128 characters
- Allowed characters: alphanumeric (`A-Z`, `a-z`, `0-9`) plus `-`, `_`, `.`, `@`, `:`
- Violating values return `400 Bad Request` with a descriptive error

---

## Error Responses

All endpoints return a consistent error shape:

```json
{"ok":false,"error":"Invalid API key"}
```

| Status | Meaning |
|---|---|
| 400 | Validation error (invalid request body or invalid `agent_id` / `session_id`) |
| 401 | Missing or invalid API key |
| 404 | Agent not found |
| 500 | Internal server error |
