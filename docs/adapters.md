# Syrin SDK — Framework Adapters (TypeScript)

This document describes how Syrin's adapter layer works, the two-tier architecture,
supported frameworks, and integration patterns for each adapter.

---

## Two-Tier Architecture

Syrin separates instrumentation into two tiers:

**Tier 1 — Provider Adapters (automatic)**

Intercept raw LLM API calls and emit `LLM_CALL` events with full telemetry.
Installed automatically by `init()`.

| Adapter | Package | Install |
|---|---|---|
| `OpenAIAdapter` | `openai` | Always auto-installed |
| `AnthropicAdapter` | `@anthropic-ai/sdk` | Auto-installed if package is present |

**Tier 2 — Framework Adapters (opt-in)**

Instrument higher-level frameworks (orchestration graphs, chains, agents).
Emit framework-specific event types that complement Tier 1 `LLM_CALL` events.
Must be passed in the `adapters` array when calling `init()`.

| Adapter | Package | Event types |
|---|---|---|
| `LangGraphAdapter` | `@langchain/langgraph` | `GRAPH_EXECUTION`, `NODE_EXECUTION`, `HITL_INTERRUPT` |
| `LangChainAdapter` | `@langchain/core` | `CHAIN_EXECUTION` |

---

## Install

```bash
# Core SDK
npm install @syrin/sdk openai

# Anthropic (auto-detected by init())
npm install @anthropic-ai/sdk

# LangGraph
npm install @langchain/langgraph @langchain/openai @langchain/core

# LangChain
npm install @langchain/core @langchain/openai
```

---

## Tier 1: OpenAI Adapter

Installed automatically. No configuration needed.

```typescript
import { init } from "@syrin/sdk";
import OpenAI from "openai";

await init({ apiKey: "syrin_..." });

const client = new OpenAI();
// Every call is now instrumented
const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});
```

**Emits per call:**

| Field | Description |
|---|---|
| `event_type` | `LLM_CALL` |
| `model` | Requested model |
| `provider` | `openai` |
| `input_tokens` | Prompt token count |
| `output_tokens` | Completion token count |
| `cost_usd` | Estimated cost (built-in pricing table) |
| `duration_ms` | Round-trip latency |
| `finish_reason` | e.g. `stop`, `length`, `tool_calls` |
| `stream` | `true` / `false` |
| `tool_calls` | Tool call details (if present) |
| `config_applied` | Whether remote config was injected |

---

## Tier 1: Anthropic Adapter

Installed automatically by `init()` when `@anthropic-ai/sdk` is available.
No extra configuration required.

```typescript
import { init } from "@syrin/sdk";
import Anthropic from "@anthropic-ai/sdk";

await init({ apiKey: "syrin_..." });

const client = new Anthropic();
// Automatically instrumented
const response = await client.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});
```

**Anthropic-specific differences from OpenAI:**

| Field | OpenAI | Anthropic |
|---|---|---|
| Usage | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` |
| Stop signal | `finish_reason` | `stop_reason` |
| Tool definitions | `tools[i].function.parameters` | `tools[i].input_schema` |
| Tool calls in response | `choices[0].message.tool_calls` | content blocks with `type === "tool_use"` |
| Streaming | `choices[].delta.content` chunks | typed event objects (`message_start`, `content_block_delta`, etc.) |

**Streaming:**

```typescript
const stream = client.messages.stream({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 256,
  messages: [{ role: "user", content: "Count to 5." }],
});

for await (const chunk of stream) {
  // consume chunks as normal
}
// LLM_CALL event with input_tokens + output_tokens emitted on stream end
```

**Provider detection:**

The SDK reads the `baseURL` on the client instance to detect whether calls are going to
Anthropic's API, a local mock, or a compatible proxy. The `provider` field in the emitted
event reflects this.

---

## Tier 2: LangGraph Adapter

Instruments `@langchain/langgraph` graphs. Patches:

- `StateGraph.prototype.addNode` — wraps each node function to emit `NODE_EXECUTION`
- `CompiledGraph.prototype.invoke` / `ainvoke` — wraps graph runs to emit `GRAPH_EXECUTION`
- `interrupt()` — emits `HITL_INTERRUPT` when a graph pauses for human review

```typescript
import { init, LangGraphAdapter } from "@syrin/sdk";
import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

await init({
  apiKey: "syrin_...",
  adapters: [new LangGraphAdapter()],
});

const GraphState = Annotation.Root({
  question: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
  answer: Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
});

const llm = new ChatOpenAI({ model: "gpt-4o-mini" });

const graph = new StateGraph(GraphState)
  .addNode("think", async (state) => {
    const response = await llm.invoke([{ role: "user", content: state.question }]);
    return { answer: String(response.content) };
  })
  .addEdge(START, "think")
  .addEdge("think", END);

