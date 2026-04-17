# Integration Tests — Example Agent Servers

## Overview

This directory contains integration tests for all TypeScript example agent servers. Each test suite:

1. **Spawns all example servers** in parallel on distinct ports
2. **Isolates config** — each server gets its own temporary config directory
3. **Validates endpoints** — health checks, config read/write, chat, research, analyze
4. **Verifies config isolation** — pushing config to one server doesn't affect others

---

## Server Inventory

| Framework | Port | Config Dir | Script |
|-----------|------|-----------|---------|
| OpenAI | 8001 | `$SYRIN_CONFIG_DIR` | `examples/agent-openai.ts` |
| Anthropic | 8002 | `$SYRIN_CONFIG_DIR` | `examples/agent-anthropic.ts` |
| LangChain | 8003 | `$SYRIN_CONFIG_DIR` | `examples/agent-langchain.ts` |
| Mastra | 8005 | `$SYRIN_CONFIG_DIR` | `examples/agent-mastra.ts` |
| Vercel AI | 8006 | `$SYRIN_CONFIG_DIR` | `examples/agent-vercel.ts` |

Each server reads `SYRIN_CONFIG_DIR` from the environment, allowing test isolation.

---

## Running the Tests

### Prerequisites

1. **Syrin backend running** at `http://localhost:4000` (set `SYRIN_BACKEND_URL` to override)
2. **API keys in environment**:
   ```bash
   export SYRIN_API_KEY="syrin_..."
   export OPENAI_API_KEY="sk-..."
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```
3. **SDK built**:
   ```bash
   npm run build
   ```

### Run All Tests

```bash
npm test -- tests/integration/example-servers.test.ts
```

### Run a Single Framework

```bash
npm test -- tests/integration/example-servers.test.ts -t "openai"
```

### Run with Verbose Output

```bash
npm test -- tests/integration/example-servers.test.ts --reporter=verbose
```

---

## Test Structure

Each server gets the same test suite:

### Health Check
```
GET / → 200 { status: 'running', agent: {...} }
```

### Config Snapshot
```
GET /config → 200 { ...config... }
```

### Chat Endpoint
```
POST /chat { message: "hello" } → { response: "..." }
```

### Research Endpoint (not on mastra/vercel)
```
POST /research { query: "..." } → { result: "..." }
```

### Analyze Endpoint (not on mastra/vercel)
```
POST /analyze { text: "..." } → { sentiment: "...", themes: [...] }
```

### Config Push & Persistence
```
POST /syrin/config { "llm.temperature": 0.1 }
→ GET /config returns the new value
→ .syrin/syrin.config.json in configDir is updated
```

### Config Isolation
```
Server A: POST /syrin/config { "llm.temperature": 0.5 }
Server B: POST /syrin/config { "llm.temperature": 0.9 }
→ Server A's config file has 0.5
→ Server B's config file has 0.9
→ They're in different directories
```

---

## Architecture

### Server Manager (`helpers/server-manager.ts`)

Utilities for spawning and managing servers:

```typescript
// Start a server with isolated config directory
const handle = await startServer({
  name: 'openai',
  script: 'examples/agent-openai.ts',
  port: 8001,
  agentId: 'openai-ts-agent',
});

// Server is health-checked automatically
// handle.configDir contains its isolated config directory

// Stop the server and cleanup
await handle.kill();
```

### How Isolation Works

1. **Temp directory allocation**: Each server gets a unique `/tmp/syrin-test-{name}-{random}` directory
2. **Environment variable**: Test harness sets `SYRIN_CONFIG_DIR=/tmp/syrin-test-{name}-{random}`
3. **Server reads env var**: Example servers read `process.env.SYRIN_CONFIG_DIR` and pass to `init()`
4. **Config files isolated**: Each server's config goes to its own `.syrin/syrin.config.json`
5. **Cleanup**: On test shutdown, temp directories are removed

---

## Key Implementation Details

### Process Spawning

Servers are spawned via `npx tsx` (TypeScript runner):
```typescript
const process = spawn('npx', ['tsx', 'examples/agent-openai.ts'], {
  cwd: 'syrin-sdk-ts',
  env: { PORT: '8001', SYRIN_CONFIG_DIR: '/tmp/...' },
});
```

### Health Check Polling

Test harness waits for `GET /` to return 200 before considering server ready:
```typescript
await waitForServer('http://localhost:8001', 30_000);
```

Polls every 200ms up to 30 seconds, then fails.

### Graceful Shutdown

Servers are terminated via `SIGTERM`, with a 2-second timeout before `SIGKILL`:
```typescript
process.kill('SIGTERM');
setTimeout(() => process.kill('SIGKILL'), 2000);
```

---

## Troubleshooting

### "Server did not become healthy within 30s"

Check that:
1. Syrin backend is running (`http://localhost:4000`)
2. `SYRIN_BACKEND_URL` env var is set correctly
3. Example server logs for errors (spawn process captures stdout/stderr)
4. Port is not in use by another process

### "Module not found" errors

Ensure SDK is built:
```bash
npm run build
```

### "Missing SYRIN_API_KEY"

Set the API key:
```bash
export SYRIN_API_KEY="syrin_..."
```

### "Cannot find module @anthropic-ai/sdk"

Some frameworks are optional. Install test dependencies:
```bash
npm install --save-dev @anthropic-ai/sdk langchain @langchain/openai @mastra/core ai
```

---

## Extending the Tests

### Add a New Server

1. Add to `SERVERS` array in `example-servers.test.ts`:
   ```typescript
   {
     name: 'my-framework',
     script: 'examples/agent-my-framework.ts',
     port: 8007,
     agentId: 'my-framework-agent',
     framework: 'my-framework',
   }
   ```

2. Tests automatically run against the new server

### Add a New Endpoint Test

Add to the per-server describe block:
```typescript
it('POST /my-endpoint returns expected response', async () => {
  const res = await fetch(`${handle().url}/my-endpoint`, {
    method: 'POST',
    body: JSON.stringify({ ... }),
  });
  expect(res.status).toBe(200);
  // assertions...
});
```

### Custom Test Fixtures

Create fixtures in `tests/integration/fixtures/`:
```typescript
// fixtures/config-samples.ts
export const CONFIG_SAMPLES = {
  temperature: [0.1, 0.5, 0.9],
  models: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
};
```

Import and use in tests.

---

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `SYRIN_API_KEY` | Yes | — | Syrin backend authentication |
| `OPENAI_API_KEY` | No | — | OpenAI server only (skipped if missing) |
| `ANTHROPIC_API_KEY` | No | — | Anthropic server only (skipped if missing) |
| `SYRIN_BACKEND_URL` | No | `http://localhost:4000` | Backend endpoint |
| `NODE_ENV` | No | — | Set to `test` to reduce logging |

---

## Performance

- **Startup**: ~5s total for all 5 servers (parallel spawn)
- **Per-test**: ~100-500ms (depends on LLM API latency)
- **Full suite**: ~2-3 minutes (includes network waits)

### Speeding Up Tests

1. **Skip certain frameworks**: Run with `-t "openai"` to test only one
2. **Reduce polling interval**: Set shorter `configPollIntervalMs` in example servers
3. **Cache API responses**: Mock LLM calls in advanced test scenarios

---

## Related Docs

- [MULTI_USER_ARCHITECTURE.md](../../MULTI_USER_ARCHITECTURE.md) — Design patterns for multi-user and multi-agent deployments
- [examples/](../../examples/) — Individual example server documentation
