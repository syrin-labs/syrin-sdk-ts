---
title: "Error Reference"
description: "All exception classes in the Syrin TypeScript SDK — SyrinError, SetupError, AlreadyRatedError, SessionNotFoundError, ValidationError, GovernanceStopError, GovernanceApprovalRequiredError, GovernanceCheckpointRestoredError."
weight: 70
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
- GovernanceStopError does NOT extend SyrinError — it extends Error directly
- GovernanceStopError requires allowStop: true — it is NOT thrown by default
- GovernanceApprovalRequiredError and GovernanceCheckpointRestoredError exist in TypeScript — not in Python SDK
- SetupError extends SyrinError — it is thrown for init/config failures
- init() throws TypeError (not SetupError) for missing apiKey
- getInstance() returns null (not undefined, not throws) for unknown instance names
-->

> **AI Agent Quick Reference** — Catch SDK errors correctly:
> ```typescript
> import { SyrinError, GovernanceStopError } from "@syrin/sdk";
> try {
>   await client.chat.completions.create({ ... });
>   await sdk.sessions.rate(sessionId, "positive");
> } catch (err) {
>   if (err instanceof GovernanceStopError) { /* NOT a SyrinError */ }
>   else if (err instanceof SyrinError) { /* all other SDK errors */ }
>   else throw err;
> }
> ```
> Common mistakes: (1) catching `GovernanceStopError` as a `SyrinError` — it doesn't extend `SyrinError`, it extends `Error` directly; (2) expecting `GovernanceStopError` without `allowStop: true` — it's never thrown without explicit opt-in; (3) `getInstance()` returning `undefined` — it returns `null`.

## When Things Go Wrong, Know Why

The Syrin SDK defines a focused set of exception classes. Most extend `SyrinError` — but `GovernanceStopError` and its siblings extend `Error` directly.

---

## Exception Hierarchy

```
Error
└── SyrinError
    ├── SetupError              — init/config failures
    ├── AlreadyRatedError       — session already rated (HTTP 409)
    ├── SessionNotFoundError    — session not found (HTTP 404)
    └── ValidationError         — invalid input (HTTP 422)

Error
├── GovernanceStopError                   — backend stop action (NOT a SyrinError)
├── GovernanceApprovalRequiredError       — backend approval required (NOT a SyrinError)
└── GovernanceCheckpointRestoredError     — backend checkpoint restore (NOT a SyrinError)
```

---

## `SyrinError`

Base class for all Syrin SDK exceptions except governance errors.

```typescript
class SyrinError extends Error {
  sessionId:  string | null;  // related session, if applicable
  httpStatus: number | null;  // HTTP status code, if from a backend call
}
```

```typescript
import { SyrinError } from "@syrin/sdk";

try {
  await sdk.sessions.rate("ses_123", "positive");
} catch (err) {
  if (err instanceof SyrinError) {
    console.error(`Syrin error: ${err.message}`);
    console.error(`Session: ${err.sessionId}`);
    console.error(`HTTP status: ${err.httpStatus}`);
  }
}
```

---

## `SetupError`

Thrown for initialization or configuration failures — e.g., invalid config options passed to the SDK after `init()`.

```typescript
class SetupError extends SyrinError {}
```

Note: missing `apiKey` throws `TypeError` (not `SetupError`) before any SDK setup runs.

---

## `AlreadyRatedError`

Thrown when a session has already been rated and you attempt to rate it again (HTTP 409 from the backend).

```typescript
import { AlreadyRatedError } from "@syrin/sdk";

try {
  await sdk.sessions.rate("ses_123", "positive");
} catch (err) {
  if (err instanceof AlreadyRatedError) {
    // idempotent — already rated, nothing to do
    return;
  }
}
```

**When thrown:** `sdk.sessions.rate()`, `sdk.sessions.rateBatch()`

---

## `SessionNotFoundError`

Thrown when the provided `sessionId` does not exist on the backend (HTTP 404).

```typescript
import { SessionNotFoundError } from "@syrin/sdk";

try {
  await sdk.sessions.rate("ses_nonexistent", "positive");
} catch (err) {
  if (err instanceof SessionNotFoundError) {
    console.error(`Session ${err.sessionId} was not found`);
    // Likely the session was evicted from backend storage
  }
}
```

**When thrown:** `sdk.sessions.rate()`, `sdk.sessions.rateBatch()`

---

## `ValidationError`

Thrown when client-side input validation fails before making an HTTP call.

