/**
 * Tests for SyrinLogger — structured logging with identity context.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SyrinLogger, getLogger, setLogger, type LogEntry, type LogLevel } from '@/observability/logger.js';

describe('SyrinLogger', () => {
  let logger: SyrinLogger;
  let captured: LogEntry[] = [];

  beforeEach(() => {
    logger = new SyrinLogger('debug');
    captured = [];
    logger.addHandler((entry) => captured.push(entry));
  });

  describe('Basic logging', () => {
    it('logs debug messages', () => {
      logger.debug('Test debug', { sessionId: 'ses_123' });
      expect(captured).toHaveLength(1);
      expect(captured[0].level).toBe('debug');
      expect(captured[0].message).toBe('Test debug');
      expect(captured[0].context.sessionId).toBe('ses_123');
    });

    it('logs info messages', () => {
      logger.info('Test info', { agentId: 'agent_456' });
      expect(captured).toHaveLength(1);
      expect(captured[0].level).toBe('info');
    });

    it('logs warn messages', () => {
      logger.warn('Test warning', { userId: 'user_789' });
      expect(captured).toHaveLength(1);
      expect(captured[0].level).toBe('warn');
    });

    it('logs error messages with stack trace', () => {
      const err = new Error('Test error');
      logger.error('An error occurred', err);
      expect(captured).toHaveLength(1);
      expect(captured[0].level).toBe('error');
      expect(captured[0].error?.message).toBe('Test error');
      expect(captured[0].error?.stack).toBeDefined();
    });
  });

  describe('Context tracking', () => {
    it('preserves global context across calls', () => {
      logger.setGlobalContext({ sessionId: 'ses_global', userId: 'user_global' });
      logger.info('Message 1');
      logger.warn('Message 2', { agentId: 'agent_123' });

      expect(captured[0].context.sessionId).toBe('ses_global');
      expect(captured[0].context.userId).toBe('user_global');

      expect(captured[1].context.sessionId).toBe('ses_global');
      expect(captured[1].context.userId).toBe('user_global');
      expect(captured[1].context.agentId).toBe('agent_123');
    });

    it('call context overrides global context', () => {
      logger.setGlobalContext({ sessionId: 'ses_global' });
      logger.info('Message', { sessionId: 'ses_override' });

      expect(captured[0].context.sessionId).toBe('ses_override');
    });

    it('includes all identity fields in context', () => {
      const context = {
        sessionId: 'ses_123',
        agentId: 'agent_456',
        userId: 'user_789',
        framework: 'openai',
        runId: 'run_abc',
      };
      logger.info('Full context', context);

      expect(captured[0].context).toMatchObject(context);
    });
  });

  describe('Structured data', () => {
    it('attaches data objects to log entries', () => {
      logger.info('With data', undefined, {
        model: 'gpt-4o',
        tokens: 1500,
        cost: 0.05,
      });

      expect(captured[0].data).toEqual({
        model: 'gpt-4o',
        tokens: 1500,
        cost: 0.05,
      });
    });

    it('includes timing in LLM call logs', () => {
      logger.logLlmCallEnd('openai', 'gpt-4o', 1234, 100, 50);
      expect(captured[0].data?.durationMs).toBe(1234);
      expect(captured[0].data?.inputTokens).toBe(100);
      expect(captured[0].data?.outputTokens).toBe(50);
      expect(typeof captured[0].data?.costUsd).toBe('string');
    });
  });

  describe('Log levels', () => {
    it('respects log level filtering', () => {
      const infoLogger = new SyrinLogger('info');
      const entries: LogEntry[] = [];
      infoLogger.addHandler((e) => entries.push(e));

      infoLogger.debug('Debug');
      infoLogger.info('Info');
      infoLogger.warn('Warn');
      infoLogger.error('Error');

      expect(entries).toHaveLength(3); // debug filtered out
      expect(entries.map((e) => e.level)).toEqual(['info', 'warn', 'error']);
    });
  });

  describe('Config override logging', () => {
    it('logs config changes with before/after values', () => {
      logger.logConfigOverride('llm.temperature', 0.7, 0.3, { sessionId: 'ses_123' });
      expect(captured[0].message).toContain('Config override');
      expect(captured[0].data?.path).toBe('llm.temperature');
      expect(captured[0].data?.from).toBe(0.7);
      expect(captured[0].data?.to).toBe(0.3);
    });
  });

  describe('LLM call logging', () => {
    it('logs LLM call start', () => {
      logger.logLlmCallStart('openai', 'gpt-4o', { sessionId: 'ses_123' }, { temperature: 0.7 });
      expect(captured[0].level).toBe('debug');
      expect(captured[0].message).toContain('LLM call starting');
      expect(captured[0].data?.temperature).toBe(0.7);
    });

    it('logs LLM call completion with metrics', () => {
      logger.logLlmCallEnd('openai', 'gpt-4o', 523, 150, 200, { sessionId: 'ses_123' });
      expect(captured[0].level).toBe('debug');
      expect(captured[0].message).toContain('523ms');
      expect(captured[0].data?.inputTokens).toBe(150);
      expect(captured[0].data?.outputTokens).toBe(200);
    });

    it('logs LLM call errors', () => {
      const error = new Error('API rate limited');
      logger.logLlmCallError('openai', 'gpt-4o', error, 100, { sessionId: 'ses_123' });
      expect(captured[0].level).toBe('error');
      expect(captured[0].message).toContain('LLM call failed');
      expect(captured[0].error?.message).toBe('API rate limited');
    });

    it('estimates cost accurately', () => {
      logger.logLlmCallEnd('gpt-4o', 'gpt-4o', 100, 1000, 500);
      const cost = captured[0].data?.costUsd;
      // gpt-4o: input=$2.5/1M, output=$10.0/1M (from helpers.ts canonical pricing)
      // (1000 * 2.5 + 500 * 10.0) / 1_000_000 = 0.0075
      expect(cost).toBe('0.0075');
    });
  });

  describe('Governance logging', () => {
    it('logs governance actions', () => {
      logger.logGovernanceAction('STOP', 'Loop detected', { sessionId: 'ses_123' });
      expect(captured[0].level).toBe('warn');
      expect(captured[0].message).toContain('Governance action: STOP');
      expect(captured[0].message).toContain('Loop detected');
    });

    it('logs governance alerts', () => {
      logger.logGovernanceAction('ALERT', 'High cost', { sessionId: 'ses_123' }, { cost_usd: 0.50 });
      expect(captured[0].level).toBe('warn');
      expect(captured[0].data?.cost_usd).toBe(0.50);
    });
  });

  describe('Adapter lifecycle logging', () => {
    it('logs adapter install', () => {
      logger.logAdapterEvent('openai', 'install', { framework: 'openai' });
      expect(captured[0].level).toBe('info');
      expect(captured[0].message).toContain('openai');
      expect(captured[0].message).toContain('install');
    });

    it('logs adapter config application', () => {
      logger.logAdapterEvent('anthropic', 'config_apply', { sessionId: 'ses_123' }, {
        path: 'llm.temperature',
        value: 0.5,
      });
      expect(captured[0].message).toContain('anthropic');
      expect(captured[0].message).toContain('config_apply');
      expect(captured[0].data?.path).toBe('llm.temperature');
    });
  });

  describe('Error handling', () => {
    it('does not crash when handler throws', () => {
      const badHandler = () => {
        throw new Error('Handler failed');
      };
      logger.addHandler(badHandler);
      // Should not throw
      expect(() => logger.info('Test')).not.toThrow();
    });
  });

  describe('Global logger instance', () => {
    it('allows setting a custom logger', () => {
      const customLogger = new SyrinLogger('info');
      const customEntries: LogEntry[] = [];
      customLogger.addHandler((e) => customEntries.push(e));

      setLogger(customLogger);
      const retrieved = getLogger();
      retrieved.info('Test message');

      expect(customEntries).toHaveLength(1);
      expect(customEntries[0].message).toBe('Test message');
    });
  });

  describe('Timestamp accuracy', () => {
    it('includes ISO timestamp', () => {
      logger.info('Test');
      const timestamp = captured[0].timestamp;
      // Check it's a valid ISO 8601 string
      expect(() => new Date(timestamp)).not.toThrow();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
