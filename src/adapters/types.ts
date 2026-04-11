/**
 * Syrin SDK — Adapter contract types.
 *
 * These types form the bridge between provider-specific SDK adapters (OpenAI, Anthropic,
 * LangChain, …) and the provider-agnostic SyrinCore instrumentation engine.
 *
 * An adapter is responsible for:
 *   1. Intercepting the underlying SDK's LLM calls.
 *   2. Normalising the provider-specific request/response into these shared types.
 *   3. Calling core.beforeCall() / core.afterCall() / core.onStreamComplete() at the right moments.
 *
 * The core is responsible for governance, config injection, telemetry building, and emitting.
 */

import { generateId, nowIso, estimateCost } from '../utils/helpers.js';
import { sessionStorage } from '../core/session.js';

// ---------------------------------------------------------------------------
// Normalised request / response shapes
// ---------------------------------------------------------------------------

export interface NormalizedMessage {
  role: string;
  content: string | null | unknown;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string
}

export interface NormalizedToolDefinition {
  name: string | undefined;
  parameters: unknown;
}

/**
 * Provider-agnostic view of an LLM request.
 * Created by the adapter before handing off to core.beforeCall().
 * `raw` carries the original provider-specific params for pass-through.
 */
export interface NormalizedCallParams {
  model: string;
  messages: NormalizedMessage[];
  temperature?: number;
  max_tokens?: number;
  stream: boolean;
  tools?: NormalizedToolDefinition[];
  /** Original provider params — adapter uses this to call the actual SDK */
  raw: Record<string, unknown>;
}

/**
 * Provider-agnostic view of a completed LLM call.
 * Created by the adapter after extracting data from the provider response.
 */
export interface NormalizedCallResult {
  /** Actual model used — may differ from request (e.g. version suffix) */
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  durationMs: number;
  toolCalls?: NormalizedToolCall[];
  toolDefinitions?: NormalizedToolDefinition[];
  /** Only populated when config.captureContent is true */
  responseText?: string;
  stream: boolean;
}

/**
 * Result from SyrinCore.beforeCall() — passed back into afterCall() / onStreamComplete() / onCallError().
 * Carries all resolved context the adapter needs to complete the call lifecycle.
 */
export interface BeforeCallResult {
  sessionId: string;
  /** Agent ID resolved at call time */
  agentId: string | undefined;
  /** Cumulative cost BEFORE this call — used in error OTel spans */
  initialCumulativeCostUsd: number;
  configApplied: boolean;
  governanceApplied: boolean;
  /**
   * Modified provider params after governance + config injection.
   * The adapter MUST use this instead of the original params when calling the SDK.
   */
  modifiedRaw: Record<string, unknown>;
  /**
   * Messages after all injections — used for rich telemetry (hashing, loop detection).
   */
  modifiedMessages: NormalizedMessage[];
  tempUnsupported: boolean;
}

// ---------------------------------------------------------------------------
// SyrinAdapter interface
// ---------------------------------------------------------------------------

/**
 * Minimal core interface that adapters need — avoids circular imports between
 * adapters/types.ts and core.ts while still being strongly typed.
 *
 * SyrinCore implements this interface.
 */
export interface ISyrinCore {
  readonly config: import('../types.js').SyrinConfig;
  readonly sessionStore: import('../core/session.js').SessionStore;
  beforeCall(params: NormalizedCallParams): Promise<BeforeCallResult>;
  afterCall(ctx: BeforeCallResult, params: NormalizedCallParams, result: NormalizedCallResult): void;
  onStreamComplete(ctx: BeforeCallResult, params: NormalizedCallParams, result: NormalizedCallResult): void;
  onCallError(ctx: BeforeCallResult | null, params: NormalizedCallParams, error: Error, durationMs: number): void;
}

/**
 * Contract that every SDK adapter must satisfy.
 *
 * The adapter owns all provider-specific mechanics (patching, response parsing,
 * stream wrapping). SyrinCore owns all cross-cutting concerns (governance, config
 * injection, telemetry, OTel).
 *
 * Example future adapters: AnthropicAdapter, LangChainOpenAIAdapter, VercelAIAdapter.
 */
export interface SyrinAdapter {
  /**
   * Stable identifier, e.g. "openai", "anthropic", "langchain-openai".
   * Used in debug logs and the adapter registry.
   */
  readonly name: string;

  /**
   * Return the config fields this adapter exposes for remote configuration.
   * Keys are section names (e.g. "llm", "openai"); values are arrays of SchemaField descriptors.
   * Return {} if this adapter has no remotely-configurable fields.
   */
  configSchema(): Record<string, SchemaField[]>;

  /**
   * Install the monkey-patch / hook for this provider SDK.
   * Called once by init() (or by sdk.registerAdapter()).
   * Must be idempotent — safe to call more than once.
   */
  install(core: ISyrinCore): void | Promise<void>;

  /**
   * Remove all patches / hooks. Called on shutdown().
   * Must be idempotent — safe to call when not installed.
   */
  uninstall(): void;

  /** Whether this adapter is currently installed. */
  isInstalled(): boolean;
}

/**
 * Base interface for Tier 2 framework adapters (LangGraph, LangChain, Mastra, etc.)
 * Framework adapters set FrameworkContext and emit framework-level events.
 * They do NOT emit LLM_CALL events — that's Tier 1's responsibility.
 */
