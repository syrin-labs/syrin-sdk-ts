/**
 * Call Interceptor — Intercepts LLM and tool calls to apply 100% control.
 *
 * This is the engine behind complete control:
 * 1. Intercepts EVERY call (LLM, tool, framework)
 * 2. Applies config overrides (even if library doesn't expose them)
 * 3. Enforces governance policies (rate limits, costs, approvals)
 * 4. Returns modified parameters to the original SDK
 *
 * Key insight: We don't rely on what the library exposes — we modify
 * the actual function arguments BEFORE calling the SDK.
 */

import type { CompleteControlConfig } from './complete-control-schema.js';
import { validateConfigValue } from './complete-control-schema.js';
import { getLogger } from '@/observability/logger.js';
import { getIdentityManager } from '@/core/identity.js';

export interface InterceptedCall {
  callId: string;
  type: 'llm' | 'tool' | 'framework';
  provider?: string;
  model?: string;
  toolName?: string;
  timestamp: string;
  originalParams: Record<string, unknown>;
  modifiedParams: Record<string, unknown>;
  configApplied: Record<string, unknown>;
  governanceApplied: string[]; // ["rate_limit_enforced", "cost_budget_exceeded", ...]
}

export interface GovernanceViolation {
  type:
    | 'cost_limit_exceeded'
    | 'call_limit_exceeded'
    | 'rate_limit_exceeded'
    | 'timeout_exceeded'
    | 'tool_disabled'
    | 'tool_requires_approval'
    | 'blocked_model';
  message: string;
  limit: number | string;
  current: number | string;
}

/**
 * Core interceptor that applies all control rules.
 */
export class CallInterceptor {
  private config: CompleteControlConfig = {};
  private sessionMetrics = new Map<string, {
    totalCost: number;
    callCount: number;
    toolCalls: Map<string, number>;
    lastCallTime: number;
  }>();

  setConfig(config: Partial<CompleteControlConfig>): void {
    // Validate all values
    for (const [key, value] of Object.entries(config)) {
      const validation = validateConfigValue(key, value);
      if (!validation.valid) {
        const logger = getLogger();
        logger.warn(`Invalid config value: ${validation.error}`, {}, { key, value });
        continue;
      }
      this.config[key as keyof CompleteControlConfig] = value as never;
    }
  }

