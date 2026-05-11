/**
 * Syrin SDK — Structured Logging Interface
 *
 * Creates a logger that routes through a custom logger (pino, winston, bunyan
 * compatible interface) or falls back to console. All log calls include
 * structured meta with { sdk: '@syrin/sdk', version }.
 *
 * In non-debug mode, debug and info calls are suppressed.
 */

import type { SyrinConfig } from '@/types.js';
import { SDK_VERSION } from '@/constants/index.js';

export interface SyrinLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const BASE_META = { sdk: '@syrin/sdk', version: SDK_VERSION };

/**
 * Create a logger that routes to the custom logger provided in `config.logger`
 * or falls back to console. Suppresses debug/info in non-debug mode.
 */
export function createLogger(
  config: Pick<SyrinConfig, 'debug'> & {
    logger?: SyrinConfig['logger'];
  },
): SyrinLogger {
  const custom = config.logger;
  const isDebug = config.debug;

  function _buildMeta(meta?: Record<string, unknown>): Record<string, unknown> {
    return meta ? { ...BASE_META, ...meta } : { ...BASE_META };
  }

  return {
    debug(msg: string, meta?: Record<string, unknown>): void {
      if (!isDebug) return;
      const merged = _buildMeta(meta);
      if (custom?.debug) {
        custom.debug(msg, merged);
      } else {
        // console.debug not always available; use console.log for debug in fallback
        console.debug(msg, merged);
      }
    },

    info(msg: string, meta?: Record<string, unknown>): void {
      if (!isDebug) return;
      const merged = _buildMeta(meta);
      if (custom?.info) {
        custom.info(msg, merged);
      } else {
        console.info(msg, merged);
      }
    },

    warn(msg: string, meta?: Record<string, unknown>): void {
      const merged = _buildMeta(meta);
      if (custom?.warn) {
        custom.warn(msg, merged);
      } else {
        console.warn(msg, merged);
      }
    },

    error(msg: string, meta?: Record<string, unknown>): void {
      const merged = _buildMeta(meta);
      if (custom?.error) {
        custom.error(msg, merged);
      } else {
        console.error(msg, merged);
      }
    },
  };
}
