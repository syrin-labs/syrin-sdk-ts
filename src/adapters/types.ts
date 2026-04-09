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
  readonly sessionStore: import('../session.js').SessionStore;
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
