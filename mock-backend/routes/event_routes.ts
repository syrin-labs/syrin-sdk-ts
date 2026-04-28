/**
 * GET /events — return all received events.
 */

import type { Request, Response } from 'express';
import { getAllEvents } from '../event_store.js';

export function handleGetEvents(_req: Request, res: Response): void {
  const events = getAllEvents();
  res.json({ total: events.length, events });
}