const compiled = graph.compile();
const result = await compiled.invoke({ question: "What is 2+2?" });
console.log(result.answer);
```

**Event types:**

`GRAPH_EXECUTION` — emitted once per `invoke()` / `ainvoke()` call:

| Field | Description |
|---|---|
| `event_type` | `GRAPH_EXECUTION` |
| `run_id` | Unique run identifier (`lgrun_...`) |
| `graph_id` | Graph name |
| `session_id` | Syrin session |
| `agent_id` | Agent label |
| `duration_ms` | Total graph execution time |
| `input_hash` | SHA-256 of input state (16 chars) |
| `output_hash` | SHA-256 of output state (16 chars) |
| `error` | Error message if run failed |
| `did_stop_early` | `true` if a `GovernanceStopError` was raised |

`NODE_EXECUTION` — emitted once per node invocation:

| Field | Description |
|---|---|
| `event_type` | `NODE_EXECUTION` |
| `node_name` | The node's label in the graph |
| `graph_run_id` | Parent graph run identifier |
| `duration_ms` | Node execution time |
| `input_hash` | SHA-256 of node input state |
| `output_hash` | SHA-256 of node output (or input hash if error) |
| `error` | Error message if node failed |

`HITL_INTERRUPT` — emitted when `interrupt()` is called inside a node:

| Field | Description |
|---|---|
| `event_type` | `HITL_INTERRUPT` |
| `graph_run_id` | Parent graph run identifier |
| `interrupt_value` | Value passed to `interrupt()` |

**Config injection:**

The LangGraph adapter reads the `langgraph` section from the ConfigStore and injects
values into the `config` argument of each `invoke()` call transparently.

| ConfigStore field | Injected as |
|---|---|
| `langgraph.recursion_limit` | `config.recursionLimit` |
| `langgraph.interrupt_before` | `config.interruptBefore` |
| `langgraph.interrupt_after` | `config.interruptAfter` |
| `langgraph.thread_id` | `config.configurable.thread_id` |
| `langgraph.max_concurrency` | `config.maxConcurrency` |
| `langgraph.stream_mode` | `config.streamMode` |
| `llm.temperature` | `config.configurable.temperature` |
| `llm.max_tokens` | `config.configurable.max_tokens` |
| `llm.model` | `config.configurable.model` |

---

## Tier 2: LangChain Adapter

Instruments LangChain.js LCEL chains without global monkey-patching.
Two integration modes:

### Mode 1: callbackHandler() — manual injection

```typescript
import { init, LangChainAdapter } from "@syrin/sdk";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";

const adapter = new LangChainAdapter();

await init({
  apiKey: "syrin_...",
  adapters: [adapter],
});

const chain = ChatPromptTemplate.fromMessages([
  ["system", "Answer concisely."],
  ["human", "{question}"],
]).pipe(new ChatOpenAI({ model: "gpt-4o-mini" })).pipe(new StringOutputParser());

const handler = adapter.callbackHandler("my-chain");
const result = await chain.invoke(
  { question: "What is TypeScript?" },
  { callbacks: [handler] }
);
```

### Mode 2: wrap() — zero-friction

```typescript
const wrappedChain = adapter.wrap(chain, { chainName: "my-chain" });
// callbacks and FrameworkContext injected automatically
const result = await wrappedChain.invoke({ question: "What is TypeScript?" });
```

`wrap()` returns a `Proxy` object that:
1. Intercepts every `invoke()` and `ainvoke()` call.
2. Automatically injects a `SyrinLangChainCallback` into the `callbacks` array.
3. Runs the invocation inside a `FrameworkContext` (propagated via `AsyncLocalStorage`).
4. Injects pending LLM config updates into `configurable`.

**Event types:**

`CHAIN_EXECUTION` — emitted once per `invoke()` / `ainvoke()` call:

| Field | Description |
|---|---|
| `event_type` | `CHAIN_EXECUTION` |
| `chainRunId` | Unique run identifier |
| `chainName` | Chain label (from `callbackHandler()` or `wrap()`) |
| `durationMs` | Execution time |
| `error` | Error message if chain failed |
| `framework` | `langchain` |

LLM_CALL events are emitted separately by the Tier 1 OpenAI or Anthropic adapter,
enriched with `framework: "langchain"` via `FrameworkContext`.

---

## FrameworkContext and AsyncLocalStorage Propagation

Every Tier 2 adapter wraps its invocations in a `FrameworkContext`:

```typescript
import { withFrameworkContext } from "@syrin/sdk"; // internal

withFrameworkContext({
  framework: "langchain",
  agentId: "my-agent",
  sessionId: "ses_...",
  runId: "lcrun_...",
  extra: {},
}, async () => {
  // LLM calls inside here inherit the framework context
  await chain.invoke(input, config);
});
```

The context is propagated transparently through `AsyncLocalStorage`, so all nested
LLM calls (even across async hops) are tagged with the correct `framework`, `runId`,
and `sessionId` — without any changes to user code.

---

## Writing a Custom Adapter

Extend `BaseFrameworkAdapter` from `"@syrin/sdk"`:

```typescript
import { BaseFrameworkAdapter } from "@syrin/sdk";
import type { ISyrinCore } from "@syrin/sdk";

export class MyFrameworkAdapter extends BaseFrameworkAdapter {
  readonly name = "my-framework";

  protected async _doInstall(core: ISyrinCore): Promise<void> {
    // Patch your framework here
    // Use this.emitEvent({ event_type: "MY_EVENT", ... }) to emit events
    // Use this.getConfig("llm") to read remote config
  }

  protected _doUninstall(): void {
    // Restore any patches
  }
}

// Register at init time
await init({
  apiKey: "syrin_...",
  adapters: [new MyFrameworkAdapter()],
});
```

`BaseFrameworkAdapter` provides:

| Member | Description |
|---|---|
| `this.core` | `ISyrinCore` instance |
| `this.emitEvent(event)` | Queue an event for the next `/ingest` flush |
| `this.getConfig(namespace)` | Read the current ConfigStore section |
| `this.sessionId` | Current session ID |
| `this.agentId` | Agent label from init options |

---

## Provider Detection Pattern

The Anthropic and LangGraph adapters detect the active LLM provider from the client's
`baseURL`. This allows the same adapter to work whether calls go to a real API endpoint
or a local mock:

```typescript
import { detectProvider } from "@syrin/sdk"; // internal helper

const provider = detectProvider(client); // "openai" | "anthropic" | "unknown"
```

Detection logic:
- URL contains `anthropic.com` → `anthropic`
- URL contains `openai.com` → `openai`
- URL contains `localhost` or `127.0.0.1` → inferred from client type
- Fallback → `unknown`
