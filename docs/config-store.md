# Syrin SDK — ConfigStore, Tunable Fields, and ConfigGuard (TypeScript)

This document covers the runtime configuration system: how to declare tunable fields,
read current values, apply remote updates safely, and protect your system with circuit
breakers and snapshot anchors.

---

## Overview

The Syrin config system has three layers:

| Layer | What it does |
|---|---|
| `ConfigStore` | Stores current values per namespace with schema validation |
| `TunableRegistry` | Links `ConfigStore` values to live object properties |
| `ConfigGuard` | Validates + applies updates safely; manages anchors and circuit breaker |

These layers work together: the backend sends `config_updates` → ConfigStore stores
them → TunableRegistry propagates to live objects → ConfigGuard protects against bad values.

---

## ConfigStore

`ConfigStore` is a namespace-keyed store with schema validation.
It ships with built-in sections (`llm`, `langgraph`, `mastra`, `vercel_ai`).

```typescript
import { ConfigStore } from "@syrin/sdk";

const store = new ConfigStore();

// Read a value
const temperature = store.get("llm", "temperature"); // null (default)

// Set a value directly (no validation)
store.set("llm", "temperature", 0.3);

// Read an entire section
const llmSection = store.getSection("llm");
// { temperature: 0.3, max_tokens: null, model: null, ... }

// Validate a value without setting it
const err = store.validateValue("llm", "temperature", 9.9);
// "temperature must be <= 2.0, got 9.9"
```

### registerSection()

Add custom sections beyond the built-in ones:

```typescript
import { ConfigStore } from "@syrin/sdk";
import type { FieldSchema } from "@syrin/sdk";

const store = new ConfigStore();

store.registerSection("vector_search", {
  topK: { name: "topK", type: "number", default: 5, ge: 1, le: 100 },
  indexName: { name: "indexName", type: "string", default: "default" },
  reranker: { name: "reranker", type: "boolean", default: false },
} satisfies Record<string, FieldSchema>);

store.set("vector_search", "topK", 20);
```

### applyUpdates()

Apply a flat map of `"namespace.field"` → value updates with validation.
Returns rejected fields with error reasons.

```typescript
const rejected = store.applyUpdates({
  "llm.temperature": 0.3,
  "llm.max_tokens": 2048,
  "llm.temperature": 9.9,  // invalid — will be rejected
});
// rejected: { "llm.temperature": "temperature must be <= 2.0, got 9.9" }
```

A `null` value resets the field to its declared default.

### snapshot() / restoreSnapshot()

```typescript
const snap = store.snapshot();
// { "llm.temperature": 0.3, "llm.max_tokens": 2048, ... }

// Restore a previous snapshot (e.g. after a rollback)
store.restoreSnapshot(snap);
```

### FieldSchema

| Property | Type | Description |
|---|---|---|
| `name` | `string` | Field identifier |
| `type` | `"number" \| "string" \| "boolean" \| "array" \| "object"` | Expected type |
| `default` | `unknown` | Value used when field is null or unset |
| `description` | `string?` | Human-readable label |
| `ge` | `number?` | Minimum value (>=) for number fields |
| `le` | `number?` | Maximum value (<=) for number fields |
| `enum` | `unknown[]?` | Allowed values |
| `required` | `boolean?` | Whether the field is required |

---

## @tunable Decorator

> **TypeScript note:** `@tunable` uses the class decorator pattern.
> For TypeScript < 5, set `"experimentalDecorators": true` in your `tsconfig.json`.
> For TypeScript 5+, native decorators are supported with `"target": "ES2022"`.
> The Syrin vitest config already sets `esbuild.target: "es2022"`.

`@tunable` is a class decorator that:
1. Scans all own instance properties for `TunableField` markers.
2. Replaces each marker with its default value.
3. Registers the instance with the `TunableRegistry`.

