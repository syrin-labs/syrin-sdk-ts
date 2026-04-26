/**
 * Tests: src/agent/server.ts — AgentServer extended
 * Covers lines 48-173, 183-195 (fetch handler, express, fastify)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentServer } from '@/agent/server';
import { SessionStore } from '@/core/session';

afterEach(() => vi.clearAllMocks());

function makeStore() {
  return new SessionStore();
}

// ── Web Fetch API handler ─────────────────────────────────────────────────────

describe('AgentServer._fetchHandler (server.fetch)', () => {
  it('GET request returns 405 Method Not Allowed', async () => {
    const store = makeStore();
    const server = new AgentServer(store, {
      onChat: vi.fn().mockResolvedValue({ reply: 'hi' }),
    });

    const req = new Request('http://localhost/agent/chat', { method: 'GET' });
    const res = await server.fetch(req);
    expect(res.status).toBe(405);
    const body = await res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(false);
  });

  it('POST to /agent/chat delegates to handle and returns 200', async () => {
    const store = makeStore();
    const onChat = vi.fn().mockResolvedValue({ result: 'chat response' });
    const server = new AgentServer(store, { onChat });

    const req = new Request('http://localhost/agent/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'hello', syrin_session_id: 'ses_fetch_1' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await server.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['result']).toBe('chat response');
  });

  it('POST to /agent/run delegates to handle and returns 200', async () => {
    const store = makeStore();
    const onRun = vi.fn().mockResolvedValue({ status: 'complete' });
    const server = new AgentServer(store, { onRun });

    const req = new Request('http://localhost/agent/run', {
      method: 'POST',
      body: JSON.stringify({ task: 'do work', syrin_session_id: 'ses_fetch_2' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await server.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['status']).toBe('complete');
  });

  it('POST to unknown path returns 404', async () => {
    const store = makeStore();
    const server = new AgentServer(store, {});

    const req = new Request('http://localhost/agent/unknown', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await server.fetch(req);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(false);
  });

  it('invalid JSON body returns 400', async () => {
    const store = makeStore();
    const server = new AgentServer(store, {
      onChat: vi.fn().mockResolvedValue({}),
    });

    const req = new Request('http://localhost/agent/chat', {
      method: 'POST',
      body: 'not-valid-json{{{',
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await server.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body['ok']).toBe(false);
    expect(body['error']).toMatch(/invalid json/i);
  });

  it('response contains Content-Type: application/json header', async () => {
    const store = makeStore();
    const onChat = vi.fn().mockResolvedValue({ msg: 'ok' });
    const server = new AgentServer(store, { onChat });

    const req = new Request('http://localhost/agent/chat', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await server.fetch(req);
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('URL with prefix path ending in /agent/chat is matched correctly', async () => {
    const store = makeStore();
    const onChat = vi.fn().mockResolvedValue({ reply: 'ok' });
    const server = new AgentServer(store, { onChat });

    const req = new Request('http://localhost:3000/api/v1/agent/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'hi' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await server.fetch(req);
    expect(res.status).toBe(200);
    expect(onChat).toHaveBeenCalledOnce();
  });
});

// ── Express middleware ────────────────────────────────────────────────────────

describe('AgentServer.express()', () => {
  it('POST /agent/chat calls handler and sends JSON response', async () => {
    const store = makeStore();
    const onChat = vi.fn().mockResolvedValue({ reply: 'express chat' });
    const server = new AgentServer(store, { onChat });

    const middleware = server.express();
    const req = {
      method: 'POST',
      path: '/agent/chat',
      url: '/agent/chat',
      body: { message: 'hello', syrin_session_id: 'ses_exp_1' },
    };
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      end: vi.fn(),
    };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(onChat).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalledOnce();
    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(jsonArg['ok']).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('POST /agent/run calls onRun handler', async () => {
    const store = makeStore();
    const onRun = vi.fn().mockResolvedValue({ status: 'run done' });
    const server = new AgentServer(store, { onRun });

    const middleware = server.express();
    const req = {
      method: 'POST',
      path: '/agent/run',
      url: '/agent/run',
      body: { input: 'task', syrin_session_id: 'ses_exp_run_1' },
    };
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      end: vi.fn(),
    };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(onRun).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalledOnce();
    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(jsonArg['ok']).toBe(true);
  });

  it('non-POST request calls next()', async () => {
    const store = makeStore();
    const server = new AgentServer(store, {});
    const middleware = server.express();

    const req = { method: 'GET', path: '/agent/chat', url: '/agent/chat', body: {} };
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn(), end: vi.fn() };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('POST to unknown path calls next()', async () => {
    const store = makeStore();
    const server = new AgentServer(store, {});
    const middleware = server.express();

    const req = { method: 'POST', path: '/other/route', url: '/other/route', body: {} };
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn(), end: vi.fn() };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('falls back to res.end() when res.json is not available', async () => {
    const store = makeStore();
    const onChat = vi.fn().mockResolvedValue({ msg: 'ok' });
    const server = new AgentServer(store, { onChat });
    const middleware = server.express();

    const req = {
      method: 'POST',
      path: '/agent/chat',
      url: '/agent/chat',
      body: {},
    };
    // res without json method
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.end).toHaveBeenCalledOnce();
    const endArg = (res.end as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(endArg) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
  });

  it('supports url as fallback when path is absent', async () => {
    const store = makeStore();
    const onChat = vi.fn().mockResolvedValue({ reply: 'ok' });
    const server = new AgentServer(store, { onChat });
    const middleware = server.express();

    const req = {
      method: 'POST',
      url: '/agent/chat',
      // no path property
      body: {},
    };
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      end: vi.fn(),
    };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(onChat).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalledOnce();
  });

  it('handles non-object body by using empty object', async () => {
    const store = makeStore();
    const onChat = vi.fn().mockResolvedValue({ reply: 'ok' });
    const server = new AgentServer(store, { onChat });
    const middleware = server.express();

    const req = {
      method: 'POST',
      path: '/agent/chat',
      url: '/agent/chat',
      body: null, // non-object body
    };
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      end: vi.fn(),
    };

    await middleware(req, res);

    expect(onChat).toHaveBeenCalledOnce();
  });
});

// ── Fastify plugin ────────────────────────────────────────────────────────────

describe('AgentServer.fastify()', () => {
  it('registers /agent/chat and /agent/run routes', () => {
    const store = makeStore();
    const onChat = vi.fn().mockResolvedValue({ result: 'chat' });
    const onRun = vi.fn().mockResolvedValue({ result: 'run' });
    const server = new AgentServer(store, { onChat, onRun });

    const plugin = server.fastify();
    const registeredRoutes: Array<{ method: string; path: string }> = [];
    const mockFastify = {
      post: vi.fn((path: string) => {
        registeredRoutes.push({ method: 'POST', path });
      }),
    };
    const done = vi.fn();

    plugin(mockFastify, {}, done);

    expect(done).toHaveBeenCalledOnce();
    expect(registeredRoutes).toContainEqual({ method: 'POST', path: '/agent/chat' });
    expect(registeredRoutes).toContainEqual({ method: 'POST', path: '/agent/run' });
  });

  it('fastify chat route handler calls handle and replies', async () => {
    const store = makeStore();
    const onChat = vi.fn().mockResolvedValue({ answer: 42 });
    const server = new AgentServer(store, { onChat });

    const plugin = server.fastify();
    let capturedChatHandler: ((req: unknown, reply: unknown) => Promise<unknown>) | undefined;

    const mockFastify = {
      post: vi.fn((path: string, handler: (req: unknown, reply: unknown) => Promise<unknown>) => {
        if (path === '/agent/chat') capturedChatHandler = handler;
      }),
    };
    const done = vi.fn();
    plugin(mockFastify, {}, done);

    expect(capturedChatHandler).toBeDefined();

    const reply = { send: vi.fn() };
    const request = { body: { syrin_session_id: 'ses_fst_1', message: 'hello' } };
    await capturedChatHandler!(request, reply);

    expect(reply.send).toHaveBeenCalledOnce();
    const sentData = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(sentData['ok']).toBe(true);
    expect(sentData['answer']).toBe(42);
  });

  it('fastify run route handler calls handle and replies', async () => {
    const store = makeStore();
    const onRun = vi.fn().mockResolvedValue({ status: 'done' });
    const server = new AgentServer(store, { onRun });

    const plugin = server.fastify();
    let capturedRunHandler: ((req: unknown, reply: unknown) => Promise<unknown>) | undefined;

    const mockFastify = {
      post: vi.fn((path: string, handler: (req: unknown, reply: unknown) => Promise<unknown>) => {
        if (path === '/agent/run') capturedRunHandler = handler;
      }),
    };
    const done = vi.fn();
    plugin(mockFastify, {}, done);

    expect(capturedRunHandler).toBeDefined();

    const reply = { send: vi.fn() };
    const request = { body: { syrin_session_id: 'ses_fst_run_1' } };
    await capturedRunHandler!(request, reply);

    expect(reply.send).toHaveBeenCalledOnce();
    const sentData = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(sentData['ok']).toBe(true);
    expect(sentData['status']).toBe('done');
  });

  it('fastify handles null request body with empty object', async () => {
    const store = makeStore();
    const onRun = vi.fn().mockResolvedValue({});
    const server = new AgentServer(store, { onRun });

    const plugin = server.fastify();
    let capturedRunHandler: ((req: unknown, reply: unknown) => Promise<unknown>) | undefined;

    const mockFastify = {
      post: vi.fn((path: string, handler: (req: unknown, reply: unknown) => Promise<unknown>) => {
        if (path === '/agent/run') capturedRunHandler = handler;
      }),
    };
    plugin(mockFastify, {}, vi.fn());

    const reply = { send: vi.fn() };
    // body is null / undefined
    await capturedRunHandler!({ body: null }, reply);

    expect(onRun).toHaveBeenCalledOnce();
  });
});
