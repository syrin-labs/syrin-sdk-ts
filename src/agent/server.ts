/**
 * AgentServer — lightweight HTTP endpoint registry for Syrin-managed agents.
 *
 * Exposes /agent/chat and /agent/run as POST endpoints.
 * The Syrin backend proxy calls these; the syrin_session_type field in the
 * request body is extracted and stored on the session so it flows through
 * to ingest automatically.
 */

import type { SessionStore } from '@/core/session.js';
import type { SessionType } from '@/types.js';
import { generateId } from '@/utils/helpers.js';

export type AgentHandler = (
  payload: Record<string, unknown>,
  sessionId: string,
) => Promise<Record<string, unknown>>;

export interface AgentServerOptions {
  /** Called for POST /agent/chat requests */
  onChat?: AgentHandler;
  /** Called for POST /agent/run requests */
  onRun?: AgentHandler;
}

/**
 * Handles an incoming POST body from the Syrin backend proxy.
 * Extracts syrin_session_type, generates a session_id, calls the handler.
 */
export class AgentServer {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly options: AgentServerOptions,
  ) {}

  /**
   * Handle a request to /agent/chat or /agent/run.
   * Returns { ok, session_id, ...handlerResult }
   */
  async handle(
    endpoint: 'chat' | 'run',
    rawBody: Record<string, unknown>,
  ): Promise<{ ok: boolean; session_id: string; [key: string]: unknown }> {
    // Extract syrin metadata from body before passing to handler
    const { syrin_session_type, syrin_session_id, ...payload } = rawBody;

    const sessionType = (syrin_session_type as SessionType | undefined) ?? 'production';
    const sessionId =
      (syrin_session_id as string | undefined) ?? generateId('ses_');

    // Pre-create the session with the session type so the emitter picks it up
    await this.sessionStore.getOrCreate(sessionId);
    this.sessionStore.setSessionType(sessionId, sessionType);

    const handler = endpoint === 'chat' ? this.options.onChat : this.options.onRun;
    if (!handler) {
      return {
        ok: false,
        session_id: sessionId,
        error: `No handler registered for /agent/${endpoint}`,
      };
    }

    try {
      const result = await handler(payload, sessionId);
      return { ok: true, session_id: sessionId, ...result };
    } catch (err) {
      return {
        ok: false,
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