```typescript
import { tunable, TunableField } from "@syrin/sdk";

@tunable({ namespace: "processor" })
class DocumentProcessor {
  batchSize = TunableField({ default: 10, ge: 1, le: 100 });
  temperature = TunableField({ default: 0.7, ge: 0.0, le: 2.0 });
  provider = TunableField({
    default: "openai",
    enum: ["openai", "anthropic", "google"],
  });
}

const processor = new DocumentProcessor();

// Markers are replaced with defaults at construction time
console.log(processor.batchSize);   // 10  (not a TunableField marker)
console.log(processor.temperature); // 0.7
console.log(processor.provider);    // "openai"
```

### @tunable options

| Option | Type | Description |
|---|---|---|
| `namespace` | `string` | Registry key for this class |
| `applyTiming` | `"immediate" \| "beforeNextCall" \| "manual"` | When updates are written to the instance (default: `"immediate"`) |
| `apply` | `(target, key, value) => void` | Custom property setter (optional) |
| `registry` | `TunableRegistry` | Use a custom registry instead of `globalRegistry` |

### TunableField options

| Option | Type | Description |
|---|---|---|
| `default` | `unknown` | Initial value |
| `description` | `string?` | Human-readable label |
| `ge` | `number?` | Minimum value for number fields |
| `le` | `number?` | Maximum value for number fields |
| `enum` | `unknown[]?` | Allowed values |
| `applyTiming` | `"immediate" \| "beforeNextCall" \| "manual"` | Per-field timing override |

---

## tune()

Register an existing object instance without class decorators.
Useful for plain objects, third-party instances, or programmatic registration.

```typescript
import { tune, getTune } from "@syrin/sdk";

const vectorSearch = {
  topK: 5,
  similarityThreshold: 0.8,
  indexName: "default",
};

tune({
  target: vectorSearch,
  namespace: "vector_search",
  fields: {
    topK: "number",
    similarityThreshold: "number",
    indexName: "string",
  },
});
```

### tune() with Zod schema

If `zod` is installed, pass a Zod schema instead of a fields map:

```typescript
import { tune } from "@syrin/sdk";
import { z } from "zod";

const SearchSchema = z.object({
  topK: z.number().min(1).max(100).default(5),
  threshold: z.number().min(0).max(1).default(0.8),
});

tune({
  target: vectorSearch,
  namespace: "vector_search",
  schema: SearchSchema,
});
```

Syrin performs basic shape introspection on the Zod schema — it reads `schema.shape`
to discover field names. Full Zod type constraints are not enforced at the Syrin level;
use `ConfigGuard` or your own validation for that.

### tune() options

| Option | Type | Description |
|---|---|---|
| `target` | `object` | The instance to register |
| `namespace` | `string` | Registry key |
| `fields` | `Record<string, "number" \| "string" \| "boolean" \| "array">` | Field name → type map |
| `schema` | `object` | Zod schema (alternative to `fields`) |
| `apply` | `(target, key, value) => void` | Custom setter for dotted-path or computed fields |
| `applyTiming` | `"immediate" \| "beforeNextCall" \| "manual"` | When updates are written |
| `registry` | `TunableRegistry` | Custom registry (default: `globalRegistry`) |

### Dotted-path fields

Use a custom `apply` function to handle nested properties:

```typescript
const config = { retry: { maxAttempts: 3, delayMs: 500 } };

tune({
  target: config,
  namespace: "retry_policy",
  fields: {
    "retry.maxAttempts": "number",
    "retry.delayMs": "number",
  },
  apply: (target, key, value) => {
    const parts = key.split(".");
    let obj = target as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = value;
  },
});
```

---

## getTune()

Read the current logical values for a namespace (includes buffered pending values).

```typescript
import { getTune } from "@syrin/sdk";

const values = getTune("processor");
// { batchSize: 10, temperature: 0.7, provider: "openai" }
```

Pass a custom registry as the second argument if not using `globalRegistry`.

---

## Apply Timing

| Value | Behaviour |
|---|---|
| `"immediate"` | Value is written to the target object property immediately on `applyUpdate()` |
| `"beforeNextCall"` | Buffered in `pending`; flushed before the next LLM call via `registry.applyPending()` |
| `"manual"` | Buffered in `pending`; only flushed when you call `registry.applyPending(namespace)` |

