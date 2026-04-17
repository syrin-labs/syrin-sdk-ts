/**
 * Tests for IdentityManager — session and call context tracking.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IdentityManager, type IdentityContext, type CallContext, getIdentityManager, setIdentityManager } from '@/core/identity.js';

describe('IdentityManager', () => {
  let manager: IdentityManager;
  const sessionId = 'ses_test_123';

  beforeEach(() => {
    manager = new IdentityManager();
  });

  describe('Identity creation', () => {
    it('creates identity for a session', () => {
      const identity = manager.getOrCreateIdentity(sessionId, {
        userId: 'user_123',
        agentId: 'agent_456',
      });

      expect(identity.sessionId).toBe(sessionId);
      expect(identity.userId).toBe('user_123');
      expect(identity.agentId).toBe('agent_456');
      expect(identity.runId).toBeDefined();
      expect(identity.startedAt).toBeDefined();
    });

    it('returns existing identity without overwriting', () => {
      const identity1 = manager.getOrCreateIdentity(sessionId, {
        userId: 'user_123',
      });
      const runId1 = identity1.runId;

      const identity2 = manager.getOrCreateIdentity(sessionId);
      expect(identity2.runId).toBe(runId1);
      expect(identity2.userId).toBe('user_123');
    });

    it('updates identity fields when provided', () => {
      manager.getOrCreateIdentity(sessionId, { userId: 'user_old' });
      manager.getOrCreateIdentity(sessionId, { userId: 'user_new' });

      const identity = manager.getOrCreateIdentity(sessionId);
      expect(identity.userId).toBe('user_new');
    });
  });

  describe('User identity', () => {
    it('sets user ID', () => {
      manager.setUserId(sessionId, 'user_abc');
      const identity = manager.getOrCreateIdentity(sessionId);
      expect(identity.userId).toBe('user_abc');
    });
  });

  describe('Agent identity', () => {
    it('sets agent ID and name', () => {
      manager.setAgentId(sessionId, 'agent_xyz', 'My Research Agent');
      const identity = manager.getOrCreateIdentity(sessionId);
      expect(identity.agentId).toBe('agent_xyz');
      expect(identity.agentName).toBe('My Research Agent');
    });
  });

  describe('Framework context', () => {
    it('tracks framework', () => {
      manager.setFramework(sessionId, 'openai');
      const identity = manager.getOrCreateIdentity(sessionId);
      expect(identity.framework).toBe('openai');
    });

    it('allows updating framework', () => {
      manager.setFramework(sessionId, 'anthropic');
      manager.setFramework(sessionId, 'langchain');
      const identity = manager.getOrCreateIdentity(sessionId);
      expect(identity.framework).toBe('langchain');
    });
  });

  describe('LLM call tracking', () => {
    it('pushes LLM call onto stack', () => {
      const call = manager.pushLlmCall('openai', 'gpt-4o', sessionId);

      expect(call.type).toBe('llm_call');
      expect(call.provider).toBe('openai');
      expect(call.model).toBe('gpt-4o');
      expect(call.status).toBe('pending');
      expect(call.callId).toBeDefined();
    });

    it('tracks call stack depth', () => {
      manager.pushLlmCall('openai', 'gpt-4o', sessionId);
      manager.pushLlmCall('openai', 'gpt-4o', sessionId);

      expect(manager.getCallStackDepth(sessionId)).toBe(2);
    });

    it('completes calls with duration', () => {
      const call = manager.pushLlmCall('openai', 'gpt-4o', sessionId);
      manager.completeCall(call, 'success', 523);

      expect(call.status).toBe('success');
      expect(call.duration).toBe(523);
    });

    it('pops calls from stack', () => {
      const call1 = manager.pushLlmCall('openai', 'gpt-4o', sessionId);
      const call2 = manager.pushLlmCall('openai', 'gpt-4-turbo', sessionId);

      const popped = manager.popCall(sessionId);
      expect(popped?.callId).toBe(call2.callId);
      expect(manager.getCallStackDepth(sessionId)).toBe(1);
    });
  });

  describe('Tool call tracking', () => {
    it('pushes tool call onto stack', () => {
      const call = manager.pushToolCall('get_weather', sessionId);

      expect(call.type).toBe('tool_call');
      expect(call.functionName).toBe('get_weather');
      expect(call.status).toBe('pending');
    });

    it('tracks nested tool calls', () => {
      const llmCall = manager.pushLlmCall('openai', 'gpt-4o', sessionId);
      const toolCall = manager.pushToolCall('fetch_data', sessionId);

      expect(toolCall.parentCallId).toBe(llmCall.callId);
    });
  });

  describe('Call stack hierarchy', () => {
    it('tracks parent-child relationships', () => {
      const llm1 = manager.pushLlmCall('openai', 'gpt-4o', sessionId);
      const tool1 = manager.pushToolCall('search', sessionId);
      const llm2 = manager.pushLlmCall('openai', 'gpt-4o', sessionId);

      expect(tool1.parentCallId).toBe(llm1.callId);
      expect(llm2.parentCallId).toBe(tool1.callId);
    });

    it('identifies parent call', () => {
      const parent = manager.pushLlmCall('openai', 'gpt-4o', sessionId);
      manager.pushToolCall('search', sessionId);

      const retrieved = manager.getParentCall(sessionId);
      expect(retrieved?.callId).toBe(parent.callId);
    });
  });

  describe('Metadata storage', () => {
    it('stores and retrieves metadata', () => {
      manager.setMetadata(sessionId, 'user_tier', 'premium');
      manager.setMetadata(sessionId, 'billing_account', 'acct_123');

      expect(manager.getMetadata(sessionId, 'user_tier')).toBe('premium');
      expect(manager.getMetadata(sessionId, 'billing_account')).toBe('acct_123');
    });

    it('stores complex metadata', () => {
      const metadata = { key: 'value', nested: { count: 42 } };
      manager.setMetadata(sessionId, 'context', metadata);

      expect(manager.getMetadata(sessionId, 'context')).toEqual(metadata);
    });
  });

  describe('Session cleanup', () => {
    it('deletes session', () => {
      manager.getOrCreateIdentity(sessionId, { userId: 'user_123' });
      manager.deleteSession(sessionId);

      const newIdentity = manager.getOrCreateIdentity(sessionId);
      expect(newIdentity.userId).toBeUndefined();
    });
  });

  describe('Identity export', () => {
    it('exports identity context', () => {
      manager.getOrCreateIdentity(sessionId, {
        userId: 'user_123',
        agentId: 'agent_456',
        framework: 'openai',
      });
      manager.pushLlmCall('openai', 'gpt-4o', sessionId);
      manager.setMetadata(sessionId, 'custom', 'data');

      const exported = manager.exportIdentity(sessionId);

      expect(exported.sessionId).toBe(sessionId);
      expect(exported.userId).toBe('user_123');
      expect(exported.agentId).toBe('agent_456');
      expect(exported.framework).toBe('openai');
      expect(exported.callStackDepth).toBe(1);
      expect(exported.metadata.custom).toBe('data');
    });

    it('includes recent calls in export', () => {
      manager.pushLlmCall('openai', 'gpt-4o', sessionId);
      manager.pushLlmCall('openai', 'gpt-4-turbo', sessionId);
      manager.pushToolCall('search', sessionId);

      const exported = manager.exportIdentity(sessionId) as Record<string, unknown>;
      const recentCalls = exported.recentCalls as Array<{ type: string }>;

      expect(recentCalls.length).toBe(3);
      expect(recentCalls[0].type).toBe('llm_call');
    });

    it('exports empty for missing session', () => {
      const exported = manager.exportIdentity('ses_nonexistent');
      expect(Object.keys(exported).length).toBe(0);
    });
  });

  describe('Global instance', () => {
    it('allows getting and setting global manager', () => {
      const customManager = new IdentityManager();
      setIdentityManager(customManager);
      const retrieved = getIdentityManager();

      expect(retrieved).toBe(customManager);
    });
  });

  describe('Error handling', () => {
    it('handles popping from empty stack gracefully', () => {
      const popped = manager.popCall(sessionId);
      expect(popped).toBeUndefined();
    });

    it('handles parent call query on empty stack', () => {
      manager.pushLlmCall('openai', 'gpt-4o', sessionId);
      const parent = manager.getParentCall(sessionId);
      expect(parent).toBeUndefined();
    });
  });

  describe('Real-world scenario', () => {
    it('tracks a realistic multi-agent workflow', () => {
      // Initialize identity for user session
      const identity = manager.getOrCreateIdentity(sessionId, {
        userId: 'user_example',
        agentId: 'research_agent',
        framework: 'langchain',
      });

      // Agent makes an LLM call
      const llm1 = manager.pushLlmCall('openai', 'gpt-4o', sessionId);
      manager.completeCall(llm1, 'success', 250);

      // LLM triggers tool calls
      const search = manager.pushToolCall('web_search', sessionId);
      manager.completeCall(search, 'success', 1500);

      // LLM uses results for another call
      const llm2 = manager.pushLlmCall('openai', 'gpt-4o', sessionId);
      manager.completeCall(llm2, 'success', 180);

      // Export and verify
      const exported = manager.exportIdentity(sessionId) as Record<string, unknown>;
      expect(exported.userId).toBe('user_example');
      expect(exported.agentId).toBe('research_agent');
      expect(exported.framework).toBe('langchain');
      expect(exported.callStackDepth).toBe(3);

      const calls = exported.recentCalls as Array<{ status: string }>;
      expect(calls.every((c) => c.status === 'success')).toBe(true);
    });
  });
});