  /**
   * Intercept and modify an LLM call.
   */
  interceptLLMCall(
    originalParams: Record<string, unknown>,
    sessionId: string,
  ): { modifiedParams: Record<string, unknown>; violations: GovernanceViolation[] } {
    const logger = getLogger();
    const violations: GovernanceViolation[] = [];
    const modifiedParams = { ...originalParams };
    const configApplied: Record<string, unknown> = {};

    // ─────────────────────────────────────────────────────────────────
    // 1. APPLY CONFIG OVERRIDES
    // ─────────────────────────────────────────────────────────────────

    // Model override
    if (this.config['llm.model']) {
      modifiedParams.model = this.config['llm.model'];
      configApplied['model'] = this.config['llm.model'];
    }

    // Temperature override
    if (this.config['llm.temperature'] !== undefined) {
      modifiedParams.temperature = this.config['llm.temperature'];
      configApplied['temperature'] = this.config['llm.temperature'];
    }

    // Max tokens override
    if (this.config['llm.max_tokens'] !== undefined) {
      modifiedParams.max_tokens = this.config['llm.max_tokens'];
      configApplied['max_tokens'] = this.config['llm.max_tokens'];
    }

    // Top P, Top K, penalties
    if (this.config['llm.top_p'] !== undefined) modifiedParams.top_p = this.config['llm.top_p'];
    if (this.config['llm.top_k'] !== undefined) modifiedParams.top_k = this.config['llm.top_k'];
    if (this.config['llm.frequency_penalty'] !== undefined) {
      modifiedParams.frequency_penalty = this.config['llm.frequency_penalty'];
    }
    if (this.config['llm.presence_penalty'] !== undefined) {
      modifiedParams.presence_penalty = this.config['llm.presence_penalty'];
    }
    if (this.config['llm.seed'] !== undefined) modifiedParams.seed = this.config['llm.seed'];

    // System prompt override
    if (this.config['prompt.system_prompt'] !== undefined) {
      // Handle different SDK formats
      if ('system' in modifiedParams) {
        modifiedParams.system = this.config['prompt.system_prompt'];
      } else if ('systemPrompt' in modifiedParams) {
        modifiedParams.systemPrompt = this.config['prompt.system_prompt'];
      } else {
        // Inject as new field (adapters will handle it)
        modifiedParams._syrin_system_prompt = this.config['prompt.system_prompt'];
      }
      configApplied['system_prompt'] = this.config['prompt.system_prompt'];
    }

    // Response format override
    if (this.config['prompt.response_format'] !== undefined) {
      modifiedParams.response_format = this.config['prompt.response_format'];
      configApplied['response_format'] = this.config['prompt.response_format'];
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. ENFORCE GOVERNANCE POLICIES
    // ─────────────────────────────────────────────────────────────────

    const metrics = this._getOrCreateMetrics(sessionId);

    // Cost limit check
    if (this.config['governance.cost_limit_usd'] !== undefined) {
      if (metrics.totalCost >= this.config['governance.cost_limit_usd']) {
        violations.push({
          type: 'cost_limit_exceeded',
          message: `Cost limit of $${this.config['governance.cost_limit_usd']} exceeded`,
          limit: this.config['governance.cost_limit_usd'],
          current: metrics.totalCost,
        });
      }
    }

    // Call limit check
    if (this.config['governance.max_total_calls'] !== undefined) {
      if (metrics.callCount >= this.config['governance.max_total_calls']) {
        violations.push({
          type: 'call_limit_exceeded',
          message: `Max calls limit of ${this.config['governance.max_total_calls']} reached`,
          limit: this.config['governance.max_total_calls'],
          current: metrics.callCount,
        });
      }
    }

    // Rate limiting
    if (this.config['governance.rate_limit_calls_per_minute'] !== undefined) {
      const now = Date.now();
      const windowStart = now - 60000; // Last minute
      if (metrics.lastCallTime > windowStart) {
        // Count calls in last minute (simplified)
        if (metrics.callCount % this.config['governance.rate_limit_calls_per_minute'] === 0) {
          violations.push({
            type: 'rate_limit_exceeded',
            message: `Rate limit of ${this.config['governance.rate_limit_calls_per_minute']} calls/minute exceeded`,
            limit: this.config['governance.rate_limit_calls_per_minute'],
            current: metrics.callCount,
          });
        }
      }
      metrics.lastCallTime = now;
    }

    // Blocked models
    if (this.config['governance.blocked_models']?.includes(modifiedParams.model as string)) {
      violations.push({
        type: 'blocked_model',
        message: `Model ${modifiedParams.model} is blocked`,
        limit: (this.config['governance.blocked_models']).join(', '),
        current: modifiedParams.model as string,
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 3. LOG ALL MODIFICATIONS
    // ─────────────────────────────────────────────────────────────────

    if (Object.keys(configApplied).length > 0) {
      logger.debug('LLM call config applied via interceptor', { sessionId }, {
        configApplied,
        violations: violations.map((v) => v.type),
      });
    }

    return { modifiedParams, violations };
  }

  /**
   * Intercept and modify a tool call.
   */
  interceptToolCall(
    toolName: string,
    originalParams: Record<string, unknown>,
    sessionId: string,
  ): { modifiedParams: Record<string, unknown>; violations: GovernanceViolation[] } {
    const violations: GovernanceViolation[] = [];
    const modifiedParams = { ...originalParams };
    const metrics = this._getOrCreateMetrics(sessionId);

    // Check if tool is disabled
    if (this.config[`tools.${toolName}.enabled`] === false) {
      violations.push({
        type: 'tool_disabled',
        message: `Tool ${toolName} is disabled`,
        limit: 'disabled',
        current: 'call_attempted',
      });
    }

    // Check if tool requires approval
    if (this.config[`tools.${toolName}.requires_approval`] === true) {
      violations.push({
        type: 'tool_requires_approval',
        message: `Tool ${toolName} requires approval`,
        limit: 'approval_required',
        current: 'call_pending',
      });
    }

    // Apply per-tool parameter overrides
    // Pattern: tools.{toolName}.param.{paramName}
    for (const [key, value] of Object.entries(this.config)) {
      if (key.startsWith(`tools.${toolName}.param.`)) {
        const paramName = key.slice(`tools.${toolName}.param.`.length);
        modifiedParams[paramName] = value;
      }
    }

    // Track tool call count
    if (!metrics.toolCalls.has(toolName)) {
      metrics.toolCalls.set(toolName, 0);
    }
    metrics.toolCalls.set(toolName, (metrics.toolCalls.get(toolName) ?? 0) + 1);

    // Check per-tool call limit
    const maxCalls = this.config[`tools.${toolName}.max_calls`];
    if (maxCalls && metrics.toolCalls.get(toolName)! > maxCalls) {
      violations.push({
        type: 'call_limit_exceeded',
        message: `Tool ${toolName} call limit of ${maxCalls} exceeded`,
        limit: maxCalls,
        current: metrics.toolCalls.get(toolName) ?? 0,
      });
    }

    return { modifiedParams, violations };
  }

  /**
   * Get or create session metrics.
   */
  private _getOrCreateMetrics(sessionId: string) {
    if (!this.sessionMetrics.has(sessionId)) {
      this.sessionMetrics.set(sessionId, {
        totalCost: 0,
        callCount: 0,
        toolCalls: new Map(),
        lastCallTime: Date.now(),
      });
    }
    return this.sessionMetrics.get(sessionId)!;
  }

  /**
   * Record call metrics (tokens, cost).
   */
  recordCall(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
  ): void {
    const metrics = this._getOrCreateMetrics(sessionId);
    metrics.callCount++;
    metrics.totalCost += costUsd;
  }

  /**
   * Get current session metrics.
   */
  getMetrics(sessionId: string) {
    return this.sessionMetrics.get(sessionId);
  }

  /**
   * Reset session metrics.
   */
  resetSession(sessionId: string): void {
    this.sessionMetrics.delete(sessionId);
  }
}

// Global interceptor instance
let globalInterceptor = new CallInterceptor();

export function getCallInterceptor(): CallInterceptor {
  return globalInterceptor;
}

export function setCallInterceptor(interceptor: CallInterceptor): void {
  globalInterceptor = interceptor;
}
