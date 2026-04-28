/**
 * Express app factory — wires all routes together.
 * Exported separately so tests can import the app without starting the server.
 */

import express from 'express';
import {
  handleCreateCheckpoint,
  handleDeleteCheckpoint,
  handleGetCheckpoint,
  handleListCheckpoints,
} from './routes/checkpoint_routes.js';
import { handleClearConfig, handleClearGovernance, handleSetConfig, handleSetGovernance } from './routes/control_routes.js';
import { handleGetEvents } from './routes/event_routes.js';
import { handleHealth } from './routes/health_routes.js';
import { handleIngest } from './routes/ingest_routes.js';
import { handleMockOpenAI } from './routes/openai_mock_routes.js';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.post('/ingest', handleIngest);
  app.get('/events', handleGetEvents);

  app.post('/control/config', handleSetConfig);
  app.delete('/control/config', handleClearConfig);
  app.post('/control/governance', handleSetGovernance);
  app.delete('/control/governance', handleClearGovernance);

  app.post('/checkpoints', handleCreateCheckpoint);
  app.get('/checkpoints/:id', handleGetCheckpoint);
  app.get('/checkpoints', handleListCheckpoints);
  app.delete('/checkpoints/:id', handleDeleteCheckpoint);

  app.post('/v1/chat/completions', handleMockOpenAI);

  app.get('/health', handleHealth);

  return app;
}

export const app = createApp();
