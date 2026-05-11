/**
 * Tests for structured logging interface (P2-6)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '@/utils/logger.js';

describe('createLogger', () => {
  // ── no custom logger — fallback to console ────────────────────────────────

  it('uses console.warn for warn when no custom logger is provided', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger({ debug: false });
    logger.warn('test warning');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('uses console.error for error when no custom logger is provided', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger({ debug: false });
    logger.error('test error');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  // ── custom logger routing ─────────────────────────────────────────────────

  it('routes warn to custom logger, NOT console, when custom logger is provided', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const customWarn = vi.fn();
    const logger = createLogger({
      debug: false,
      logger: { warn: customWarn },
    });
    logger.warn('custom warning');
    expect(customWarn).toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('routes error to custom logger, NOT console, when custom logger is provided', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const customError = vi.fn();
    const logger = createLogger({
      debug: false,
      logger: { error: customError },
    });
    logger.error('custom error');
    expect(customError).toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('routes info to custom logger when provided', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const customInfo = vi.fn();
    const logger = createLogger({
      debug: true,
      logger: { info: customInfo },
    });
    logger.info('custom info');
    expect(customInfo).toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  // ── structured meta ───────────────────────────────────────────────────────

  it('passes structured meta with sdk key to custom logger', () => {
    const customWarn = vi.fn();
    const logger = createLogger({
      debug: false,
      logger: { warn: customWarn },
    });
    logger.warn('test message', { extra: 'value' });
    expect(customWarn).toHaveBeenCalledWith(
      'test message',
      expect.objectContaining({ sdk: '@syrin/sdk' }),
    );
  });

  it('includes sdk meta even when no extra meta is passed', () => {
    const customWarn = vi.fn();
    const logger = createLogger({
      debug: false,
      logger: { warn: customWarn },
    });
    logger.warn('plain message');
    expect(customWarn).toHaveBeenCalledWith(
      'plain message',
      expect.objectContaining({ sdk: '@syrin/sdk' }),
    );
  });

  it('merges caller meta with sdk meta', () => {
    const customError = vi.fn();
    const logger = createLogger({
      debug: false,
      logger: { error: customError },
    });
    logger.error('error occurred', { code: 500, url: '/api/v1/ingest' });
    const callArgs = customError.mock.calls[0];
    expect(callArgs[1]).toMatchObject({ sdk: '@syrin/sdk', code: 500, url: '/api/v1/ingest' });
  });

  // ── debug mode suppression ────────────────────────────────────────────────

  it('suppresses debug calls in non-debug mode', () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const customDebug = vi.fn();
    const logger = createLogger({
      debug: false,
      logger: { debug: customDebug },
    });
    logger.debug('debug message');
    expect(customDebug).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('suppresses info calls in non-debug mode', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const customInfo = vi.fn();
    const logger = createLogger({
      debug: false,
      logger: { info: customInfo },
    });
    logger.info('info message');
    expect(customInfo).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('allows debug calls when debug mode is enabled', () => {
    const customDebug = vi.fn();
    const logger = createLogger({
      debug: true,
      logger: { debug: customDebug },
    });
    logger.debug('debug message');
    expect(customDebug).toHaveBeenCalled();
  });

  it('allows info calls when debug mode is enabled', () => {
    const customInfo = vi.fn();
    const logger = createLogger({
      debug: true,
      logger: { info: customInfo },
    });
    logger.info('info message');
    expect(customInfo).toHaveBeenCalled();
  });

  it('always passes warn and error through regardless of debug mode', () => {
    const customWarn = vi.fn();
    const customError = vi.fn();
    const logger = createLogger({
      debug: false,
      logger: { warn: customWarn, error: customError },
    });
    logger.warn('warning');
    logger.error('error');
    expect(customWarn).toHaveBeenCalledTimes(1);
    expect(customError).toHaveBeenCalledTimes(1);
  });

  // ── fallback when custom logger lacks a method ────────────────────────────

  it('falls back to console when custom logger does not define a method', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Custom logger only has error, not warn
    const logger = createLogger({
      debug: false,
      logger: { error: vi.fn() },
    });
    logger.warn('fallback warn');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
