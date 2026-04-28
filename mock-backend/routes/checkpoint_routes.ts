/**
 * Checkpoint CRUD — POST/GET/DELETE /checkpoints.
 */

import type { Request, Response } from 'express';
import { C, timestamp } from '../console_display.js';
import {
  MAX_CHECKPOINT_BYTES,
  deleteCheckpoint,
  getCheckpoint,
  listCheckpoints,
  saveCheckpoint,
} from '../event_store.js';

export function handleCreateCheckpoint(req: Request, res: Response): void {
  const cp = req.body as Record<string, unknown>;

  if (!cp || typeof cp['checkpoint_id'] !== 'string') {
    res.status(400).json({ ok: false, error: 'checkpoint_id required' });
    return;
  }

  const bodySize = Buffer.byteLength(JSON.stringify(cp), 'utf8');
  if (bodySize > MAX_CHECKPOINT_BYTES) {
    res.status(413).json({ ok: false, error: 'checkpoint body too large' });
    return;
  }

  const checkpointId = cp['checkpoint_id'] as string;
  saveCheckpoint(checkpointId, cp);

  console.log(
    `\n${C.gray}[${timestamp()}]${C.reset} ${C.blue}CHECKPOINT SAVED${C.reset}  ` +
    `id=${checkpointId}  session=${cp['session_id']}  label=${cp['label'] ?? '-'}`
  );
  res.status(201).json({ ok: true, checkpoint_id: checkpointId });
}

export function handleGetCheckpoint(req: Request, res: Response): void {
  const cp = getCheckpoint(req.params['id']!);
  if (!cp) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  res.json({ ok: true, checkpoint: cp });
}

export function handleListCheckpoints(req: Request, res: Response): void {
  const sessionId = req.query['session_id'] as string | undefined;
  const checkpoints = listCheckpoints(sessionId);
  res.json({ ok: true, checkpoints, total: checkpoints.length });
}

export function handleDeleteCheckpoint(req: Request, res: Response): void {
  const deleted = deleteCheckpoint(req.params['id']!);
  res.json({ ok: deleted });
}