```typescript
import { globalRegistry } from "@syrin/sdk";

// Flush pending updates for all namespaces
globalRegistry.applyPending();

// Flush only one namespace
globalRegistry.applyPending("processor");
```

---

## TunableRegistry

The global singleton registry is `globalRegistry`. You can also create isolated
registries for testing or multi-tenant scenarios:

```typescript
import { TunableRegistry, globalRegistry, tunable, TunableField } from "@syrin/sdk";

// Use globalRegistry (default)
globalRegistry.applyUpdate("processor", "temperature", 0.3);

// Read a namespace
const values = globalRegistry.get("processor");

// Export all schemas
const schemas = globalRegistry.exportSchemas();

// Clear for tests
globalRegistry.clear();

// Custom isolated registry
const myRegistry = new TunableRegistry();

@tunable({ namespace: "my-ns", registry: myRegistry })
class MyClass {
  value = TunableField({ default: 42 });
}
```

---

## ConfigGuard

`ConfigGuard` is the safe-apply layer that sits in front of `ConfigStore`.
It combines:

- **Schema validation** — each field is validated before apply
- **Snapshot anchors** — automatic snapshots before each apply
- **Circuit breaker** — `ConfigFuse` blocks applies after too many failures
- **Auto-revert** — optional health check callback, rollback on failure

```typescript
import { ConfigStore, globalRegistry } from "@syrin/sdk";
import { ConfigGuard } from "@syrin/sdk/config-guard";

const store = new ConfigStore();
const guard = new ConfigGuard(store, globalRegistry, {
  onValidationFail: "rejectField",  // or "rejectAll"
  fuseThreshold: 3,
  fuseResetSeconds: 300,
});
```

### safeApply()

```typescript
const result = guard.safeApply("llm", {
  temperature: 0.3,    // valid
  max_tokens: 9999999, // invalid (if schema has an upper bound)
});

console.log(result.success);   // true (partial — some fields applied)
console.log(result.applied);   // { temperature: 0.3 }
console.log(result.rejected);  // { max_tokens: "..." }
console.log(result.anchorId);  // "uuid" — snapshot taken before apply
```

### SafeApplyResult

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | `true` if all updates applied without rejection |
| `namespace` | `string` | Target namespace |
| `applied` | `Record<string, unknown>` | Fields successfully applied |
| `rejected` | `Record<string, string>` | Fields rejected with reason |
| `rolledBack` | `boolean` | `true` if a rollback was triggered |
| `error` | `Error?` | Apply-level error (if any) |
| `anchorId` | `string?` | ID of the pre-apply snapshot |

### safeApplyBatch()

Apply multiple namespaces in one call using dotted-path keys:

```typescript
const results = guard.safeApplyBatch({
  "llm.temperature": 0.3,
  "llm.max_tokens": 2048,
  "langgraph.recursion_limit": 10,
});
// Returns SafeApplyResult[] — one per namespace
```

---

## ConfigAnchor

Anchors are snapshots of the entire ConfigStore state, taken automatically before
each `safeApply()` call (with reason `"preApply"`) or manually.

```typescript
// Take a manual anchor
const anchor = guard.takeAnchor("before risky change");
console.log(anchor.anchorId);   // UUID string
console.log(anchor.reason);     // "before risky change"
console.log(anchor.createdAt);  // Date

// Apply a risky change
guard.safeApply("llm", { temperature: 1.9 });

// Restore the anchor
guard.restoreAnchor(anchor.anchorId);
// ConfigStore is now identical to state when anchor was taken

// List all anchors (newest first)
const anchors = guard.listAnchors();

// Promote an anchor to "last-good" status
guard.anchorStore.promoteToLastGood(anchor.anchorId);

// Restore last-good anchor
guard.restoreLastGood();
```

Up to `maxAnchors` (default: 5) are retained. Oldest are evicted automatically.

---

## ConfigFuse

`ConfigFuse` is a circuit breaker that protects against repeated bad config applies.

