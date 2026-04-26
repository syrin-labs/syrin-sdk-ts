/**
 * AgentServer — pre-built HTTP handlers for Syrin-managed agents.
 *
 * Registers POST /agent/chat and POST /agent/run.  Plug the built-in
 * adapters into any server library — no extra routing code needed:
 *
 *   // Bun / Cloudflare Workers / Deno / Next.js (Web Fetch API)
 *   Bun.serve({ fetch: server.fetch, port: 3000 });
 *   export default { fetch: server.fetch };          // CF Workers / Deno
 *   export const POST = server.fetch;                 // Next.js route.ts
 *
 *   // Hono
 *   app.all('/agent/*', (c) => server.fetch(c.req.raw));
 *
 *   // Express / Connect / Koa
 *   app.use(server.express());
 *
 *   // Fastify
 *   fastify.register(server.fastify());
 */

import type { SessionStore } from '@/core/session.js';
import type { SessionType } from '@/types.js';
import { generateId } from '@/utils/helpers.js';

interface ExpressLikeRequest {
  method?: string;
  path?: string;
  url?: string;
  body?: unknown;
}

interface ExpressLikeResponse {
  setHeader?(name: string, value: string): void;
  status?(code: number): ExpressLikeResponse;
  json?(body: unknown): void;
  end?(body?: string): void;
  body?: string;
}

interface FastifyLikeRequest {
  body?: unknown;
}

interface FastifyLikeReply {
  send(payload: unknown): unknown;
}

interface FastifyLikeInstance {
  post(path: string, handler: (req: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<void>): void;
}

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

export class AgentServer {
  /**
   * Universal Web Fetch API handler.
   * Works natively with Bun, Cloudflare Workers, Deno, Hono, Next.js App Router,
   * SvelteKit, Remix, and any runtime that speaks `Request` → `Response`.
   *
   * @example
   * // Bun
   * Bun.serve({ fetch: server.fetch, port: 3000 });
   *
   * // Cloudflare Workers / Deno
   * export default { fetch: server.fetch };
   *
   * // Hono — mount under /agent prefix
   * app.all('/agent/*', (c) => server.fetch(c.req.raw));
   */
  readonly fetch: (request: Request) => Promise<Response>;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly options: AgentServerOptions,
  ) {
    // Bind fetch so it can be passed by reference without losing `this`
    this.fetch = this._fetchHandler.bind(this);
  }

  // ── Core dispatcher ───────────────────────────────────────────────────────

  /**
   * Dispatch a parsed body to the chat or run handler.
   * Strips `syrin_*` metadata, pre-creates the session, calls the user handler.
   */
  async handle(
    endpoint: 'chat' | 'run',
    rawBody: Record<string, unknown>,
  ): Promise<{ ok: boolean; session_id: string; [key: string]: unknown }> {
    const { syrin_session_type, syrin_session_id, ...payload } = rawBody;

    const sessionType = (syrin_session_type as SessionType | undefined) ?? 'production';
    const sessionId = (syrin_session_id as string | undefined) ?? generateId('ses_');

    await this.sessionStore.getOrCreate(sessionId);
    this.sessionStore.setSessionType(sessionId, sessionType);

    const handler = endpoint === 'chat' ? this.options.onChat : this.options.onRun;
    if (!handler) {
      return { ok: false, session_id: sessionId, error: `No handler for /agent/${endpoint}` };
    }

    try {
      const result = await handler(payload, sessionId);
      return { ok: true, session_id: sessionId, ...result };
    } catch (err) {
      return { ok: false, session_id: sessionId, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Web Fetch handler (internal) ──────────────────────────────────────────

  private async _fetchHandler(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const endpoint = url.pathname.endsWith('/agent/chat')
      ? 'chat'
      : url.pathname.endsWith('/agent/run')
        ? 'run'
        : null;

    if (!endpoint) {
      return new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await this.handle(endpoint, body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Framework adapters ────────────────────────────────────────────────────

  /**
   * Returns Express / Connect / Koa middleware.
   * Handles POST /agent/chat and POST /agent/run; passes everything else to next().
   *
   * @example
   * app.use(server.express());           // global middleware
   * router.use('/agent', server.express()); // scoped under /agent prefix (routes become /chat, /run)
   */
  express(): (req: ExpressLikeRequest, res: ExpressLikeResponse, next?: () => void) => Promise<void> {
    return async (req: ExpressLikeRequest, res: ExpressLikeResponse, next?: () => void): Promise<void> => {
      if (req.method !== 'POST') { next?.(); return; }

      const path: string = req.path ?? req.url ?? '';
      const endpoint = path === '/agent/chat' || path.endsWith('/agent/chat')
        ? 'chat'
        : path === '/agent/run' || path.endsWith('/agent/run')
          ? 'run'
          : null;

      if (!endpoint) { next?.(); return; }

      const body: Record<string, unknown> = typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};

      const result = await this.handle(endpoint, body);
      res.setHeader?.('Content-Type', 'application/json');
      res.status?.(200);
      // Supports express-style res.json(), koa-style ctx.body, and plain res.end()
      if (typeof res.json === 'function') { res.json(result); }
      else if ('body' in res) { res.body = JSON.stringify(result); }
      else { res.end?.(JSON.stringify(result)); }
    };
  }

  /**
   * Returns a Fastify plugin that registers POST /agent/chat and POST /agent/run.
   *
   * @example
   * fastify.register(server.fastify());
   */
  fastify(): (fastify: FastifyLikeInstance, opts: Record<string, unknown>, done: () => void) => void {
    return (f: FastifyLikeInstance, _opts: Record<string, unknown>, done: () => void): void => {
      f.post('/agent/chat', async (request: FastifyLikeRequest, reply: FastifyLikeReply) => {
        const body: Record<string, unknown> = typeof request.body === 'object' && request.body !== null
          ? (request.body as Record<string, unknown>)
          : {};
        reply.send(await this.handle('chat', body));
      });
      f.post('/agent/run', async (request: FastifyLikeRequest, reply: FastifyLikeReply) => {
        const body: Record<string, unknown> = typeof request.body === 'object' && request.body !== null
          ? (request.body as Record<string, unknown>)
          : {};
        reply.send(await this.handle('run', body));
      });
      done();
    };
  }
}
