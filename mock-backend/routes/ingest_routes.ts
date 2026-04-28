/**
 * POST /ingest — receive events from the SDK.
 */

import type { Request, Response } from 'express';
import type { IngestPayload } from '../../src/types.js';
import { C, formatEvent, timestamp } from '../console_display.js';
import { popPendingConfig, popPendingGovernance, storeEvents } from '../event_store.js';

export function handleIngest(req: Request, res: Response): void {
  const payload = req.body as IngestPayload;

  if (!payload || !Array.isArray(payload.events)) {
    res.status(400).json({ ok: false, error: 'Invalid payload: events must be an array' });
    return;
  }

  const sessionId = payload.session_id ?? 'unknown';
  const events = payload.events;

  storeEvents(events, sessionId);

  const pendingConfig = popPendingConfig();
  const pendingGov = popPendingGovernance();

  console.log(
    `\n${C.gray}[${timestamp()}]${C.reset} ${C.blue}←${C.reset} ${C.bold}POST /ingest${C.reset}  ` +
    `${C.cyan}session=${sessionId.substring(0, 20)}${C.reset}  ` +
    `${C.yellow}events=${events.length}${C.reset}`
  );

  for (const event of events) {
    console.log(formatEvent(event));
  }

  const response: {
    ok: boolean;
    config_updates?: Record<string, unknown>;
    tool_validation_results?: Record<string, { valid: boolean }>;
    governance?: typeof pendingGov;
  } = { ok: true };

  if (Object.keys(pendingConfig).length > 0) {
    response.config_updates = pendingConfig;
    console.log(`  ${C.magenta}→ Injecting config_updates:${C.reset}`, JSON.stringify(pendingConfig));
  }

  // Acknowledge any tool call IDs in this batch
  const toolCallIds: string[] = [];
  for (const event of events) {
    const calls = (event as Record<string, unknown>)['tool_calls_raw'] as Array<{ id?: string }> | undefined;
    if (calls) {
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

  if (pendingGov) {
    response.governance = pendingGov;
    const actionTypes = pendingGov.actions.map((a) => a['type']).join(', ');
    console.log(`  ${C.red}→ Injecting governance actions: [${actionTypes}]${C.reset}`);
  }

  console.log(
    `${C.gray}[${timestamp()}]${C.reset} ${C.green}→${C.reset} ${C.bold}200 OK${C.reset}  ` +
    `${JSON.stringify(response)}`
  );

  res.status(200).json(response);
}
