/**
 * GET /health — liveness check.
 */

import type { Request, Response } from 'express';
import { getEventCount } from '../store.js';

export function handleHealth(_req: Request, res: Response): void {
  res.json({ ok: true, events_received: getEventCount() });
}
