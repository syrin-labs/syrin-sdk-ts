/**
 * POST/DELETE /control/config and /control/governance — test-control endpoints.
 *
 * These endpoints are for local testing only. They allow injecting config
 * updates and governance actions into the next /ingest response.
 */

import type { Request, Response } from 'express';
import { C, timestamp } from '../console_display.js';
import {
  clearPendingConfig,
  clearPendingGovernance,
  peekPendingConfig,
  setPendingConfig,
  setPendingGovernance,
  type PendingGovernance,
} from '../event_store.js';

export function handleSetConfig(req: Request, res: Response): void {
  const updates = req.body as Record<string, unknown>;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    res.status(400).json({ ok: false, error: 'Body must be a JSON object' });
    return;
  }

  setPendingConfig(updates);
  console.log(
    `\n${C.gray}[${timestamp()}]${C.reset} ${C.magenta}CONFIG QUEUED:${C.reset}`,
    JSON.stringify(peekPendingConfig())
  );
  res.json({ ok: true, pending: peekPendingConfig() });
}

export function handleClearConfig(_req: Request, res: Response): void {
  clearPendingConfig();
  console.log(`\n${C.gray}[${timestamp()}]${C.reset} ${C.yellow}CONFIG CLEARED${C.reset}`);
  res.json({ ok: true });
}

export function handleSetGovernance(req: Request, res: Response): void {
  const body = req.body as Partial<PendingGovernance>;
  if (!body || !Array.isArray(body.actions)) {
    res.status(400).json({ ok: false, error: 'Body must have an "actions" array' });
    return;
  }

  const gov: PendingGovernance = {
    actions: body.actions,
    loop_detected: body.loop_detected,
    drift_score: body.drift_score,
    incident_id: body.incident_id,
  };

  setPendingGovernance(gov);

  const actionTypes = body.actions.map((a) => a['type']).join(', ');
  console.log(
    `\n${C.gray}[${timestamp()}]${C.reset} ${C.red}GOVERNANCE QUEUED: [${actionTypes}]${C.reset}`
  );
  res.json({ ok: true, pending: gov });
}

export function handleClearGovernance(_req: Request, res: Response): void {
  clearPendingGovernance();
  console.log(`\n${C.gray}[${timestamp()}]${C.reset} ${C.yellow}GOVERNANCE CLEARED${C.reset}`);
  res.json({ ok: true });
}
