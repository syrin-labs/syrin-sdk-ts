/**
 * MultiAgentRouter — routes HTTP requests to per-agent handler functions.
 *
 * Provides per-agent endpoints:
 *   POST /agent/:agentId/run    — one-shot task execution
 *   POST /agent/:agentId/chat   — conversational interaction
 *   GET  /agent/:agentId/health — agent health check
 *
 * Usage:
 *   const router = sdk.createAgentRouter({ 'agent-a': runAgentA, 'agent-b': runAgentB });
 *   app.use(router.express());           // Express
 *   fastify.register(router.fastify());  // Fastify
 */

import type { SessionStore } from '@/core/session.js';
import { sessionStorage } from '@/core/session.js';
import { agentStorage } from '@/agent/context.js';
import { generateId } from '@/utils/helpers.js';
import type { SessionType } from '@/types.js';

export type AgentRunFn = (task: string, sessionId?: string) => Promise<string>;

// Minimal structural types for Express and Fastify — avoids importing those packages
// as hard dependencies while still providing typed adapters.
interface ExpressRequest {
  path?: string;
  url?: string;
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
}

interface ExpressResponse {
  json?(body: unknown): void;
  end?(body?: string): void;
  setHeader?(name: string, value: string): void;
  status?(code: number): ExpressResponse;
  body?: string;
}

interface FastifyRequest {
  params: Record<string, string>;
  body?: Record<string, unknown>;
}

interface FastifyReply {
  send(payload: unknown): void;
}

interface FastifyInstance {
  post(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>): void;
  get(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>): void;
}

export interface MultiAgentRouterOptions {
  /** Map of agentId → async run function */
  agentFunctions: Record<string, AgentRunFn>;
  sessionStore: SessionStore;
}

export class MultiAgentRouter {
  constructor(private readonly opts: MultiAgentRouterOptions) {}

  /**
   * Dispatch a run request to the correct agent handler.
   * Wraps the call in session + agent AsyncLocalStorage context.
   */
  async handle(
    agentId: string,
    endpoint: 'run' | 'chat',
    rawBody: Record<string, unknown>,
  ): Promise<{ ok: boolean; session_id: string; result?: string; error?: string }> {
    const { syrin_session_type, syrin_session_id, task, message, ...rest } = rawBody as Record<string, unknown>;

    const sessionType = (syrin_session_type as SessionType | undefined) ?? 'production';
    const sessionId = (syrin_session_id as string | undefined) ?? generateId('ses_');
    const taskStr = (task as string | undefined) ?? (message as string | undefined) ?? JSON.stringify(rest);

    const fn = this.opts.agentFunctions[agentId];
    if (!fn) {
      return { ok: false, session_id: sessionId, error: `Unknown agent: ${agentId}` };
    }

    await this.opts.sessionStore.getOrCreate(sessionId);
    this.opts.sessionStore.setSessionType(sessionId, sessionType);

    try {
      const result = await sessionStorage.run(sessionId, () =>
        agentStorage.run(
          { agentId, runId: generateId('run_') },
          () => fn(taskStr, sessionId),
        )
      );
      return { ok: true, session_id: sessionId, result };
    } catch (err) {
      return {
        ok: false,
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Returns Express / Connect middleware.
   * Handles POST /agent/:agentId/run, POST /agent/:agentId/chat, GET /agent/:agentId/health
   */
  express(): (req: ExpressRequest, res: ExpressResponse, next?: () => void) => void {
    return async (req: ExpressRequest, res: ExpressResponse, next?: () => void) => {
      const path: string = req.path ?? req.url ?? '';
      const method: string = req.method ?? 'GET';

      // Match /agent/:agentId/run or /agent/:agentId/chat
      const runMatch = path.match(/\/agent\/([^/]+)\/(run|chat)$/);
      const healthMatch = path.match(/\/agent\/([^/]+)\/health$/);

      if (healthMatch && method === 'GET') {
        const agentId = decodeURIComponent(healthMatch[1]);
        const known = agentId in this.opts.agentFunctions;
        const response = { ok: known, agent_id: agentId, status: known ? 'online' : 'unknown' };
        if (typeof res.json === 'function') res.json(response);
        else res.end?.(JSON.stringify(response));
        return;
      }

      if (!runMatch || method !== 'POST') {
        next?.();
        return;
      }

      const agentId = decodeURIComponent(runMatch[1]);
      const endpoint = runMatch[2] as 'run' | 'chat';
      const body: Record<string, unknown> = typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};

      const result = await this.handle(agentId, endpoint, body);
      res.setHeader?.('Content-Type', 'application/json');
      res.status?.(200);
      if (typeof res.json === 'function') res.json(result);
      else if ('body' in res) res.body = JSON.stringify(result);
      else res.end?.(JSON.stringify(result));
    };
  }

  /**
   * Returns a Fastify plugin that registers per-agent run/chat/health routes.
   */
  fastify(): (fastify: FastifyInstance, opts: Record<string, unknown>, done: () => void) => void {
    return (f: FastifyInstance, _opts: Record<string, unknown>, done: () => void) => {
      f.post('/agent/:agentId/run', async (request: FastifyRequest, reply: FastifyReply) => {
        const agentId = request.params['agentId'];
        return reply.send(await this.handle(agentId, 'run', request.body ?? {}));
      });
      f.post('/agent/:agentId/chat', async (request: FastifyRequest, reply: FastifyReply) => {
        const agentId = request.params['agentId'];
        return reply.send(await this.handle(agentId, 'chat', request.body ?? {}));
      });
      f.get('/agent/:agentId/health', async (request: FastifyRequest, reply: FastifyReply) => {
        const agentId = request.params['agentId'];
        const known = agentId in this.opts.agentFunctions;
        return reply.send({ ok: known, agent_id: agentId, status: known ? 'online' : 'unknown' });
      });
      done();
    };
  }
}
