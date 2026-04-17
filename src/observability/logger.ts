/**
 * Syrin SDK Logger — comprehensive logging with identity context, config tracking, and event tracing.
 *
 * Features:
 * - Structured logging with context (session_id, agent_id, user_id, framework)
 * - Log levels (debug, info, warn, error)
 * - Config change tracking
 * - Event tracing with timing
 * - Performance metrics
 */

import { estimateCost } from '../utils/helpers.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  sessionId?: string;
  agentId?: string;
  userId?: string;
  framework?: string;
  runId?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: LogContext;
  data?: Record<string, unknown>;
  duration?: number; // ms
  error?: {
    message: string;
    stack?: string;
  };
}

type LogHandler = (entry: LogEntry) => void;

/**
 * Logger with context awareness. Maintains session, agent, and user context
 * throughout the call lifecycle.
 */
export class SyrinLogger {
  private handlers: LogHandler[] = [];
  private logLevel: LogLevel = 'info';
  private globalContext: LogContext = {};

  constructor(logLevel?: LogLevel) {
    if (logLevel) this.logLevel = logLevel;
    // Default: log to console in debug mode, suppress in production
    if (typeof process !== 'undefined' && process.env?.['DEBUG']) {
      this.addHandler((entry) => {
        const prefix = `[Syrin][${entry.level.toUpperCase()}]`;
        const context = this._formatContext(entry.context);
        const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
        console.log(`${prefix}${context} ${entry.message}${data}`);
        if (entry.error?.stack) console.log(entry.error.stack);
      });
    }
  }

  addHandler(handler: LogHandler): void {
    this.handlers.push(handler);
  }

  setGlobalContext(context: Partial<LogContext>): void {
    this.globalContext = { ...this.globalContext, ...context };
  }

  private _shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }

  private _formatContext(ctx: LogContext): string {
    const parts: string[] = [];
    if (ctx.sessionId) parts.push(`session=${ctx.sessionId}`);
    if (ctx.agentId) parts.push(`agent=${ctx.agentId}`);
    if (ctx.userId) parts.push(`user=${ctx.userId}`);
    if (ctx.framework) parts.push(`fw=${ctx.framework}`);
    if (ctx.runId) parts.push(`run=${ctx.runId}`);
    return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
  }

  private _emit(entry: LogEntry): void {
    for (const handler of this.handlers) {
      try {
        handler(entry);
      } catch (err) {
        // Prevent logging errors from crashing SDK
        if (typeof console !== 'undefined') {
          console.error('[Syrin] Logger handler failed:', err);
        }
      }
    }
  }

  debug(message: string, context?: Partial<LogContext>, data?: Record<string, unknown>): void {
    if (!this._shouldLog('debug')) return;
    this._emit({
      timestamp: new Date().toISOString(),
      level: 'debug',
      message,
      context: { ...this.globalContext, ...context },
      data,
    });
  }

  info(message: string, context?: Partial<LogContext>, data?: Record<string, unknown>): void {
    if (!this._shouldLog('info')) return;
    this._emit({
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      context: { ...this.globalContext, ...context },
      data,
    });
  }

  warn(message: string, context?: Partial<LogContext>, data?: Record<string, unknown>): void {
    if (!this._shouldLog('warn')) return;
    this._emit({
      timestamp: new Date().toISOString(),
      level: 'warn',
      message,
      context: { ...this.globalContext, ...context },
      data,
    });
  }

  error(message: string, error?: Error, context?: Partial<LogContext>, data?: Record<string, unknown>): void {
    if (!this._shouldLog('error')) return;
    this._emit({
      timestamp: new Date().toISOString(),
      level: 'error',
      message,
      context: { ...this.globalContext, ...context },
      data,
      error: error ? { message: error.message, stack: error.stack } : undefined,
    });
  }

  /**
   * Log a config override with before/after values.
   */
  logConfigOverride(
    path: string,
    from: unknown,
    to: unknown,
    context?: Partial<LogContext>,
  ): void {
    this.info('Config override applied', context, {
      path,
      from,
      to,
    });
  }

  /**
   * Log the start of an LLM call with request details.
   */
  logLlmCallStart(
    provider: string,
    model: string,
    context?: Partial<LogContext>,
    details?: Record<string, unknown>,
  ): void {
    this.debug(`LLM call starting (${provider}/${model})`, context, {
      ...details,
    });
  }

  /**
   * Log the completion of an LLM call with metrics.
   */
  logLlmCallEnd(
    provider: string,
    model: string,
    durationMs: number,
    inputTokens: number,
    outputTokens: number,
    context?: Partial<LogContext>,
    details?: Record<string, unknown>,
  ): void {
    const costUsd = estimateCost(model, inputTokens, outputTokens);
    this.debug(`LLM call completed in ${durationMs}ms`, context, {
      provider,
      model,
      durationMs,
      inputTokens,
      outputTokens,
      costUsd: costUsd.toFixed(4),
      ...details,
    });
  }

  /**
   * Log an LLM call failure.
   */
  logLlmCallError(
    provider: string,
    model: string,
    error: Error,
    durationMs: number,
    context?: Partial<LogContext>,
  ): void {
    this.error(`LLM call failed after ${durationMs}ms (${provider}/${model})`, error, context, {
      provider,
      model,
      durationMs,
    });
  }

  /**
   * Log adapter lifecycle event.
   */
  logAdapterEvent(
    adapter: string,
    event: 'install' | 'uninstall' | 'config_apply' | 'error',
    context?: Partial<LogContext>,
    details?: Record<string, unknown>,
  ): void {
    this.info(`Adapter [${adapter}] ${event}`, context, details);
  }

  /**
   * Log governance decision.
   */
  logGovernanceAction(
    action: string,
    reason: string,
    context?: Partial<LogContext>,
    details?: Record<string, unknown>,
  ): void {
    const level = action === 'STOP' || action === 'ALERT' ? 'warn' : 'info';
    const fn = level === 'warn' ? this.warn.bind(this) : this.info.bind(this);
    fn(`Governance action: ${action} (${reason})`, context, details);
  }

}

// Global logger instance
let globalLogger = new SyrinLogger();

export function getLogger(): SyrinLogger {
  return globalLogger;
}

export function setLogger(logger: SyrinLogger): void {
  globalLogger = logger;
}
