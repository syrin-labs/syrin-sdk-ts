---
title: "Tool & Memory Tracking"
description: "tool(), memory(), toolSpan(), instrumentTool() — track function calls and memory retrievals as named spans with TOOL_CALL, TOOL_RESULT, and MEMORY_RETRIEVAL events."
weight: 44
---

<!--
SYRIN SDK — CANONICAL REFERENCE (TypeScript/JavaScript)
Package: @syrin/sdk  |  Import: import { tool, memory, toolSpan, instrumentTool } from "@syrin/sdk"
Source of truth: https://github.com/syrin-labs/syrin-sdk-ts

AI AGENTS READING THIS: The statements in this document are the authoritative API contract.
Do not infer undocumented parameters. Do not assume methods exist beyond those listed.
If something is not documented here, it is not part of the public API.

IMPORTANT CORRECTIONS TO COMMON AI MISCONCEPTIONS:
- init() is ASYNC — it returns Promise<SyrinSDK>, you MUST await it
- tool() is ASYNC — it returns Promise<T>, you MUST await it
- memory() is ASYNC — it returns Promise<T>, you MUST await it
- tool() and memory() are module-level functions — import them from "@syrin/sdk"
- span.record() is SYNCHRONOUS — call it inside the callback before returning
- toolSpan() returns { span, done } — you MUST call done() or done(err) manually
- instrumentTool() returns a WRAPPED FUNCTION — call that function, not the original
- tool() emits TWO events: TOOL_CALL on start, TOOL_RESULT on completion
- memory() emits ONE event: MEMORY_RETRIEVAL on completion
-->

> **AI Agent Quick Reference** — Wrap a tool call with telemetry:
> ```typescript
> import { tool, memory } from "@syrin/sdk"; // ← module-level imports
> const sdk = await init({ apiKey: "syrin_pk_..." }); // ← await
>
> const result = await tool("web_search", { query: "Tokyo hotels" }, async (span) => {
>   const data = await searchWeb("Tokyo hotels");
>   span.record(data);    // ← call record() with the result
>   return data;
> });
> ```
> Common mistakes: (1) `await span.record(result)` — `record()` is synchronous; (2) forgetting `span.record(result)` — the TOOL_RESULT event will have an empty result; (3) not calling `done()` in the `toolSpan()` pattern — events are never emitted.

## Track Every Tool Call Without Adding Boilerplate

Your agent calls `searchWeb()`, `checkFlightPrices()`, and `bookHotel()`. Without tool tracking, the dashboard shows only the LLM calls around them. With `tool()`, every function call appears as a named span in the session timeline — with its arguments, return value, latency, and any errors.

---

## What Gets Emitted

### `tool()` emits two events per call:

**`TOOL_CALL`** — emitted when the tool call starts:
```json
{
  "event_type": "TOOL_CALL",
  "tool_name": "web_search",
  "tool_call_id": "tc_abc123",
  "tool_arguments": "{\"query\":\"Tokyo hotels\"}",
  "session_id": "u:alice:2026-04-24",
  "agent_id": "researcher"
}
```

**`TOOL_RESULT`** — emitted when the callback returns or throws:
```json
{
  "event_type": "TOOL_RESULT",
  "tool_name": "web_search",
  "tool_call_id": "tc_abc123",
  "tool_result": "[{\"title\":\"Park Hyatt Tokyo\",...}]",
  "duration_ms": 342,
  "session_id": "u:alice:2026-04-24",
  "agent_id": "researcher"
}
```

### `memory()` emits one event per call:

**`MEMORY_RETRIEVAL`** — emitted on completion:
```json
{
  "event_type": "MEMORY_RETRIEVAL",
  "store_name": "pinecone",
  "query": "recent user preferences",
  "result_count": 5,
  "hit": true,
  "duration_ms": 45,
  "session_id": "u:alice:2026-04-24",
  "agent_id": "researcher"
}
```

---

## `tool()` — Callback-Based API