```typescript
import { ConfigFuse, DEFAULT_RECOVERY_POLICY } from "@syrin/sdk/config-guard";

const fuse = new ConfigFuse({ ...DEFAULT_RECOVERY_POLICY, fuseThreshold: 3 });

console.log(fuse.state);          // "CLOSED"
console.log(fuse.isAccepting());  // true

fuse.recordFailure(); // 1st failure
fuse.recordFailure(); // 2nd failure
fuse.recordFailure(); // 3rd failure — fuse trips

console.log(fuse.state);          // "OPEN"
console.log(fuse.isAccepting());  // false — applies are blocked

// After fuseResetSeconds, state transitions to HALF_OPEN automatically
// A success in HALF_OPEN closes the fuse; a failure re-opens it

// Manual reset
fuse.manualReset();
console.log(fuse.state);          // "CLOSED"
```

### Fuse states

| State | Description |
|---|---|
| `CLOSED` | Normal operation — applies are accepted |
| `OPEN` | Circuit tripped — all applies are rejected immediately |
| `HALF_OPEN` | Probe state — one apply attempt is allowed |

### ConfigFuse API

| Method | Description |
|---|---|
| `isAccepting()` | `true` when CLOSED or HALF_OPEN |
| `recordFailure()` | Increment failure counter; may trip the fuse |
| `recordSuccess()` | Reset failures; close fuse from HALF_OPEN |
| `manualReset()` | Force fuse to CLOSED |
| `blow(reason)` | Force fuse to OPEN (for testing / external triggers) |
| `state` | Current state (`"CLOSED" \| "OPEN" \| "HALF_OPEN"`) |
| `consecutiveFailures` | Current failure count |

---

## RecoveryPolicy

`ConfigGuard` accepts a partial `RecoveryPolicy` at construction time.

| Field | Type | Default | Description |
|---|---|---|---|
| `onValidationFail` | `"rejectField" \| "rejectAll"` | `"rejectField"` | Whether to reject only bad fields or the whole update |
| `onApplyError` | `"rollback" \| "rollbackAndAlert" \| "freeze"` | `"rollbackAndAlert"` | What to do when apply throws |
| `onRuntimeError` | `"revertAndContinue" \| "revertAndRetry" \| "alertOnly" \| "ignore"` | `"revertAndContinue"` | What to do on downstream runtime error |
| `crashWindowSeconds` | `number` | `30` | Window (s) after apply in which a crash triggers auto-revert |
| `fuseThreshold` | `number` | `3` | Consecutive failures before fuse blows |
| `fuseResetSeconds` | `number` | `300` | Seconds before OPEN → HALF_OPEN |
| `maxAnchors` | `number` | `5` | Maximum anchors to retain |
| `retryAfterRevert` | `boolean` | `true` | Whether to retry the original operation after a revert |

---

## Complete Example

```typescript
import { init, shutdown, tunable, TunableField, getTune, globalRegistry, ConfigStore } from "@syrin/sdk";
import { ConfigGuard } from "@syrin/sdk/config-guard";

await init({ apiKey: "syrin_...", offline: true });

// --- @tunable ---
@tunable({ namespace: "processor" })
class DocumentProcessor {
  batchSize = TunableField({ default: 10, ge: 1, le: 100 });
  temperature = TunableField({ default: 0.7, ge: 0.0, le: 2.0 });
}

const processor = new DocumentProcessor();
console.log(processor.batchSize);   // 10

globalRegistry.applyUpdate("processor", "batchSize", 50);
console.log(processor.batchSize);   // 50

console.log(getTune("processor"));  // { batchSize: 50, temperature: 0.7 }

// --- ConfigGuard ---
const store = new ConfigStore();
const guard = new ConfigGuard(store, globalRegistry);

const anchor = guard.takeAnchor("before risky");
guard.safeApply("llm", { temperature: 1.9 });
guard.restoreAnchor(anchor.anchorId);  // rolled back

// --- ConfigFuse ---
const { fuse } = guard;
console.log(fuse.state);   // "CLOSED"

fuse.recordFailure();
fuse.recordFailure();
fuse.recordFailure();
console.log(fuse.state);   // "OPEN"

fuse.manualReset();
console.log(fuse.state);   // "CLOSED"

await shutdown();
```
