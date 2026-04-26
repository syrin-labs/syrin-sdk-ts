/**
 * Syrin Mock Backend — entry point.
 *
 * Run: npm run mock-backend
 * Or:  tsx mock-backend/server.ts
 *
 * Endpoints:
 *   POST   /ingest                  ← SDK sends events here
 *   GET    /events                  ← inspect all received events
 *   POST   /control/config          ← inject config_updates for next response
 *   DELETE /control/config          ← clear pending config
 *   POST   /control/governance      ← inject governance actions for next response
 *   DELETE /control/governance      ← clear pending governance
 *   POST   /checkpoints             ← create a checkpoint
 *   GET    /checkpoints/:id         ← retrieve a checkpoint
 *   GET    /checkpoints             ← list checkpoints (?session_id=)
 *   DELETE /checkpoints/:id         ← remove a checkpoint
 *   POST   /v1/chat/completions     ← mock OpenAI (set OPENAI_BASE_URL=http://localhost:<PORT>/v1)
 *   GET    /health                  ← { ok: true, events_received: N }
 */

import { C } from './display.js';
import { app } from './app.js';

// Re-export app so tests that import from server.ts continue to work
export { app };

const PORT = process.env['PORT'] ? parseInt(process.env['PORT'], 10) : 4318;

app.listen(PORT, '127.0.0.1', () => {
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
  POST   /v1/chat/completions   Mock OpenAI (set OPENAI_BASE_URL=http://localhost:${PORT}/v1)
  GET    /health                Health check

Waiting for events...${C.reset}
`);
});
