/**
 * Tests: src/agent/router.ts — MultiAgentRouter
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MultiAgentRouter } from '@/agent/router';
import { SessionStore } from '@/core/session';

afterEach(() => vi.clearAllMocks());

function makeRouter(agents: Record<string, (task: string, sessionId?: string) => Promise<string>>) {
  const sessionStore = new SessionStore();
  const router = new MultiAgentRouter({ agentFunctions: agents, sessionStore });
  return { router, sessionStore };
}

describe('MultiAgentRouter.handle', () => {
  it('dispatches to the correct agent function', async () => {
    const researchFn = vi.fn().mockResolvedValue('research result');
    const { router } = makeRouter({ 'researcher': researchFn });

    const result = await router.handle('researcher', 'run', { task: 'find data' });

    expect(researchFn).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.result).toBe('research result');
    expect(result.agent_id).toBe('researcher');
  });

  it('returns error for unknown agent', async () => {
    const { router } = makeRouter({ 'researcher': vi.fn().mockResolvedValue('') });

    const result = await router.handle('unknown_agent', 'run', { task: 'do it' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown agent');
    expect(result.error).toContain('unknown_agent');
  });

  it('uses provided syrin_session_id', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const { router } = makeRouter({ 'agent-a': fn });

    const result = await router.handle('agent-a', 'run', {
      task: 'work',
      syrin_session_id: 'ses_explicit',
    });

    expect(result.session_id).toBe('ses_explicit');
    expect(fn).toHaveBeenCalledWith('work', 'ses_explicit');
  });

  it('generates session_id when not provided', async () => {
    const fn = vi.fn().mockResolvedValue('done');
    const { router } = makeRouter({ 'agent-b': fn });

    const result = await router.handle('agent-b', 'run', { task: 'work' });

    expect(result.session_id).toMatch(/^ses_/);
    expect(result.ok).toBe(true);
  });

  it('sets session type from syrin_session_type', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const { router, sessionStore } = makeRouter({ 'agent-c': fn });

    const result = await router.handle('agent-c', 'run', {
      task: 'go',
      syrin_session_type: 'workflow_test',
      syrin_session_id: 'ses_type_test',
    });

    const session = sessionStore.getSession('ses_type_test');
    expect(session?.sessionType).toBe('workflow_test');
    expect(result.ok).toBe(true);
  });

  it('defaults session_type to production', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const { router, sessionStore } = makeRouter({ 'agent-d': fn });

    const result = await router.handle('agent-d', 'run', {
      task: 'go',
      syrin_session_id: 'ses_default_type',
    });

    const session = sessionStore.getSession('ses_default_type');
    expect(session?.sessionType).toBe('production');
    expect(result.ok).toBe(true);
  });

  it('extracts task from "message" field', async () => {
    const fn = vi.fn().mockResolvedValue('reply');
    const { router } = makeRouter({ 'agent-e': fn });

    await router.handle('agent-e', 'chat', { message: 'hello agent' });

    expect(fn).toHaveBeenCalledWith('hello agent', expect.any(String));
  });

  it('extracts task from messages array (last user message)', async () => {
    const fn = vi.fn().mockResolvedValue('reply');
    const { router } = makeRouter({ 'agent-f': fn });

    await router.handle('agent-f', 'chat', {
      messages: [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'follow up' },
      ],
    });

    expect(fn).toHaveBeenCalledWith('follow up', expect.any(String));
  });

  it('falls back to JSON stringify for unknown body shape', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const { router } = makeRouter({ 'agent-g': fn });

    await router.handle('agent-g', 'run', { some_key: 'some_value' });

    const [task] = fn.mock.calls[0] as [string];
    expect(task).toContain('some_key');
  });

  it('returns error when agent function throws', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('agent crashed'));
    const { router } = makeRouter({ 'agent-h': fn });

    const result = await router.handle('agent-h', 'run', { task: 'work' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('agent crashed');
  });

  it('passes sessionId as second arg to agent function', async () => {
    const fn = vi.fn().mockResolvedValue('result');
    const { router } = makeRouter({ 'agent-i': fn });

    await router.handle('agent-i', 'run', {
      task: 'do it',
      syrin_session_id: 'ses_pass_test',
    });

    expect(fn).toHaveBeenCalledWith('do it', 'ses_pass_test');
  });
});

describe('MultiAgentRouter.express()', () => {
  it('handles POST /agent/:agentId/run', async () => {
    const fn = vi.fn().mockResolvedValue('express result');
    const { router } = makeRouter({ 'express-agent': fn });
    const middleware = router.express();

    const json = vi.fn();
    const req = {
      method: 'POST',
      path: '/agent/express-agent/run',
      body: { task: 'run task' },
    };
    const res = {
      json,
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };

    await middleware(req, res as typeof res & { end?: (s?: string) => void });

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('handles POST /agent/:agentId/chat', async () => {
    const fn = vi.fn().mockResolvedValue('chat result');
    const { router } = makeRouter({ 'chat-agent': fn });
    const middleware = router.express();

    const json = vi.fn();
    const req = {
      method: 'POST',
      path: '/agent/chat-agent/chat',
      body: { message: 'hi' },
    };
    const res = {
      json,
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };

    await middleware(req, res as typeof res & { end?: (s?: string) => void });

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('handles GET /agent/:agentId/health for known agent', async () => {
    const { router } = makeRouter({ 'healthy-agent': vi.fn().mockResolvedValue('ok') });
    const middleware = router.express();

    const json = vi.fn();
    const req = {
      method: 'GET',
      path: '/agent/healthy-agent/health',
    };
    const res = { json };

    await middleware(req, res as typeof res & { end?: (s?: string) => void; setHeader?: (n: string, v: string) => void; status?: (c: number) => typeof res });

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      agent_id: 'healthy-agent',
      status: 'online',
    }));
  });

  it('handles GET /agent/:agentId/health for unknown agent', async () => {
    const { router } = makeRouter({});
    const middleware = router.express();

    const json = vi.fn();
    const req = {
      method: 'GET',
      path: '/agent/unknown-agent/health',
    };
    const res = { json };

    await middleware(req, res as typeof res & { end?: (s?: string) => void; setHeader?: (n: string, v: string) => void; status?: (c: number) => typeof res });

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      status: 'unknown',
    }));
  });

  it('calls next() for non-matching routes', async () => {
    const { router } = makeRouter({ 'agent-j': vi.fn() });
    const middleware = router.express();

    const next = vi.fn();
    const req = { method: 'POST', path: '/other/route' };
    const res = {};

    await middleware(req, res as Record<string, unknown>, next);

    expect(next).toHaveBeenCalled();
  });

  it('calls next() for GET on non-health route', async () => {
    const { router } = makeRouter({ 'agent-k': vi.fn() });
    const middleware = router.express();

    const next = vi.fn();
    const req = { method: 'GET', path: '/agent/agent-k/run' };
    const res = {};

    await middleware(req, res as Record<string, unknown>, next);

    expect(next).toHaveBeenCalled();
  });
});

describe('MultiAgentRouter.fastify()', () => {
  it('registers post /agent/:agentId/run route', () => {
    const fn = vi.fn().mockResolvedValue('fastify result');
    const { router } = makeRouter({ 'fastify-agent': fn });
    const plugin = router.fastify();

    const routes: Record<string, (req: Record<string, unknown>, reply: Record<string, unknown>) => Promise<void>> = {};
    const fastify = {
      post: vi.fn((path: string, handler: unknown) => { routes[`POST:${path}`] = handler as typeof routes[string]; }),
      get: vi.fn((path: string, handler: unknown) => { routes[`GET:${path}`] = handler as typeof routes[string]; }),
    };
    const done = vi.fn();

    plugin(fastify as unknown as Parameters<typeof plugin>[0], {}, done);

    expect(done).toHaveBeenCalled();
    expect(fastify.post).toHaveBeenCalledWith('/agent/:agentId/run', expect.any(Function));
    expect(fastify.post).toHaveBeenCalledWith('/agent/:agentId/chat', expect.any(Function));
    expect(fastify.get).toHaveBeenCalledWith('/agent/:agentId/health', expect.any(Function));
  });

  it('fastify run handler dispatches to agent', async () => {
    const fn = vi.fn().mockResolvedValue('fastify run');
    const { router } = makeRouter({ 'fastify-run': fn });
    const plugin = router.fastify();

    let runHandler: ((req: unknown, reply: unknown) => Promise<void>) | null = null;
    const fastify = {
      post: vi.fn((path: string, handler: unknown) => {
        if (path === '/agent/:agentId/run') runHandler = handler as typeof runHandler;
      }),
      get: vi.fn(),
    };
    plugin(fastify as unknown as Parameters<typeof plugin>[0], {}, vi.fn());

    const send = vi.fn();
    await runHandler!({ params: { agentId: 'fastify-run' }, body: { task: 'test' } }, { send });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('fastify health handler returns correct status', async () => {
    const { router } = makeRouter({ 'fastify-health': vi.fn().mockResolvedValue('ok') });
    const plugin = router.fastify();

    let healthHandler: ((req: unknown, reply: unknown) => Promise<void>) | null = null;
    const fastify = {
      post: vi.fn(),
      get: vi.fn((path: string, handler: unknown) => {
        if (path === '/agent/:agentId/health') healthHandler = handler as typeof healthHandler;
      }),
    };
    plugin(fastify as unknown as Parameters<typeof plugin>[0], {}, vi.fn());

    const send = vi.fn();
    await healthHandler!({ params: { agentId: 'fastify-health' } }, { send });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      agent_id: 'fastify-health',
      status: 'online',
    }));
  });
});