export interface FrameworkAdapter extends SyrinAdapter {
  /** Emit a framework event via the core emitter */
  emitEvent(event: Record<string, unknown>): void;
  /** Read current config section */
  getConfig(namespace: string): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Schema types — used for /agents/:id/register
// ---------------------------------------------------------------------------


export interface SchemaField {
  name: string;
  type: 'str' | 'float' | 'int' | 'bool';
  default?: unknown;
  multiline?: boolean;
  constraints?: { ge?: number; le?: number; gt?: number; lt?: number; enum?: unknown[] };
}

/**
 * Abstract base class implementing FrameworkAdapter helpers.
 * Subclasses implement _doInstall() and _doUninstall().
 */
export abstract class BaseFrameworkAdapter implements FrameworkAdapter {
  abstract readonly name: string;
  protected _core: ISyrinCore | null = null;
  private _installed = false;

  async install(core: ISyrinCore): Promise<void> {
    if (this._installed) return;
    this._core = core;
    await this._doInstall(core);
    this._installed = true;
  }

  uninstall(): void {
    if (!this._installed) return;
    this._doUninstall();
    this._core = null;
    this._installed = false;
  }

  isInstalled(): boolean {
    return this._installed;
  }

  protected abstract _doInstall(core: ISyrinCore): void | Promise<void>;
  protected abstract _doUninstall(): void;

  emitEvent(event: Record<string, unknown>): void {
    if (this._core) {
      try {
        (this._core as unknown as { _emitter: { emit: (e: unknown, s: string) => void } })
          ._emitter.emit(event as never, this.sessionId ?? 'unknown');
      } catch (err) {
        // Non-fatal: telemetry errors must never crash user code
        // Silent in production; only log in debug
        const cfg = (this._core as unknown as { config?: { debug?: boolean } })?.config;
        if (cfg?.debug) console.warn('[Syrin] Framework event emit failed (non-fatal):', err);
      }
    }
  }

  getConfig(namespace: string): Record<string, unknown> {
    const cs = (this._core as unknown as { _configStore?: import('../config/store.js').ConfigStore })?._configStore;
    return cs ? cs.getSection(namespace) : {};
  }

  get sessionId(): string | undefined {
    // Prefer AsyncLocalStorage value set by withSession() over static config
    return sessionStorage.getStore() ?? (this._core as unknown as { config: { sessionId?: string } })?.config?.sessionId;
  }

  get agentId(): string | undefined {
    return (this._core as unknown as { config: { agentId?: string } })?.config?.agentId;
  }

  get captureContent(): boolean {
    return (this._core as unknown as { config: { captureContent?: boolean } })?.config?.captureContent ?? false;
  }

  /**
   * Return the config schema sections this adapter exposes.
   * Keys are section names (e.g. "llm", "langgraph").
   * Values are arrays of SchemaField descriptors.
   *
   * Override in subclasses to declare tunable fields.
   */
  configSchema(): Record<string, SchemaField[]> {
    return {};
  }

  /**
   * Build and emit a normalised LLM_CALL event via the core emitter.
   * Eliminates the per-adapter boilerplate.
   */
  emitLlmCallEvent(data: {
    agentName?: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    error: string | null;
    operation?: string;
    promptMessages?: Array<{ role: string; content: string }>;
    completionText?: string;
  }): void {
    const costUsd = estimateCost(data.model, data.inputTokens, data.outputTokens);
    const event: Record<string, unknown> = {
      event_id: generateId('evt_'),
      event_type: 'LLM_CALL',
      timestamp: nowIso(),
      session_id: this.sessionId,
      agent_id: this.agentId,
      framework: this.name,
      agent_name: data.agentName ?? 'unknown',
      model: data.model,
      provider: data.provider,
      input_tokens: data.inputTokens,
      output_tokens: data.outputTokens,
      duration_ms: data.durationMs,
      cost_usd: costUsd,
      error: data.error,
      ...(data.operation != null ? { operation: data.operation } : {}),
    };
    if (this.captureContent) {
      if (data.promptMessages != null) event['prompt_messages'] = data.promptMessages;
      if (data.completionText != null) event['completion_text'] = data.completionText;
    }
    this.emitEvent(event);
  }

  /**
   * Merge config section (default: 'llm') into call options.
   * Eliminates the per-adapter getConfig/inject pattern.
   */
  protected injectLlmConfig(
    opts: Record<string, unknown> | undefined,
    namespace = 'llm',
  ): Record<string, unknown> {
    const cfg = this.getConfig(namespace);
    const hasOverrides = Object.values(cfg).some((v) => v != null);
    if (!hasOverrides) return opts ?? {};
    const result = { ...(opts ?? {}) };
    for (const [key, val] of Object.entries(cfg)) {
      if (val != null) result[key] = val;
    }
    return result;
  }

  /**
   * Extract input/output tokens from a provider response.
   * Tries each candidate field name in order.
   */
  protected extractTokens(
    usage: Record<string, number> | null | undefined,
    inputFields: string[],
    outputFields: string[],
  ): { inputTokens: number; outputTokens: number } {
    const pick = (fields: string[]) => {
      for (const f of fields) {
        if (usage?.[f] != null) return usage[f];
      }
      return 0;
    };
    return { inputTokens: pick(inputFields), outputTokens: pick(outputFields) };
  }
}
