/**
 * Complete Control Schema — 100% LLM, Framework, and Tool Control
 *
 * This schema defines EVERY parameter that can be controlled across all frameworks.
 * It serves as the single source of truth for what's configurable.
 *
 * Structure:
 *   llm.*              — LLM generation parameters (all models)
 *   prompt.*           — Prompt engineering
 *   framework.*        — Framework-specific behaviors
 *   governance.*       — Policy enforcement (rate limits, costs, approvals)
 *   tools.*            — Per-tool and global tool governance
 */

export interface CompleteControlConfig {
  // ───────────────────────────────────────────────────────────────────
  // LLM Parameters — 100% Coverage
  // ───────────────────────────────────────────────────────────────────
  'llm.model'?: string; // 'gpt-4o', 'claude-3-opus', etc.
  'llm.temperature'?: number; // 0.0 - 2.0 (creativity)
  'llm.max_tokens'?: number; // Response length limit
  'llm.top_p'?: number; // 0.0 - 1.0 (nucleus sampling)
  'llm.top_k'?: number; // Top-k filtering
  'llm.frequency_penalty'?: number; // -2.0 - 2.0 (repeat penalty)
  'llm.presence_penalty'?: number; // -2.0 - 2.0 (diversity)
  'llm.seed'?: number; // Reproducibility
  'llm.min_tokens'?: number; // Minimum response length
  'llm.repetition_penalty'?: number; // Additional repeat control
  'llm.length_penalty'?: number; // Penalize long/short responses
  'llm.diversity_penalty'?: number; // Encourage diverse tokens

  // ───────────────────────────────────────────────────────────────────
  // Prompt Parameters
  // ───────────────────────────────────────────────────────────────────
  'prompt.system_prompt'?: string; // System instruction (multiline)
  'prompt.preamble'?: string; // Prefix before messages
  'prompt.postamble'?: string; // Suffix after messages
  'prompt.instruction_override'?: string; // Override model instructions
  'prompt.response_format'?: 'text' | 'json' | 'xml'; // Output format
  'prompt.stop_sequences'?: string[]; // Stop generation at these strings

  // ───────────────────────────────────────────────────────────────────
  // Framework-Specific Settings (LangGraph, Vercel, Mastra, etc.)
  // ───────────────────────────────────────────────────────────────────

  // LangGraph (JS & Python)
  'framework.langgraph.max_iterations'?: number; // Max loop iterations
  'framework.langgraph.recursion_limit'?: number; // Recursion depth
  'framework.langgraph.timeout_ms'?: number; // Call timeout
  'framework.langgraph.interrupt_before'?: string[]; // Pause before nodes
  'framework.langgraph.interrupt_after'?: string[]; // Pause after nodes
  'framework.langgraph.debug_mode'?: boolean; // Verbose output

  // Vercel AI SDK
  'framework.vercel.max_steps'?: number; // Max agentic rounds (tool calling)
  'framework.vercel.max_retries'?: number; // Retry failed calls
  'framework.vercel.abort_after_ms'?: number; // Timeout in ms
  'framework.vercel.structured_output'?: boolean; // Use Zod schema
  'framework.vercel.disable_stream'?: boolean; // Force non-streaming

  // Mastra
  'framework.mastra.max_tool_calls'?: number; // Max tools per call
  'framework.mastra.timeout_ms'?: number; // Execution timeout
  'framework.mastra.retry_policy'?: 'exponential' | 'linear' | 'none';
  'framework.mastra.enable_tracing'?: boolean;

  // LangChain (JS & Python)
  'framework.langchain.memory_buffer'?: number; // Chat history length
  'framework.langchain.verbose'?: boolean; // Debug output
  'framework.langchain.callbacks_enabled'?: boolean; // Emit events
  'framework.langchain.streaming_enabled'?: boolean; // Stream responses
  'framework.langchain.return_intermediate_steps'?: boolean; // Debug info

  // CrewAI (Python)
  'framework.crewai.max_iterations'?: number; // Crew loop iterations
  'framework.crewai.timeout_ms'?: number; // Agent timeout
  'framework.crewai.memory_enabled'?: boolean; // Crew memory
  'framework.crewai.share_crew_state'?: boolean; // Share context

