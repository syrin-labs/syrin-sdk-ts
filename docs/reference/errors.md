---
title: "Error Reference"
description: "All exception classes in the Syrin TypeScript SDK — SyrinError, AlreadyRatedError, SessionNotFoundError, ValidationError, GovernanceStopError."
weight: 70
---

## When Things Go Wrong, Know Why

The Syrin SDK defines a small, focused set of exception classes. All SDK-specific errors extend `SyrinError`, making them easy to catch as a group or individually.

### Exception Hierarchy

```
Error
└── SyrinError
    ├── AlreadyRatedError
    ├── SessionNotFoundError
    └── ValidationError

Error
└── GovernanceStopError   (separate hierarchy — not a SyrinError)
```

### `SyrinError`

Base class for all Syrin SDK exceptions.

```typescript
class SyrinError extends Error {
  sessionId: string | null;  // related session, if applicable
  httpStatus: number | null; // HTTP status code, if from a backend call
}
```

```typescript
import { SyrinError } from '@syrin/sdk';

try {
  await sdk.sessions.rate('ses_123', 'positive');
} catch (err) {
  if (err instanceof SyrinError) {
    console.error(`Syrin error: ${err.message}`);
    console.error(`Session: ${err.sessionId}`);
    console.error(`HTTP status: ${err.httpStatus}`);
  }
}
```

---

### `AlreadyRatedError`

Raised when a session has already been rated and you attempt to rate it again (HTTP 409 from the backend).

```typescript
import { AlreadyRatedError } from '@syrin/sdk';

try {
  await sdk.sessions.rate('ses_123', 'positive');
} catch (err) {
  if (err instanceof AlreadyRatedError) {
    // idempotent — already rated, nothing to do
  }
}
```

**When thrown:** `sdk.sessions.rate()`, `sdk.sessions.rateBatch()`

---

### `SessionNotFoundError`

Raised when the provided `sessionId` does not exist on the backend (HTTP 404).

```typescript
import { SessionNotFoundError } from '@syrin/sdk';

try {
  await sdk.sessions.rate('ses_nonexistent', 'positive');
} catch (err) {
  if (err instanceof SessionNotFoundError) {
    console.error(`Session ${err.sessionId} was not found`);
    // Likely the session was evicted from backend storage
  }
}
```

**When thrown:** `sdk.sessions.rate()`, `sdk.sessions.rateBatch()`

---

### `ValidationError`

Raised when client-side input validation fails before making an HTTP call.

```typescript
import { ValidationError } from '@syrin/sdk';

try {
  await sdk.sessions.rate('ses_123', 'excellent' as never); // invalid
} catch (err) {
  if (err instanceof ValidationError) {
    console.error(`Invalid input: ${err.message}`);
    // "Invalid rating 'excellent'. Must be 'positive' or 'negative'."
  }
}
```

**When thrown:** When `rating` is not `"positive"` or `"negative"`.

---

### `GovernanceStopError`

Thrown when the Syrin backend sends a `stop` governance action. This is thrown inside an instrumented LLM call — it interrupts the current LLM call in progress.

```typescript
class GovernanceStopError extends Error {
  reason: string;             // human-readable explanation from the backend
  incidentId: string | null;  // optional correlation ID
  driftScore: number | null;  // drift score at time of stop action
}
```

```typescript
import { GovernanceStopError } from '@syrin/sdk';

try {
  await withSession(sessionId, async () => {
    while (true) {
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: history,
      });
      // process...
    }
  });
} catch (err) {
  if (err instanceof GovernanceStopError) {
    console.error(`Agent stopped: ${err.reason}`);
    console.error(`Incident: ${err.incidentId}`);
    saveState(history);
    process.exit(0);
  }
}
```

**When thrown:** On the next LLM call after the backend sends a `stop` governance action.

---

### Catching All SDK Errors

```typescript
import { SyrinError, GovernanceStopError } from '@syrin/sdk';

try {
  await withSession(sessionId, async () => {
    const response = await client.chat.completions.create({ ... });
    await sdk.sessions.rate(sessionId, 'positive');
  });
} catch (err) {
  if (err instanceof GovernanceStopError) {
    // Control flow event — handle separately
    handleStop(err);
  } else if (err instanceof SyrinError) {
    // Other SDK errors (feedback, session not found, etc.)
    console.error(`Syrin SDK error: ${err.message} (http=${err.httpStatus})`);
  } else {
    throw err;
  }
}
```

### `TypeError` from `init()`

`init()` throws `TypeError` for configuration errors:

```typescript
try {
  const sdk = await init(); // no apiKey
} catch (err) {
  console.error(err); // "SYRIN_API_KEY is required..."
}
```

Network errors during registration are non-fatal — `init()` succeeds and the SDK operates in a degraded state until the backend becomes reachable.

### `getInstance()` Returns Null

`getInstance()` returns `null` rather than throwing if the named instance hasn't been initialized:

```typescript
import { getInstance } from '@syrin/sdk';

const sdk = getInstance('my-instance');
if (!sdk) {
  throw new Error('Call init() first');
}
```
