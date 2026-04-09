/**
 * Syrin Mock Backend Server
 *
 * Run: npm run mock-backend
 * Or:  tsx mock-backend/server.ts
 */

import express from 'express';
import type { Request, Response } from 'express';
import type { IngestPayload, SyrinEvent } from '../src/types.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 4318;

// Storage
const allEvents: Array<{ receivedAt: string; event: SyrinEvent; sessionId: string }> = [];
let pendingConfigUpdates: Record<string, unknown> = {};
let pendingGovernance: { actions: Array<Record<string, unknown>>; loop_detected?: boolean; drift_score?: number; incident_id?: string } | null = null;
let totalEventsReceived = 0;

// Checkpoint store (keyed by checkpoint_id)
const checkpointStore = new Map<string, Record<string, unknown>>();

// ANSI colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function timestamp(): string {
  return new Date().toTimeString().split(' ')[0]!.replace(/(\d+:\d+:\d+)/, (_, t) => {
    const ms = String(new Date().getMilliseconds()).padStart(3, '0');
    return `${t}.${ms}`;
  });
}

function formatTokens(input: number, output: number): string {
  return `${input.toLocaleString()}→${output.toLocaleString()} tokens`;
}

function formatCost(usd: number): string {
  if (usd < 0.0001) return `$${usd.toFixed(8)}`;
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

function formatEvent(event: SyrinEvent): string {
  const type = event.event_type === 'LLM_CALL' ? `${C.green}LLM_CALL${C.reset}` :
    event.event_type === 'LLM_ERROR' ? `${C.red}LLM_ERROR${C.reset}` :
    `${C.yellow}${event.event_type}${C.reset}`;

  const model = `${C.cyan}${event.model}${C.reset}`;
  const tokens = `${C.dim}${formatTokens(event.input_tokens, event.output_tokens)}${C.reset}`;
  const cost = `${C.yellow}${formatCost(event.cost_usd)}${C.reset}`;
  const duration = `${C.dim}${event.duration_ms}ms${C.reset}`;
  const stream = event.stream ? `${C.blue}[stream]${C.reset} ` : '';
  const config = event.config_applied ? `${C.magenta}[cfg]${C.reset} ` : '';
  const error = event.error ? ` ${C.red}ERR: ${event.error}${C.reset}` : ` ${C.green}✓${C.reset}`;

  return `  ${type}  ${model}  ${tokens}  ${cost}  ${duration}  ${stream}${config}${error}`;
}

// POST /ingest
app.post('/ingest', (req: Request, res: Response) => {
  const payload = req.body as IngestPayload;

  if (!payload || !Array.isArray(payload.events)) {
    res.status(400).json({ ok: false, error: 'Invalid payload' });
    return;
  }

  const sessionId = payload.session_id ?? 'unknown';
  const eventCount = payload.events.length;
  totalEventsReceived += eventCount;

  // Store events
  const receivedAt = new Date().toISOString();
  for (const event of payload.events) {
    allEvents.push({ receivedAt, event, sessionId });
  }

  // Pretty print
  console.log(
    `\n${C.gray}[${timestamp()}]${C.reset} ${C.blue}←${C.reset} ${C.bold}POST /ingest${C.reset}  ` +
    `${C.cyan}session=${sessionId.substring(0, 20)}${C.reset}  ` +
    `${C.yellow}events=${eventCount}${C.reset}`
  );

  for (const event of payload.events) {
    console.log(formatEvent(event));
  }

  // Build response
  const response: {
    ok: boolean;
    config_updates?: Record<string, unknown>;
    tool_validation_results?: Record<string, { valid: boolean }>;
    governance?: typeof pendingGovernance;
  } = { ok: true };

  if (Object.keys(pendingConfigUpdates).length > 0) {
    response.config_updates = { ...pendingConfigUpdates };
    console.log(
      `  ${C.magenta}→ Injecting config_updates:${C.reset}`,
      JSON.stringify(response.config_updates)
    );
    // Clear after sending (one-shot)
    pendingConfigUpdates = {};
  }

  // Inject tool_validation_results for any tool calls in this batch
  const toolCallIds: string[] = [];
  for (const event of payload.events) {
    if (event.tool_calls_raw) {
      const calls = event.tool_calls_raw as Array<{ id?: string }>;
      for (const call of calls) {
        if (call.id) toolCallIds.push(call.id);
      }
    }
  }
  if (toolCallIds.length > 0) {
    response.tool_validation_results = Object.fromEntries(
      toolCallIds.map((id) => [id, { valid: true }])
    );
  }

  if (pendingGovernance) {
    response.governance = pendingGovernance;
    const actionTypes = pendingGovernance.actions.map((a) => a['type']).join(', ');
    console.log(
      `  ${C.red}→ Injecting governance actions: [${actionTypes}]${C.reset}`
    );
    pendingGovernance = null;
  }

  console.log(
    `${C.gray}[${timestamp()}]${C.reset} ${C.green}→${C.reset} ${C.bold}200 OK${C.reset}  ` +
    `${JSON.stringify(response)}`
  );

  res.status(200).json(response);
});

// GET /events — return all received events
app.get('/events', (_req: Request, res: Response) => {
  res.json({
    total: allEvents.length,
    events: allEvents,
  });
});

// POST /control/config — queue config updates for next response
app.post('/control/config', (req: Request, res: Response) => {
  const updates = req.body as Record<string, unknown>;

  if (!updates || typeof updates !== 'object') {
    res.status(400).json({ ok: false, error: 'Body must be a JSON object' });
    return;
  }

  pendingConfigUpdates = { ...pendingConfigUpdates, ...updates };

  console.log(
    `\n${C.gray}[${timestamp()}]${C.reset} ${C.magenta}CONFIG QUEUED:${C.reset}`,
    JSON.stringify(pendingConfigUpdates)
  );

  res.json({ ok: true, pending: pendingConfigUpdates });
});

// DELETE /control/config — clear pending config
app.delete('/control/config', (_req: Request, res: Response) => {
  pendingConfigUpdates = {};
  console.log(`\n${C.gray}[${timestamp()}]${C.reset} ${C.yellow}CONFIG CLEARED${C.reset}`);
  res.json({ ok: true });
});

// POST /checkpoints — create a checkpoint
app.post('/checkpoints', (req: Request, res: Response) => {
  const cp = req.body as Record<string, unknown>;
  if (!cp || typeof cp['checkpoint_id'] !== 'string') {
    res.status(400).json({ ok: false, error: 'checkpoint_id required' });
    return;
  }
  checkpointStore.set(cp['checkpoint_id'] as string, cp);
  console.log(
    `\n${C.gray}[${timestamp()}]${C.reset} ${C.blue}CHECKPOINT SAVED${C.reset}  ` +
    `id=${cp['checkpoint_id']}  session=${cp['session_id']}  label=${cp['label'] ?? '-'}`
  );
  res.status(201).json({ ok: true, checkpoint_id: cp['checkpoint_id'] });
});

// GET /checkpoints/:id — retrieve a checkpoint
app.get('/checkpoints/:id', (req: Request, res: Response) => {
  const cp = checkpointStore.get(req.params['id']!);
  if (!cp) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  res.json({ ok: true, checkpoint: cp });
});

// GET /checkpoints — list checkpoints for a session
app.get('/checkpoints', (req: Request, res: Response) => {
  const sessionId = req.query['session_id'] as string | undefined;
  const all = [...checkpointStore.values()];
  const filtered = sessionId ? all.filter((cp) => cp['session_id'] === sessionId) : all;
  res.json({ ok: true, checkpoints: filtered, total: filtered.length });
});

// DELETE /checkpoints/:id — remove a checkpoint
app.delete('/checkpoints/:id', (req: Request, res: Response) => {
  const deleted = checkpointStore.delete(req.params['id']!);
  res.json({ ok: deleted });
});

// POST /control/governance — queue governance actions for next response
app.post('/control/governance', (req: Request, res: Response) => {
  const body = req.body as { actions?: Array<Record<string, unknown>>; loop_detected?: boolean; drift_score?: number; incident_id?: string };

  if (!body || !Array.isArray(body.actions)) {
    res.status(400).json({ ok: false, error: 'Body must have an "actions" array' });
    return;
  }

  pendingGovernance = {
    actions: body.actions,
    loop_detected: body.loop_detected,
    drift_score: body.drift_score,
    incident_id: body.incident_id,
  };

  const actionTypes = body.actions.map((a) => a['type']).join(', ');
  console.log(
    `\n${C.gray}[${timestamp()}]${C.reset} ${C.red}GOVERNANCE QUEUED: [${actionTypes}]${C.reset}`
  );

  res.json({ ok: true, pending: pendingGovernance });
});

// DELETE /control/governance — clear pending governance
app.delete('/control/governance', (_req: Request, res: Response) => {
  pendingGovernance = null;
  console.log(`\n${C.gray}[${timestamp()}]${C.reset} ${C.yellow}GOVERNANCE CLEARED${C.reset}`);
  res.json({ ok: true });
});

// GET /health
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, events_received: totalEventsReceived });
});

// Start server
app.listen(PORT, () => {
  console.log(`
${C.bold}${C.cyan}┌─────────────────────────────────────────────────────────┐
│  SYRIN MOCK BACKEND  •  http://localhost:${PORT}           │
└─────────────────────────────────────────────────────────┘${C.reset}

${C.dim}Endpoints:
  POST   /ingest                Receive SDK events
  GET    /events                View all received events
  POST   /checkpoints           Store a checkpoint
  GET    /checkpoints/:id       Retrieve a checkpoint
  GET    /checkpoints           List checkpoints (optional ?session_id=)
  DELETE /checkpoints/:id       Remove a checkpoint
  POST   /control/config        Queue config update (e.g. { "temperature": 0.3 })
  DELETE /control/config        Clear pending config
  POST   /control/governance    Queue governance actions
  DELETE /control/governance    Clear pending governance
  GET    /health                Health check

Waiting for events...${C.reset}
`);
});

export { app };
