/**
 * Tests: src/observability/hooks.ts — onConfigChange, onAlert, fireConfigChange, fireAlert, clearHooks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  onConfigChange,
  onAlert,
  fireConfigChange,
  fireAlert,
  clearHooks,
} from '@/observability/hooks';

beforeEach(() => {
  clearHooks();
});

afterEach(() => {
  clearHooks();
  vi.clearAllMocks();
});

describe('onConfigChange / fireConfigChange', () => {
  it('fires registered hook with sessionId and updates', () => {
    const fn = vi.fn();
    onConfigChange(fn);
    fireConfigChange('ses_1', { temperature: 0.3 });
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('ses_1', { temperature: 0.3 });
  });

  it('fires multiple registered hooks', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    onConfigChange(fn1);
    onConfigChange(fn2);
    fireConfigChange('ses_2', { model: 'gpt-4o-mini' });
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('does nothing when no hooks registered', () => {
    expect(() => fireConfigChange('ses_3', { temperature: 0.5 })).not.toThrow();
  });

  it('swallows errors thrown by hooks (fail-open)', () => {
    const badHook = vi.fn().mockImplementation(() => { throw new Error('hook error'); });
    const goodHook = vi.fn();
    onConfigChange(badHook);
    onConfigChange(goodHook);
    expect(() => fireConfigChange('ses_4', {})).not.toThrow();
    expect(badHook).toHaveBeenCalled();
    expect(goodHook).toHaveBeenCalled();
  });

  it('passes all updates correctly', () => {
    const fn = vi.fn();
    onConfigChange(fn);
    const updates = { temperature: 0.7, model: 'gpt-4o', max_tokens: 1000 };
    fireConfigChange('ses_5', updates);
    expect(fn).toHaveBeenCalledWith('ses_5', updates);
  });

  it('can be fired multiple times', () => {
    const fn = vi.fn();
    onConfigChange(fn);
    fireConfigChange('ses_6', { temperature: 0.1 });
    fireConfigChange('ses_6', { temperature: 0.2 });
    fireConfigChange('ses_6', { temperature: 0.3 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('onAlert / fireAlert', () => {
  it('fires registered alert hook with action', () => {
    const fn = vi.fn();
    onAlert(fn);
    const action = { type: 'alert', level: 'warning', message: 'High latency' };
    fireAlert(action);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(action);
  });

  it('fires multiple alert hooks', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    onAlert(fn1);
    onAlert(fn2);
    fireAlert({ level: 'critical', message: 'Cost limit' });
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('does nothing when no alert hooks registered', () => {
    expect(() => fireAlert({ level: 'info', message: 'test' })).not.toThrow();
  });

  it('swallows errors from alert hooks (fail-open)', () => {
    const badFn = vi.fn().mockImplementation(() => { throw new Error('alert hook failure'); });
    const goodFn = vi.fn();
    onAlert(badFn);
    onAlert(goodFn);
    expect(() => fireAlert({ level: 'info' })).not.toThrow();
    expect(badFn).toHaveBeenCalled();
    expect(goodFn).toHaveBeenCalled();
  });

  it('passes all action fields', () => {
    const fn = vi.fn();
    onAlert(fn);
    const action = { type: 'alert', level: 'critical', message: 'alert!', incident_id: 'inc_1' };
    fireAlert(action);
    expect(fn).toHaveBeenCalledWith(action);
  });
});

describe('clearHooks', () => {
  it('removes all config change hooks', () => {
    const fn = vi.fn();
    onConfigChange(fn);
    clearHooks();
    fireConfigChange('ses_7', {});
    expect(fn).not.toHaveBeenCalled();
  });

  it('removes all alert hooks', () => {
    const fn = vi.fn();
    onAlert(fn);
    clearHooks();
    fireAlert({});
    expect(fn).not.toHaveBeenCalled();
  });

  it('can re-register hooks after clear', () => {
    const fn1 = vi.fn();
    onConfigChange(fn1);
    clearHooks();

    const fn2 = vi.fn();
    onConfigChange(fn2);
    fireConfigChange('ses_8', { temperature: 0.5 });
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });
});
