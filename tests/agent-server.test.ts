/**
 * Tests: AgentServer
 *
 * Covers:
 *  1. /agent/chat — calls onChat handler with payload minus syrin_ prefix fields
 *  2. /agent/chat — extracts syrin_session_type and stores it on the session
 *  3. /agent/chat — defaults session_type to 'production' when absent
 *  4. /agent/chat — uses provided syrin_session_id when present
 *  5. /agent/chat — returns ok: false when no onChat handler registered
 *  6. /agent/run — calls onRun handler
 *  7. /agent/run — extracts syrin_session_type
 *  8. Error handling — returns ok: false with error message when handler throws
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentServer } from '@/agent/server';
import { SessionStore } from '@/core/session';

function makeStore() {
  return new SessionStore();
}

describe('AgentServer', () => {
  describe('/agent/chat', () => {
    it('calls onChat handler with payload (minus syrin_ prefix fields)', async () => {
      const store = makeStore();
      const onChat = vi.fn().mockResolvedValue({ reply: 'hello' });

      const server = new AgentServer(store, { onChat });

      const rawBody = {
        message: 'hi there',
        syrin_session_type: 'chat_test',
        syrin_session_id: 'ses_abc123',
      };

      await server.handle('chat', rawBody);

      expect(onChat).toHaveBeenCalledOnce();
      const [calledPayload] = onChat.mock.calls[0] as [Record<string, unknown>, string];
      // syrin_ fields must be stripped
      expect(calledPayload).not.toHaveProperty('syrin_session_type');
      expect(calledPayload).not.toHaveProperty('syrin_session_id');
      // regular fields must be present
      expect(calledPayload['message']).toBe('hi there');
    });

    it('extracts syrin_session_type and stores it on the session', async () => {
      const store = makeStore();
      const onChat = vi.fn().mockResolvedValue({});

      const server = new AgentServer(store, { onChat });

      await server.handle('chat', {
        syrin_session_type: 'workflow_test',
        syrin_session_id: 'ses_wf_1',
      });

      const session = store.getSession('ses_wf_1');
      expect(session).toBeDefined();
      expect(session!.sessionType).toBe('workflow_test');
    });

    it('defaults session_type to production when absent', async () => {
      const store = makeStore();
      const onChat = vi.fn().mockResolvedValue({});

      const server = new AgentServer(store, { onChat });
      const result = await server.handle('chat', { message: 'ping' });

      const session = store.getSession(result.session_id);
      expect(session).toBeDefined();
      expect(session!.sessionType).toBe('production');
    });

    it('uses provided syrin_session_id when present', async () => {
      const store = makeStore();
      const onChat = vi.fn().mockResolvedValue({});

      const server = new AgentServer(store, { onChat });
      const result = await server.handle('chat', {
        syrin_session_id: 'ses_custom_id',
      });

      expect(result.session_id).toBe('ses_custom_id');
      // handler was called with session id
      const [, sessionId] = onChat.mock.calls[0] as [Record<string, unknown>, string];
      expect(sessionId).toBe('ses_custom_id');
    });

    it('returns ok: false when no onChat handler registered', async () => {
      const store = makeStore();
      const server = new AgentServer(store, {});

      const result = await server.handle('chat', { message: 'hello' });

      expect(result.ok).toBe(false);
      expect(result['error']).toMatch(/chat/i);
    });

    it('merges handler result into response with ok: true and session_id', async () => {
      const store = makeStore();
      const onChat = vi.fn().mockResolvedValue({ answer: 42, extra: 'yes' });

      const server = new AgentServer(store, { onChat });
      const result = await server.handle('chat', { syrin_session_id: 'ses_merge' });

      expect(result.ok).toBe(true);
      expect(result.session_id).toBe('ses_merge');
      expect(result['answer']).toBe(42);
      expect(result['extra']).toBe('yes');
    });
  });

  describe('/agent/run', () => {
    it('calls onRun handler', async () => {
      const store = makeStore();
      const onRun = vi.fn().mockResolvedValue({ status: 'done' });

      const server = new AgentServer(store, { onRun });
      const result = await server.handle('run', {
        input: 'run task',
        syrin_session_id: 'ses_run_1',
      });

      expect(onRun).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      expect(result['status']).toBe('done');
    });

    it('extracts syrin_session_type for run endpoint', async () => {
      const store = makeStore();
      const onRun = vi.fn().mockResolvedValue({});

      const server = new AgentServer(store, { onRun });

      await server.handle('run', {
        syrin_session_type: 'simulation',
        syrin_session_id: 'ses_sim_1',
      });

      const session = store.getSession('ses_sim_1');
      expect(session).toBeDefined();
      expect(session!.sessionType).toBe('simulation');
    });

    it('returns ok: false when no onRun handler registered', async () => {
      const store = makeStore();
      const server = new AgentServer(store, {});

      const result = await server.handle('run', {});

      expect(result.ok).toBe(false);
      expect(result['error']).toMatch(/run/i);
    });
  });

  describe('error handling', () => {
    it('returns ok: false with error message when handler throws', async () => {
      const store = makeStore();
      const onChat = vi.fn().mockRejectedValue(new Error('Handler blew up'));

      const server = new AgentServer(store, { onChat });
      const result = await server.handle('chat', { syrin_session_id: 'ses_err_1' });

      expect(result.ok).toBe(false);
      expect(result.session_id).toBe('ses_err_1');
      expect(result['error']).toBe('Handler blew up');
    });

    it('returns ok: false with stringified error when handler throws non-Error', async () => {
      const store = makeStore();
      const onRun = vi.fn().mockRejectedValue('string error');

      const server = new AgentServer(store, { onRun });
      const result = await server.handle('run', {});

      expect(result.ok).toBe(false);
      expect(typeof result['error']).toBe('string');
    });
  });
});
