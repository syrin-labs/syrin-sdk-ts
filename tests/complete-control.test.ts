/**
 * Tests for 100% Complete Control — LLM, Framework, and Tool Governance
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CallInterceptor, type GovernanceViolation } from '@/control/call-interceptor.js';
import { ToolGovernance } from '@/control/tool-governance.js';
import type { CompleteControlConfig } from '@/control/complete-control-schema.js';

describe('CallInterceptor — 100% LLM Control', () => {
  let interceptor: CallInterceptor;
  const sessionId = 'ses_test_123';

  beforeEach(() => {
    interceptor = new CallInterceptor();
  });

  describe('LLM Parameter Control', () => {
    it('overrides model', () => {
      interceptor.setConfig({ 'llm.model': 'gpt-4o' });
      const params = { model: 'gpt-3.5-turbo' };
      const { modifiedParams } = interceptor.interceptLLMCall(params, sessionId);
      expect(modifiedParams.model).toBe('gpt-4o');
    });

    it('overrides temperature', () => {
      interceptor.setConfig({ 'llm.temperature': 0.3 });
      const params = { temperature: 0.7 };
      const { modifiedParams } = interceptor.interceptLLMCall(params, sessionId);
      expect(modifiedParams.temperature).toBe(0.3);
    });

    it('overrides max_tokens', () => {
      interceptor.setConfig({ 'llm.max_tokens': 1024 });
      const params = { max_tokens: 2048 };
      const { modifiedParams } = interceptor.interceptLLMCall(params, sessionId);
      expect(modifiedParams.max_tokens).toBe(1024);
    });

    it('overrides system prompt (system field)', () => {
      interceptor.setConfig({ 'prompt.system_prompt': 'You are helpful.' });
      const params = { system: 'You are concise.' };
      const { modifiedParams } = interceptor.interceptLLMCall(params, sessionId);
      expect(modifiedParams.system).toBe('You are helpful.');
    });

    it('overrides system prompt (systemPrompt field)', () => {
      interceptor.setConfig({ 'prompt.system_prompt': 'You are helpful.' });
      const params = { systemPrompt: 'Old prompt' };
      const { modifiedParams } = interceptor.interceptLLMCall(params, sessionId);
      expect(modifiedParams.systemPrompt).toBe('You are helpful.');
    });

    it('overrides all sampling parameters', () => {
      interceptor.setConfig({
        'llm.top_p': 0.9,
        'llm.top_k': 40,
        'llm.frequency_penalty': 0.5,
        'llm.presence_penalty': -0.5,
      });
      const params = {};
      const { modifiedParams } = interceptor.interceptLLMCall(params, sessionId);
      expect(modifiedParams.top_p).toBe(0.9);
      expect(modifiedParams.top_k).toBe(40);
      expect(modifiedParams.frequency_penalty).toBe(0.5);
      expect(modifiedParams.presence_penalty).toBe(-0.5);
    });

    it('preserves original params when no override', () => {
      const params = { model: 'gpt-4o', temperature: 0.7 };
      const { modifiedParams } = interceptor.interceptLLMCall(params, sessionId);
      expect(modifiedParams.model).toBe('gpt-4o');
      expect(modifiedParams.temperature).toBe(0.7);
    });
  });

  describe('Governance Policy Enforcement', () => {
    it('enforces cost limit', () => {
      interceptor.setConfig({
        'governance.cost_limit_usd': 0.50,
      });

      interceptor.recordCall(sessionId, 1000, 500, 0.40); // Cost: $0.40
      const result1 = interceptor.interceptLLMCall({}, sessionId);
      expect(result1.violations).toHaveLength(0);

      interceptor.recordCall(sessionId, 1000, 500, 0.20); // Cost: $0.60 total
      const result2 = interceptor.interceptLLMCall({}, sessionId);
      expect(result2.violations.some((v) => v.type === 'cost_limit_exceeded')).toBe(true);
    });

    it('enforces max total calls', () => {
      interceptor.setConfig({
        'governance.max_total_calls': 3,
      });

      interceptor.recordCall(sessionId, 100, 50, 0.01);
      interceptor.recordCall(sessionId, 100, 50, 0.01);
      interceptor.recordCall(sessionId, 100, 50, 0.01);

      const result = interceptor.interceptLLMCall({}, sessionId);
      expect(result.violations.some((v) => v.type === 'call_limit_exceeded')).toBe(true);
    });

    it('enforces blocked models', () => {
      interceptor.setConfig({
        'governance.blocked_models': ['gpt-3.5-turbo'],
      });

      const params = { model: 'gpt-3.5-turbo' };
      const { violations } = interceptor.interceptLLMCall(params, sessionId);
      expect(violations.some((v) => v.type === 'blocked_model')).toBe(true);
    });
  });

  describe('Tool Call Interception', () => {
    it('applies tool parameter overrides', () => {
      interceptor.setConfig({
        'tools.web_search.param.max_results': 5,
        'tools.web_search.param.timeout_ms': 3000,
      });

      const params = { query: 'test', max_results: 10 };
      const { modifiedParams } = interceptor.interceptToolCall('web_search', params, sessionId);

      expect(modifiedParams.max_results).toBe(5);
      expect(modifiedParams.timeout_ms).toBe(3000);
    });

    it('tracks per-tool call count', () => {
      const params = { query: 'test' };
      interceptor.interceptToolCall('web_search', params, sessionId);
      interceptor.interceptToolCall('web_search', params, sessionId);
      interceptor.interceptToolCall('web_search', params, sessionId);

      const metrics = interceptor.getMetrics(sessionId);
      expect(metrics?.toolCalls.get('web_search')).toBe(3);
    });

    it('enforces per-tool call limits', () => {
      interceptor.setConfig({
        'tools.web_search.max_calls': 2,
      });

      interceptor.interceptToolCall('web_search', {}, sessionId);
      interceptor.interceptToolCall('web_search', {}, sessionId);
      const result = interceptor.interceptToolCall('web_search', {}, sessionId);

      expect(result.violations.some((v) => v.type === 'call_limit_exceeded')).toBe(true);
    });

    it('disables tools', () => {
      interceptor.setConfig({
        'tools.web_search.enabled': false,
      });

      const { violations } = interceptor.interceptToolCall('web_search', {}, sessionId);
      expect(violations.some((v) => v.type === 'tool_disabled')).toBe(true);
    });
  });

  describe('Multiple Violations', () => {
    it('reports multiple violations at once', () => {
      interceptor.setConfig({
        'governance.cost_limit_usd': 0.10,
        'governance.max_total_calls': 2,
        'governance.blocked_models': ['gpt-3.5-turbo'],
      });

      interceptor.recordCall(sessionId, 1000, 500, 0.15);
      interceptor.recordCall(sessionId, 1000, 500, 0.01);

      const { violations } = interceptor.interceptLLMCall({ model: 'gpt-3.5-turbo' }, sessionId);

      const types = violations.map((v) => v.type);
      expect(types).toContain('cost_limit_exceeded');
      expect(types).toContain('call_limit_exceeded');
      expect(types).toContain('blocked_model');
    });
  });
});

describe('ToolGovernance — Tool-Specific Control', () => {
  let governance: ToolGovernance;
  const sessionId = 'ses_test_456';

  beforeEach(() => {
    governance = new ToolGovernance();
  });

  describe('Tool Configuration', () => {
    it('configures tool with governance rules', async () => {
      governance.configureTool('web_search', {
        enabled: true,
        maxCalls: 10,
        costLimitUsd: 1.00,
        requiresApproval: false,
        validateInput: true,
      });

      const result = await governance.canExecuteTool('web_search', {}, sessionId);
      expect(result.allowed).toBe(true);
    });

    it('disables tools', async () => {
      governance.configureTool('delete_data', { enabled: false });
      const result = await governance.canExecuteTool('delete_data', {}, sessionId);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    it('requires approval for dangerous tools', async () => {
      governance.configureTool('delete_data', { requiresApproval: true });
      const result = await governance.canExecuteTool('delete_data', {}, sessionId, {
        userId: 'user_123',
      });
      expect(result.requiresApproval).toBe(true);
    });
  });

  describe('Rate Limiting', () => {
    it('enforces per-tool rate limits', async () => {
      governance.configureTool('web_search', { rateLimitPerMinute: 3 });

      const result1 = await governance.canExecuteTool('web_search', {}, sessionId);
      expect(result1.allowed).toBe(true);

      governance.recordToolCall('web_search', {}, 'result1', 100, 0.01, sessionId);
      governance.recordToolCall('web_search', {}, 'result2', 100, 0.01, sessionId);
      governance.recordToolCall('web_search', {}, 'result3', 100, 0.01, sessionId);

      const result2 = await governance.canExecuteTool('web_search', {}, sessionId);
      expect(result2.allowed).toBe(false);
      expect(result2.reason).toContain('rate limit');
    });
  });

  describe('Cost Control', () => {
    it('enforces per-tool cost limits', async () => {
      governance.configureTool('expensive_api', { costLimitUsd: 0.50 });

      governance.recordToolCall('expensive_api', {}, 'r1', 100, 0.30, sessionId);
      governance.recordToolCall('expensive_api', {}, 'r2', 100, 0.25, sessionId);

      const result = await governance.canExecuteTool('expensive_api', {}, sessionId);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cost limit');
    });
  });

  describe('Call Recording', () => {
    it('records tool calls with metrics', () => {
      const call = governance.recordToolCall('web_search', { query: 'test' }, ['result1'], 523, 0.02, sessionId);

      expect(call.toolName).toBe('web_search');
      expect(call.durationMs).toBe(523);
      expect(call.costUsd).toBe(0.02);
      expect(call.status).toBe('completed');
    });

    it('tracks call history', () => {
      governance.recordToolCall('web_search', {}, 'r1', 100, 0.01, sessionId);
      governance.recordToolCall('web_search', {}, 'r2', 100, 0.01, sessionId);
      governance.recordToolCall('calculator', {}, '42', 50, 0.001, sessionId);

      const history = governance.getCallHistory(sessionId);
      expect(history).toHaveLength(3);

      const searchCalls = governance.getCallHistory(sessionId, 'web_search');
      expect(searchCalls).toHaveLength(2);
    });
  });

  describe('Approval Workflow', () => {
    it('creates approval request for dangerous tools', async () => {
      governance.configureTool('delete_data', { requiresApproval: true });
      const result = await governance.canExecuteTool('delete_data', { id: '123' }, sessionId, {
        userId: 'user_alice',
      });

      expect(result.requiresApproval).toBe(true);
      const approvals = governance.getPendingApprovals('delete_data');
      expect(approvals.length).toBeGreaterThan(0);
    });

    it('approves tool calls', async () => {
      governance.configureTool('delete_data', { requiresApproval: true });
      await governance.canExecuteTool('delete_data', {}, sessionId);

      const approvals = governance.getPendingApprovals('delete_data');
      const approval = approvals[0];

      const approved = governance.approveTool(approval.approvalId, 'admin_bob');
      expect(approved).toBe(true);
    });
  });

  describe('Input Validation', () => {
    it('validates tool arguments when configured', () => {
      governance.configureTool('calculator', { validateInput: true });
      const result = governance.validateToolArgs('calculator', { x: 1, y: 2 });
      expect(result.valid).toBe(true);
    });

    it('detects null/undefined arguments', () => {
      governance.configureTool('search', { validateInput: true });
      const result = governance.validateToolArgs('search', { query: null });
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.[0]).toContain('null');
    });
  });

  describe('Session Management', () => {
    it('tracks metrics per session', () => {
      governance.recordToolCall('web_search', {}, 'r1', 100, 0.01, 'ses_1');
      governance.recordToolCall('web_search', {}, 'r2', 100, 0.02, 'ses_2');

      const metrics1 = governance.getMetrics('ses_1');
      const metrics2 = governance.getMetrics('ses_2');

      expect(metrics1?.totalCost).toBe(0.01);
      expect(metrics2?.totalCost).toBe(0.02);
    });

    it('resets session', () => {
      governance.recordToolCall('web_search', {}, 'r1', 100, 0.01, sessionId);
      governance.resetSession(sessionId);

      const metrics = governance.getMetrics(sessionId);
      expect(metrics).toBeUndefined();

      const history = governance.getCallHistory(sessionId);
      expect(history).toHaveLength(0);
    });
  });
});

describe('Integration — Complete Control', () => {
  it('applies all controls together', () => {
    const interceptor = new CallInterceptor();
    const governance = new ToolGovernance();
    const sessionId = 'ses_integration';

    // Configure complete control
    interceptor.setConfig({
      // LLM config
      'llm.model': 'gpt-4o',
      'llm.temperature': 0.3,
      'llm.max_tokens': 1024,
      'prompt.system_prompt': 'You are helpful.',
      // Governance
      'governance.cost_limit_usd': 1.00,
      'governance.max_total_calls': 10,
      // Tool overrides
      'tools.web_search.param.max_results': 5,
      'tools.web_search.enabled': true,
    });

    governance.configureTool('web_search', {
      enabled: true,
      maxCalls: 5,
      rateLimitPerMinute: 3,
    });

    // Intercept LLM call
    const llmCall = { model: 'gpt-3.5-turbo', temperature: 0.7 };
    const { modifiedParams: llmModified } = interceptor.interceptLLMCall(llmCall, sessionId);

    expect(llmModified.model).toBe('gpt-4o');
    expect(llmModified.temperature).toBe(0.3);

    // Intercept tool call
    const toolCall = { query: 'test', max_results: 10 };
    const { modifiedParams: toolModified } = interceptor.interceptToolCall('web_search', toolCall, sessionId);

    expect(toolModified.max_results).toBe(5);
  });
});