  // Pydantic AI (Python)
  'framework.pydantic_ai.max_retries'?: number; // Call retries
  'framework.pydantic_ai.timeout_ms'?: number; // Execution timeout
  'framework.pydantic_ai.enable_cache'?: boolean; // LLM caching
  'framework.pydantic_ai.result_validation'?: boolean; // Validate output

  // OpenAI Realtime API
  'framework.openai_realtime.modality'?: 'text' | 'audio' | 'both';
  'framework.openai_realtime.input_audio_format'?: string;
  'framework.openai_realtime.output_audio_format'?: string;

  // Anthropic Batch API
  'framework.anthropic_batch.auto_retry'?: boolean;
  'framework.anthropic_batch.max_batch_size'?: number;

  // ───────────────────────────────────────────────────────────────────
  // Global Tool Governance
  // ───────────────────────────────────────────────────────────────────
  'governance.cost_limit_usd'?: number; // Max spend per session
  'governance.cost_budget_usd'?: number; // Budget before alerts
  'governance.max_total_calls'?: number; // Max LLM calls per session
  'governance.max_loops'?: number; // Max reasoning loops
  'governance.max_tool_calls'?: number; // Max total tool executions
  'governance.call_timeout_ms'?: number; // Max time per call
  'governance.session_timeout_ms'?: number; // Max session length
  'governance.rate_limit_calls_per_minute'?: number; // Throttle requests
  'governance.require_approval_for_tools'?: string[]; // Tools needing approval
  'governance.blocked_tools'?: string[]; // Disable specific tools
  'governance.blocked_models'?: string[]; // Prevent certain models

  // ───────────────────────────────────────────────────────────────────
  // Per-Tool Governance
  // ───────────────────────────────────────────────────────────────────
  [key: `tools.${string}.enabled`]: boolean; // Enable/disable tool
  [key: `tools.${string}.max_calls`]: number; // Max calls per session
  [key: `tools.${string}.cost_limit_usd`]: number; // Tool-specific budget
  [key: `tools.${string}.timeout_ms`]: number; // Tool timeout
  [key: `tools.${string}.rate_limit_per_minute`]: number; // Tool throttling
  [key: `tools.${string}.requires_approval`]: boolean; // Needs human OK
  [key: `tools.${string}.require_confirmation`]: boolean; // User prompt
  [key: `tools.${string}.max_retries`]: number; // Retry failed calls
  [key: `tools.${string}.retry_delay_ms`]: number; // Delay between retries
  [key: `tools.${string}.dangerous`]: boolean; // Flag as high-risk
  [key: `tools.${string}.audit_log`]: boolean; // Always log usage
  [key: `tools.${string}.validate_input`]: boolean; // Validate arguments
  [key: `tools.${string}.allowed_in_parallel`]: boolean; // Can call in parallel
  [key: `tools.${string}.cache_results`]: boolean; // Cache tool output
  [key: `tools.${string}.cache_ttl_ms`]: number; // Cache expiry

  // ───────────────────────────────────────────────────────────────────
  // Tool Parameter Overrides (Arbitrary Tool Parameters)
  // ───────────────────────────────────────────────────────────────────
  // Pattern: tools.{toolName}.param.{paramName}
  // Examples:
  //   tools.web_search.param.max_results = 5
  //   tools.database_query.param.timeout_ms = 5000
  //   tools.calculator.param.precision = 4
  [key: `tools.${string}.param.${string}`]: unknown;

  // ───────────────────────────────────────────────────────────────────
  // Advanced Features
  // ───────────────────────────────────────────────────────────────────
  'advanced.enable_tool_use'?: boolean; // Allow function calling
  'advanced.enable_retrieval'?: boolean; // Allow RAG/retrieval
  'advanced.enable_memory'?: boolean; // Enable conversation memory
  'advanced.enable_reflection'?: boolean; // Self-reflection steps
  'advanced.enable_planning'?: boolean; // Multi-step planning
  'advanced.cache_embeddings'?: boolean; // Cache vector lookups
  'advanced.prefer_cached_responses'?: boolean; // Use cached outputs
  'advanced.enable_batching'?: boolean; // Batch requests
  'advanced.parallel_tool_calls'?: number; // Max parallel tools
  'advanced.exponential_backoff'?: boolean; // Smart retry delays
}

/**
 * Configuration for a single tool with all possible overrides.
 */