```typescript
import { ValidationError } from "@syrin/sdk";

try {
  await sdk.sessions.rate("ses_123", "excellent" as never);  // invalid
} catch (err) {
  if (err instanceof ValidationError) {
    console.error(`Invalid input: ${err.message}`);
    // "Invalid rating 'excellent'. Must be 'positive' or 'negative'."
  }
}
```

**When thrown:** When `rating` is not `"positive"` or `"negative"`.

---

## `GovernanceStopError`

Thrown when the Syrin backend sends a `stop` governance action **and** `allowStop: true` is set in `init()`. **Never thrown by default.**

```typescript
// GovernanceStopError extends Error directly (NOT SyrinError)
class GovernanceStopError extends Error {
  readonly reason:     string;                // human-readable explanation from the backend
  readonly incidentId: string | undefined;    // optional correlation ID
  readonly driftScore: number | null;         // drift score at time of stop action
}
```

Import and handle:

```typescript
import { GovernanceStopError } from "@syrin/sdk";

try {
  await withSession(sessionId, async () => {
    while (true) {
      const response = await client.chat.completions.create({ model: "gpt-4o", messages: history });
      // process...
    }
  });
} catch (err) {
  if (err instanceof GovernanceStopError) {
    console.error(`Agent stopped: ${err.reason}`);
    console.error(`Incident: ${err.incidentId}`);
    saveState(history);
  }
}
```

**When thrown:** On the next LLM call after the backend sends a `stop` governance action, when `allowStop: true`.

---

## `GovernanceApprovalRequiredError`

TypeScript-only. Thrown when the backend requires human approval before the agent can continue. Requires `governance.allowApproval: true`.

```typescript
class GovernanceApprovalRequiredError extends Error {
  readonly reason:      string;
  readonly incidentId:  string | undefined;
  readonly approvalId:  string;               // use to poll for approval status
}
```

---

## `GovernanceCheckpointRestoredError`

TypeScript-only. Thrown when the backend triggers a checkpoint restore and the conversation state has been reset. Requires `governance.allowRestore: true`.

```typescript
class GovernanceCheckpointRestoredError extends Error {
  readonly checkpointId: string;   // the checkpoint that was restored
  readonly reason:       string;
}
```

---

## Catching All SDK Errors

```typescript
import { SyrinError, GovernanceStopError } from "@syrin/sdk";

try {
  await withSession(sessionId, async () => {
    const response = await client.chat.completions.create({ ... });
    await sdk.sessions.rate(sessionId, "positive");
  });
} catch (err) {
  if (err instanceof GovernanceStopError) {
    // Control flow event — handle separately (NOT a SyrinError)
    handleStop(err);
  } else if (err instanceof SyrinError) {
    // Other SDK errors (feedback, session not found, validation, etc.)
    console.error(`Syrin SDK error: ${err.message} (http=${err.httpStatus})`);
  } else {
    throw err;
  }
}
```

---

## `TypeError` from `init()`

`init()` throws `TypeError` for missing required config:

```typescript
try {
  const sdk = await init({} as any);  // no apiKey
} catch (err) {
  console.error(err.message);  // "SYRIN_API_KEY is required..."
}
```

Network errors during registration are non-fatal — `init()` succeeds and the SDK operates in a degraded state until the backend becomes reachable.

---

## `getInstance()` Returns `null`

`getInstance()` returns `null` (not `undefined`, not throws) if the named instance hasn't been initialized:

```typescript
import { getInstance } from "@syrin/sdk";

const sdk = getInstance("my-instance");
if (!sdk) {
  throw new Error("Call init() first");
}
```

---

## Full Error Reference Table

| Error Class | Extends | When thrown | Requires opt-in |
|-------------|---------|-------------|-----------------|
| `SyrinError` | `Error` | Base class — not thrown directly | No |
| `SetupError` | `SyrinError` | Invalid SDK config after init | No |
| `AlreadyRatedError` | `SyrinError` | Session already rated (HTTP 409) | No |
| `SessionNotFoundError` | `SyrinError` | Session not found (HTTP 404) | No |
| `ValidationError` | `SyrinError` | Invalid feedback rating | No |
| `GovernanceStopError` | `Error` | Backend stop action | `allowStop: true` |
| `GovernanceApprovalRequiredError` | `Error` | Backend approval required | `allowApproval: true` |
| `GovernanceCheckpointRestoredError` | `Error` | Backend checkpoint restore | `allowRestore: true` |
