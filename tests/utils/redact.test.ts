/**
 * Tests for PII redaction framework (P2-5)
 */

import { describe, it, expect } from 'vitest';
import { redactContent } from '@/utils/redact.js';

describe('redactContent', () => {
  // ── autoRedactPii: email ──────────────────────────────────────────────────

  it('replaces email addresses with [EMAIL] when autoRedactPii=true', () => {
    const result = redactContent('Contact us at support@example.com for help.', { autoRedactPii: true });
    expect(result).toBe('Contact us at [EMAIL] for help.');
  });

  it('replaces multiple email addresses in a string', () => {
    const result = redactContent('From alice@foo.com to bob@bar.org', { autoRedactPii: true });
    expect(result).toBe('From [EMAIL] to [EMAIL]');
  });

  // ── autoRedactPii: phone ──────────────────────────────────────────────────

  it('replaces US phone numbers with [PHONE] when autoRedactPii=true', () => {
    const result = redactContent('Call me at (555) 123-4567 anytime.', { autoRedactPii: true });
    expect(result).toBe('Call me at [PHONE] anytime.');
  });

  it('replaces dashed phone format with [PHONE]', () => {
    const result = redactContent('Phone: 555-123-4567', { autoRedactPii: true });
    expect(result).toBe('Phone: [PHONE]');
  });

  it('replaces dotted phone format with [PHONE]', () => {
    const result = redactContent('Phone: 555.123.4567', { autoRedactPii: true });
    expect(result).toBe('Phone: [PHONE]');
  });

  // ── autoRedactPii: credit card ────────────────────────────────────────────

  it('replaces credit card numbers with [CARD] when autoRedactPii=true', () => {
    const result = redactContent('Card: 4111 1111 1111 1111', { autoRedactPii: true });
    expect(result).toBe('Card: [CARD]');
  });

  it('replaces credit card with dashes with [CARD]', () => {
    const result = redactContent('Card: 4111-1111-1111-1111', { autoRedactPii: true });
    expect(result).toBe('Card: [CARD]');
  });

  it('replaces unspaced credit card numbers with [CARD]', () => {
    const result = redactContent('cc=4111111111111111', { autoRedactPii: true });
    expect(result).toBe('cc=[CARD]');
  });

  // ── redactPatterns ────────────────────────────────────────────────────────

  it('replaces custom regex pattern matches with [REDACTED]', () => {
    const result = redactContent('token: sk-abc123secret', {
      redactPatterns: [/sk-[a-z0-9]+/gi],
    });
    expect(result).toBe('token: [REDACTED]');
  });

  it('replaces multiple custom regex pattern matches in one string', () => {
    const result = redactContent('keys: sk-abc123 and sk-def456', {
      redactPatterns: [/sk-[a-z0-9]+/gi],
    });
    expect(result).toBe('keys: [REDACTED] and [REDACTED]');
  });

  // ── redactFields: flat ────────────────────────────────────────────────────

  it('redacts a top-level field by name', () => {
    const input = { username: 'alice', password: 'secret' };
    const result = redactContent(input, { redactFields: ['password'] });
    expect(result).toEqual({ username: 'alice', password: '[REDACTED]' });
  });

  it('redacts multiple top-level fields', () => {
    const input = { username: 'alice', password: 'secret', token: 'abc123' };
    const result = redactContent(input, { redactFields: ['password', 'token'] });
    expect(result).toEqual({ username: 'alice', password: '[REDACTED]', token: '[REDACTED]' });
  });

  // ── redactFields: nested ──────────────────────────────────────────────────

  it('redacts a nested field using dot notation', () => {
    const input = { user: { ssn: '123-45-6789', name: 'Alice' } };
    const result = redactContent(input, { redactFields: ['user.ssn'] });
    expect(result).toEqual({ user: { ssn: '[REDACTED]', name: 'Alice' } });
  });

  it('redacts deeply nested field', () => {
    const input = { a: { b: { c: 'sensitive', d: 'keep' } } };
    const result = redactContent(input, { redactFields: ['a.b.c'] });
    expect(result).toEqual({ a: { b: { c: '[REDACTED]', d: 'keep' } } });
  });

  // ── redactFields: arrays ──────────────────────────────────────────────────

  it('redacts content field in all array items using messages[].content notation', () => {
    const input = {
      messages: [
        { role: 'user', content: 'Hello, my SSN is 123-45-6789' },
        { role: 'assistant', content: 'I cannot help with that' },
      ],
    };
    const result = redactContent(input, { redactFields: ['messages[].content'] }) as typeof input;
    expect(result.messages[0].content).toBe('[REDACTED]');
    expect(result.messages[1].content).toBe('[REDACTED]');
    // Other fields preserved
    expect(result.messages[0].role).toBe('user');
  });

  it('redacts nested field in array items', () => {
    const input = {
      tool_calls: [
        { id: '1', name: 'search', arguments: { password: 'secret', query: 'hello' } },
        { id: '2', name: 'fetch',  arguments: { password: 'topsecret', url: 'https://...' } },
      ],
    };
    const result = redactContent(input, { redactFields: ['tool_calls[].arguments.password'] }) as typeof input;
    expect(result.tool_calls[0].arguments.password).toBe('[REDACTED]');
    expect(result.tool_calls[1].arguments.password).toBe('[REDACTED]');
    // Other fields preserved
    expect(result.tool_calls[0].arguments.query).toBe('hello');
  });

  // ── disabled / no config ──────────────────────────────────────────────────

  it('returns input unchanged when no redact config options are set', () => {
    const input = { email: 'test@example.com', data: 'normal' };
    const result = redactContent(input, {});
    expect(result).toEqual(input);
  });

  it('returns a string unchanged when no redact config options are set', () => {
    const result = redactContent('hello world', {});
    expect(result).toBe('hello world');
  });

  it('returns null and undefined unchanged', () => {
    expect(redactContent(null, { autoRedactPii: true })).toBeNull();
    expect(redactContent(undefined, { autoRedactPii: true })).toBeUndefined();
  });

  // ── immutability ──────────────────────────────────────────────────────────

  it('does NOT mutate the original object', () => {
    const input = { username: 'alice', password: 'secret' };
    const inputCopy = { ...input };
    redactContent(input, { redactFields: ['password'] });
    expect(input).toEqual(inputCopy);
  });

  it('does NOT mutate original nested object', () => {
    const input = { user: { ssn: '123-45-6789' } };
    const originalSsn = input.user.ssn;
    redactContent(input, { redactFields: ['user.ssn'] });
    expect(input.user.ssn).toBe(originalSsn);
  });

  it('does NOT mutate original array', () => {
    const input = { messages: [{ role: 'user', content: 'hi' }] };
    const originalContent = input.messages[0].content;
    redactContent(input, { redactFields: ['messages[].content'] });
    expect(input.messages[0].content).toBe(originalContent);
  });

  // ── recursive on nested objects ───────────────────────────────────────────

  it('applies autoRedactPii recursively to nested string values', () => {
    const input = { user: { bio: 'email me at foo@bar.com' } };
    const result = redactContent(input, { autoRedactPii: true }) as typeof input;
    expect(result.user.bio).toBe('email me at [EMAIL]');
  });

  it('applies autoRedactPii to strings inside arrays', () => {
    const input = ['contact@example.com', 'normal text'];
    const result = redactContent(input, { autoRedactPii: true }) as string[];
    expect(result[0]).toBe('[EMAIL]');
    expect(result[1]).toBe('normal text');
  });

  // ── combined config ───────────────────────────────────────────────────────

  it('applies both autoRedactPii and redactFields together', () => {
    const input = { email: 'test@example.com', password: 'secret' };
    const result = redactContent(input, {
      autoRedactPii: true,
      redactFields: ['password'],
    }) as typeof input;
    expect(result.email).toBe('[EMAIL]');
    expect(result.password).toBe('[REDACTED]');
  });
});