export interface ToolConfig {
  enabled: boolean;
  maxCalls?: number;
  costLimitUsd?: number;
  timeoutMs?: number;
  rateLimitPerMinute?: number;
  requiresApproval?: boolean;
  requireConfirmation?: boolean;
  maxRetries?: number;
  retryDelayMs?: number;
  dangerous?: boolean;
  auditLog?: boolean;
  validateInput?: boolean;
  allowedInParallel?: boolean;
  cacheResults?: boolean;
  cacheTtlMs?: number;
  // Tool-specific parameter overrides
  parameters?: Record<string, unknown>;
}

/**
 * Parameter matrix: What each framework/library supports.
 * Used for validation and documentation.
 */
export interface ParameterMatrix {
  framework: string;
  version: string;
  parameters: {
    [key in keyof CompleteControlConfig]?: {
      supported: boolean;
      method: 'api' | 'patch' | 'config' | 'manual'; // How we apply it
      notes?: string;
    };
  };
}

/**
 * Runtime validation: Ensure config values are in valid ranges.
 */
export const PARAMETER_CONSTRAINTS: Partial<Record<keyof CompleteControlConfig, {
  min?: number;
  max?: number;
  type?: 'string' | 'number' | 'boolean' | 'array';
  enum?: unknown[];
}>> = {
  'llm.temperature': { min: 0, max: 2, type: 'number' },
  'llm.max_tokens': { min: 1, max: 1000000, type: 'number' },
  'llm.top_p': { min: 0, max: 1, type: 'number' },
  'llm.top_k': { min: 0, type: 'number' },
  'llm.frequency_penalty': { min: -2, max: 2, type: 'number' },
  'llm.presence_penalty': { min: -2, max: 2, type: 'number' },
  'llm.seed': { min: 0, type: 'number' },
  'framework.langgraph.max_iterations': { min: 1, max: 10000, type: 'number' },
  'framework.langgraph.timeout_ms': { min: 100, max: 3600000, type: 'number' },
  'framework.vercel.max_steps': { min: 1, max: 100, type: 'number' },
  'framework.vercel.max_retries': { min: 0, max: 10, type: 'number' },
  'governance.cost_limit_usd': { min: 0, type: 'number' },
  'governance.max_total_calls': { min: 1, type: 'number' },
  'governance.max_loops': { min: 1, type: 'number' },
  'governance.rate_limit_calls_per_minute': { min: 1, type: 'number' },
  'prompt.response_format': { enum: ['text', 'json', 'xml'], type: 'string' },
};

/**
 * Convert config key to type-safe constant.
 * Example: 'llm.temperature' → CompleteControlConfig['llm.temperature']
 */
export type ConfigKey = keyof CompleteControlConfig;

/**
 * Get type for a config key (for runtime validation).
 */
export function getConfigType(key: string): 'string' | 'number' | 'boolean' | 'array' | 'object' {
  if (key.startsWith('llm.') || key.startsWith('governance.') || key.startsWith('framework.')) {
    const constraint = PARAMETER_CONSTRAINTS[key as ConfigKey];
    if (constraint?.type) return constraint.type;
  }
  if (key.includes('enabled') || key.includes('disabled') || key.includes('require')) {
    return 'boolean';
  }
  if (key.includes('timeout') || key.includes('max_') || key.includes('limit') || key.includes('count')) {
    return 'number';
  }
  return 'string';
}

/**
 * Validate a config value against constraints.
 */
export function validateConfigValue(
  key: string,
  value: unknown,
): { valid: boolean; error?: string } {
  const constraint = PARAMETER_CONSTRAINTS[key as ConfigKey];
  if (!constraint) return { valid: true }; // Unknown keys are allowed

  if (constraint.type && typeof value !== constraint.type) {
    return {
      valid: false,
      error: `${key} must be ${constraint.type}, got ${typeof value}`,
    };
  }

  if (typeof value === 'number') {
    if (constraint.min !== undefined && value < constraint.min) {
      return { valid: false, error: `${key} must be >= ${constraint.min}` };
    }
    if (constraint.max !== undefined && value > constraint.max) {
      return { valid: false, error: `${key} must be <= ${constraint.max}` };
    }
  }

  if (constraint.enum && !constraint.enum.includes(value)) {
    return { valid: false, error: `${key} must be one of ${constraint.enum.join(', ')}` };
  }

  return { valid: true };
}