**Signature (overloads):**
```typescript
// With args:
tool<T>(
  name: string,
  args: Record<string, unknown> | null | undefined,
  fn: (span: ToolSpan) => Promise<T>
): Promise<T>

// Without args:
tool<T>(
  name: string,
  fn: (span: ToolSpan) => Promise<T>
): Promise<T>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Tool name shown in the dashboard |
| `args` | `Record<string, unknown> \| null` | Tool arguments (optional) |
| `fn` | `(span: ToolSpan) => Promise<T>` | Async callback — call `span.record(result)` inside |

```typescript
import { init, tool } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "researcher" });

// With arguments
const results = await tool("web_search", { query: "Tokyo hotels" }, async (span) => {
  const data = await searchWeb("Tokyo hotels");
  span.record(data);   // ← record the result for telemetry
  return data;
});

// Without arguments
const weather = await tool("get_current_weather", async (span) => {
  const data = await fetchWeather("Tokyo");
  span.record(data);
  return data;
});

// Error case — thrown error is captured automatically
try {
  await tool("book_hotel", { hotelId: "ph_tokyo" }, async (span) => {
    const result = await bookingApi.book("ph_tokyo");
    span.record(result);
    return result;
  });
} catch (err) {
  // TOOL_RESULT will contain "[ERROR] BookingError: Room not available"
}
```

---

## `ToolSpan` — The Span Object

The `span` parameter passed to the `tool()` callback:

```typescript
class ToolSpan {
  readonly name:       string;   // tool name
  readonly toolCallId: string;   // auto-generated "tc_..." ID
  readonly startTime:  number;   // Date.now() at creation
  get durationMs(): number       // elapsed milliseconds

  record(result: unknown): void       // record the return value
  setError(error: string): void       // record an error string (when not throwing)
}
```

**`span.record(result)`** — call this before returning from the callback. The result is JSON-serialized and included in the `TOOL_RESULT` event. If you don't call `record()`, the result field in the event will be empty.

**`span.setError(error)`** — use when the tool returns an error value rather than throwing. If the callback throws, the error is captured automatically.

```typescript
await tool("check_availability", { hotelId: "abc" }, async (span) => {
  const resp = await api.check("abc");
  if (resp.error) {
    span.setError(resp.error);  // error captured without throwing
    return null;
  }
  span.record(resp.data);
  return resp.data;
});
```

---

## `memory()` — Memory Retrieval Tracking

**Signature (overloads):**
```typescript
// With query:
memory<T>(
  storeName: string,
  query: string,
  fn: (span: MemorySpan) => Promise<T>
): Promise<T>

// Without query:
memory<T>(
  storeName: string,
  fn: (span: MemorySpan) => Promise<T>
): Promise<T>
```

```typescript
import { init, memory } from "@syrin/sdk";

const sdk = await init({ apiKey: "syrin_pk_...", agentId: "researcher" });

const docs = await memory("pinecone", "recent user preferences", async (span) => {
  const results = await vectorDb.query("recent user preferences", { topK: 5 });
  span.record(results.length, true);  // (count, hit)
  return results;
});
```

---

## `MemorySpan` — The Span Object

```typescript
class MemorySpan {
  readonly storeName: string;   // memory store name
  readonly query:     string;   // the query or key
  readonly startTime: number;   // Date.now() at creation
  get durationMs(): number      // elapsed milliseconds

  record(resultCount?: number, hit?: boolean | null): void
  // resultCount: number of results returned (default 0)
  // hit: true = cache/exact hit, false = miss, null = not applicable
}
```

```typescript
// Cache hit — exact match
await memory("redis", "user:alice:preferences", async (span) => {
  const cached = await redis.get("user:alice:preferences");
  span.record(cached ? 1 : 0, cached != null);  // hit = true/false
  return cached;
});

// Vector search — multiple results, hit not applicable
await memory("chroma", "Tokyo travel tips", async (span) => {
  const docs = await chroma.query("Tokyo travel tips", { topK: 10 });
  span.record(docs.length, null);  // hit = null
  return docs;
});
```

---

## `toolSpan()` — Lower-Level Manual API

For cases where the callback pattern doesn't fit — e.g., wrapping a streaming response or a generator:

**Signature:**
```typescript
function toolSpan(
  name: string,
  args?: Record<string, unknown> | null
): { span: ToolSpan; done: (err?: unknown) => void }
```

```typescript
import { toolSpan } from "@syrin/sdk";

