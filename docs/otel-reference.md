# Syrin SDK — OpenTelemetry Schema Reference

## Overview

The Syrin SDK emits OpenTelemetry spans for every LLM call. The schema follows the [OpenTelemetry Semantic Conventions for Generative AI Systems](https://opentelemetry.io/docs/specs/semconv/gen-ai/) with Syrin-specific extensions.

## Span Name

Format: `chat {model}`

Examples:
- `chat gpt-4o`
- `chat gpt-4o-mini`
- `chat claude-3-5-sonnet-20241022`

## Span Kind

`SpanKind.CLIENT`

## Standard `gen_ai.*` Attributes

| Attribute | Type | Description | Example |
|-----------|------|-------------|---------|
| `gen_ai.system` | string | AI provider identifier | `"openai"`, `"anthropic"`, `"google"` |
| `gen_ai.operation.name` | string | Operation type | `"chat"` |
| `gen_ai.request.model` | string | Model requested | `"gpt-4o"` |
| `gen_ai.response.model` | string | Model used (may differ from request) | `"gpt-4o-2024-11-20"` |
| `gen_ai.request.temperature` | float | Temperature parameter (omitted for o1/o3) | `0.7` |
| `gen_ai.request.max_tokens` | int | Max tokens requested | `1000` |
| `gen_ai.response.finish_reasons` | string | Stop reason | `"stop"`, `"length"`, `"content_filter"` |
| `gen_ai.usage.input_tokens` | int | Prompt tokens used | `500` |
| `gen_ai.usage.output_tokens` | int | Completion tokens generated | `200` |
| `gen_ai.usage.total_tokens` | int | Total tokens | `700` |

## Syrin Extension `syrin.*` Attributes

| Attribute | Type | Description | Example |
|-----------|------|-------------|---------|
| `syrin.agent_id` | string | Your agent identifier | `"my-agent"` |
| `syrin.session_id` | string | Current session ID | `"ses_abc123"` |
| `syrin.cost_usd` | float | Estimated cost for this call | `0.0125` |
| `syrin.cumulative_cost_usd` | float | Total session cost so far | `0.0378` |
| `syrin.config_applied` | bool | Whether remote config was applied | `true` |

## Span Events

When `captureContent: true` is set in SDK config:

### `gen_ai.{role}.message`

One event per input message (role = `system`, `user`, `assistant`, or `tool`).

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.{role}.message` | string | Message content |

### `gen_ai.choice`

One event per output choice.

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.choice.index` | int | Choice index (0-based) |
| `gen_ai.choice.finish_reason` | string | Stop reason (e.g. `"stop"`, `"length"`) |
| `gen_ai.choice.message.role` | string | Response message role (typically `"assistant"`) |
| `gen_ai.choice.message.content` | string | Response text content |

## Error Spans

On API errors, the span is marked with:
- `SpanStatusCode.ERROR`
- `status.message`: Error message
- `exception.type`: Error class name
- `exception.message`: Error message
- `exception.stacktrace`: Stack trace

## Provider Mapping

The `gen_ai.system` attribute is derived from the model name:

| Model prefix | `gen_ai.system` value |
|--------------|----------------------|
| `gpt-*`, `o1*`, `o3*` | `openai` |
| `claude-*` | `anthropic` |
| `gemini-*` | `google` |
| `mistral-*`, `open-mixtral-*` | `mistral` |
| `llama*` | `meta` |
| `command-*` | `cohere` |
| (other) | `unknown` |

## OTel Exporter Configuration

### None (default)

```typescript
init({ otelExporter: "none" }); // No spans emitted
```

### Console (development)

```typescript
init({ otelExporter: "console" });
// Spans printed to stdout
```

### OTLP (production)

```typescript
init({
  otelExporter: "otlp",
  otelEndpoint: "http://your-collector:4318",
  // Traces sent to: http://your-collector:4318/v1/traces
});
```

Compatible with any OTLP-compatible backend:
- Jaeger (>= 1.35)
- Tempo
- Honeycomb
- Datadog
- New Relic
- Grafana Cloud

## Example Span (JSON)

```json
{
  "name": "chat gpt-4o",
  "kind": "CLIENT",
  "startTime": "2024-01-15T10:30:00.000Z",
  "endTime": "2024-01-15T10:30:01.234Z",
  "status": { "code": "OK" },
  "attributes": {
    "gen_ai.system": "openai",
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "gpt-4o",
    "gen_ai.response.model": "gpt-4o-2024-11-20",
    "gen_ai.request.temperature": 0.7,
    "gen_ai.request.max_tokens": 1000,
    "gen_ai.response.finish_reasons": "stop",
    "gen_ai.usage.input_tokens": 500,
    "gen_ai.usage.output_tokens": 200,
    "gen_ai.usage.total_tokens": 700,
    "syrin.agent_id": "my-agent",
    "syrin.session_id": "ses_550e8400-e29b-41d4-a716-446655440000",
    "syrin.cost_usd": 0.003250,
    "syrin.cumulative_cost_usd": 0.012750,
    "syrin.config_applied": false
  }
}
```

## Model-Specific Behavior

### o1 / o3 Models

These models do not support the `temperature` parameter:
- `gen_ai.request.temperature` is **omitted** from spans
- Remote config `temperature` updates are **not injected** for these models
- Affected models: `o1`, `o1-preview`, `o1-mini`, `o3`, `o3-mini`

### Anthropic Models (via OpenAI-compatible endpoint)

- Temperature is clamped to the range `[0, 1.0]` (Anthropic's limit)
- The `gen_ai.system` value is `"anthropic"`