const { span, done } = toolSpan("stream_response", { prompt: "Tell me about Tokyo" });
try {
  const result = await streamResult();
  span.record(result);
  done();           // ← MUST call done() to emit TOOL_RESULT
} catch (err) {
  done(err);        // ← pass the error to done()
  throw err;
}
```

> ⚠️ **Forget to call `done()` and:** the `TOOL_RESULT` event is never emitted. The `TOOL_CALL` event fires at `toolSpan()` creation, but the result event requires an explicit `done()` call.

---

## `instrumentTool()` — Function Wrapper Decorator

Wrap an existing function to automatically emit `TOOL_CALL` + `TOOL_RESULT` on every call. No callback or `span.record()` needed — the return value is captured automatically.

**Signature:**
```typescript
function instrumentTool<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options?: { name?: string }
): (...args: TArgs) => Promise<TReturn>
```

```typescript
import { instrumentTool } from "@syrin/sdk";

// Wrap at module load time
const searchWeb = instrumentTool(
  async (query: string) => {
    return await fetch(`/search?q=${query}`).then(r => r.json());
  },
  { name: "web_search" }  // optional: override the function name
);

// Use exactly like the original
const results = await searchWeb("Tokyo hotels");
// → TOOL_CALL emitted
// → TOOL_RESULT emitted with the return value
```

Wrap existing named functions:

```typescript
async function rawCheckFlights(origin: string, destination: string) {
  return await flightApi.search(origin, destination);
}

// Instrument and replace
const checkFlights = instrumentTool(rawCheckFlights);
// Tool name defaults to the function's name: "rawCheckFlights"
```

`instrumentTool()` uses positional argument indices (`"0"`, `"1"`, ...) as argument keys in the telemetry — not parameter names (those aren't available at runtime in TypeScript/JavaScript).

---

## Choosing the Right API

| Scenario | Use |
|----------|-----|
| Simple tool call with a clear callback | `tool()` |
| Memory/vector retrieval with hit tracking | `memory()` |
| Streaming result or generator function | `toolSpan()` |
| Wrapping existing functions at module load | `instrumentTool()` |

---

## Full Example

```typescript
import { init, withSession, withAgent, tool, memory } from "@syrin/sdk";
import OpenAI from "openai";

const sdk = await init({ apiKey: process.env.SYRIN_API_KEY!, agentId: "researcher" });
const client = new OpenAI();
const agent = sdk.agent("researcher");

async function runResearcher(topic: string): Promise<string> {
  const sessionId = `u:researcher:${new Date().toISOString().slice(0, 10)}`;

  return withSession(sessionId, () =>
    withAgent("researcher", async () => {
      // Track memory retrieval
      const existingDocs = await memory("knowledge_base", topic, async (span) => {
        const results = await vectorDb.query(topic, { topK: 5 });
        span.record(results.length, results.length > 0);
        return results;
      });

      sdk.log(`Found ${existingDocs.length} existing docs`, "info");

      // Track tool call
      const searchResults = await tool("web_search", { query: topic }, async (span) => {
        const data = await webSearch(topic);
        span.record(data);
        return data;
      });

      // LLM call — automatically captured, no changes needed
      const response = await client.chat.completions.create({
        model: agent.cfg("llm.model", "gpt-4o-mini") as string,
        messages: [
          { role: "system", content: "Synthesize research into a summary." },
          { role: "user",   content: `Existing: ${JSON.stringify(existingDocs)}\nNew: ${JSON.stringify(searchResults)}` },
        ],
      });

      return response.choices[0].message.content ?? "";
    })
  );
}
```

The session timeline for this run will show:
```
● MEMORY_RETRIEVAL   knowledge_base   query="Tokyo hotels"   results=5   hit=true   45ms
● CUSTOM_LOG [info]  Found 5 existing docs
● TOOL_CALL          web_search   query="Tokyo hotels"
● TOOL_RESULT        web_search   [{"title":"Park Hyatt",...}]   342ms
● LLM_CALL           gpt-4o-mini  in=420  out=310  $0.001  890ms
```
