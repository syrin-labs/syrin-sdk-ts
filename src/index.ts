/**
 * Syrin SDK — Public API
 *
 * Usage:
 *   import { init } from "@syrin/sdk";
 *   const sdk = await init({ apiKey: "syrin_..." });
 *   // All existing openai calls are now instrumented
 */

import { createConfig } from '@/config';
import { SessionStore, sessionStorage, resolveSessionId } from '@/session';
import { Emitter } from '@/emitter';
import { OTelBridge } from '@/otel';
import { CheckpointClient } from '@/checkpoint';
import { SyrinCore } from '@/core';
import { OpenAIAdapter, unpatch, isPatched } from '@/adapters/openai';
import { clearHooks } from '@/hooks';
import { generateId } from '@/utils';
import type { SyrinConfig, SyrinSDK } from '@/types';
import type { SyrinAdapter } from '@/adapters/types';


export type { SyrinConfig, SyrinEvent, IngestPayload, IngestResponse, SessionState, SyrinSDK, CallInfo, RunContext, GovernanceAction, GovernanceData } from '@/types';
export { withAgent, withWorkflow, withSwarm, getRunContext } from '@/agent';
export { GovernanceStopError } from '@/governance';
export type { Checkpoint } from '@/checkpoint';
export { onConfigChange, onAlert } from '@/hooks';
export { SyrinCore } from '@/core';
export type { SyrinAdapter, NormalizedCallParams, NormalizedCallResult, BeforeCallResult, ISyrinCore, SchemaField as AdapterSchemaField } from '@/adapters/types';
export { OpenAIAdapter } from '@/adapters/openai';
export { ConfigStore } from '@/config-store';
export type { FieldSchema } from '@/config-store';
export { tunable, TunableField, tune, getTune, globalRegistry, TunableRegistry } from '@/tunable';
export { AnthropicAdapter } from '@/adapters/anthropic';
export { LangChainAdapter } from '@/adapters/langchain';
export { LangGraphAdapter } from '@/adapters/langgraph';
export { MastraAdapter } from '@/adapters/mastra';
export { VercelAIAdapter } from '@/adapters/vercel-ai';
export { BaseFrameworkAdapter } from '@/adapters/types';
export type { FrameworkAdapter } from '@/adapters/types';

export interface SyrinInitOptions {
  apiKey?: string;
  agentId?: string;
  sessionId?: string;
  backendUrl?: string;
  otelExporter?: 'none' | 'console' | 'otlp';
  otelEndpoint?: string;
  debug?: boolean;
  captureContent?: boolean;
  offline?: boolean;
  batchIntervalMs?: number;
  batchSize?: number;
  toolValidation?: boolean;
  sessionTtlMs?: number;
  adapters?: import('./adapters/types.js').SyrinAdapter[];
}

export class SyrinSDKInstance implements SyrinSDK {
  private _sessionId: string;
  private _config: SyrinConfig;
  private _sessionStore: SessionStore;
  private _emitter: Emitter;
  private _otelBridge: OTelBridge;
  private _core: SyrinCore;

  constructor(
    config: SyrinConfig,
    sessionStore: SessionStore,
    emitter: Emitter,
    otelBridge: OTelBridge,
    core: SyrinCore,
  ) {
    this._config = config;
    this._sessionStore = sessionStore;
    this._emitter = emitter;
    this._otelBridge = otelBridge;
    this._core = core;
    this._sessionId = resolveSessionId(config.sessionId);
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get config(): SyrinConfig {
    return this._config;
  }

  /**
   * Register a custom adapter (e.g. LangChain, Anthropic) after init().
   *
   * @example
   * import { MyCustomAdapter } from './my-adapter';
   * await sdk.registerAdapter(new MyCustomAdapter());
   */
  async registerAdapter(adapter: SyrinAdapter): Promise<void> {
    await this._core.registerAdapter(adapter);
  }

  /**
   * Return the tool validation result for a tool call ID.
   * Requires toolValidation: true in init() options.
   */
  getToolValidation(
    toolCallId: string,
    sessionId?: string
  ): { valid: boolean; error?: string } | undefined {
    const sid = sessionId ?? this._sessionId;
    return this._sessionStore.getToolValidation(sid, toolCallId);
  }

  /**
   * Set local config overrides — takes priority over remote config.
   */
  configure(overrides: Record<string, unknown>, sessionId?: string): void {
    const sid = sessionId ?? this._sessionId;
    this._sessionStore.setLocalConfig(sid, overrides);
  }

  /**
   * Return the currently active remote config for a session.
   */
  activeConfig(sessionId?: string): Record<string, unknown> {
    const sid = sessionId ?? this._sessionId;
    return this._sessionStore.getEffectiveConfig(sid);
  }

  /**
   * Create a checkpoint of the current conversation state.
   * Persisted to the Syrin backend; falls back to local cache if offline.
   */
  async createCheckpoint(
    messages: Array<Record<string, unknown>>,
    options: { sessionId?: string; label?: string; metadata?: Record<string, unknown> } = {}
  ): Promise<import('./checkpoint.js').Checkpoint> {
    const sid = options.sessionId ?? this._sessionId;
    const session = this._sessionStore.getSession(sid);
    const cp = await this._core.checkpointClient.save(sid, messages, {
      label: options.label,
      metadata: options.metadata,
      activeConfig: session?.activeConfig ?? {},
      callCount: session?.callCount ?? 0,
      cumulativeCostUsd: session?.cumulativeCostUsd ?? 0,
    });
    if (session) {
      session.lastCheckpointId = cp.checkpointId;
    }
    return cp;
  }

  /**
   * Restore messages from a saved checkpoint.
   * Fetches from backend if not in local cache.
   */
  async restoreCheckpoint(checkpointId: string): Promise<Array<Record<string, unknown>> | undefined> {
    const cp = await this._core.checkpointClient.getById(checkpointId);
    if (!cp) return undefined;
    return [...cp.messages];
  }

  /**
   * List all checkpoints for a session (from local cache).
   */
  listCheckpoints(sessionId?: string): import('./checkpoint.js').Checkpoint[] {
    return this._core.checkpointClient.listForSession(sessionId ?? this._sessionId);
  }

  deleteSession(sessionId: string): void {
    this._sessionStore.deleteSession(sessionId);
  }

  clearStaleSessions(olderThanMs = 3_600_000): number {
    return this._sessionStore.clearStaleSessions(olderThanMs);
  }

  /**
   * Return a sanitized config snapshot with the API key masked.
   */
  configSnapshot(): Record<string, unknown> {
    const { apiKey: _masked, ...rest } = this._config;
    return { ...rest, apiKey: '****' };
  }

  async flush(): Promise<void> {
    await this._emitter.flush();
  }

  async shutdown(): Promise<void> {
    await this._emitter.stop();
    this._core.uninstallAll();
    await this._otelBridge.shutdown();
  }
}

// Global singleton state
let _instance: SyrinSDKInstance | null = null;

/**
 * Initialize the Syrin SDK.
 * Patches the OpenAI SDK and starts the event emitter.
 *
 * @remarks
 * ⚠️ You MUST await init(). If you skip await, the OpenAI SDK may not be
 * patched before your first API call and telemetry will be silently missed.
 */
export async function init(options: SyrinInitOptions = {}): Promise<SyrinSDKInstance> {
  if (_instance !== null) {
    console.warn(
      '[Syrin] init() called more than once. Reinitializing. Call shutdown() first to avoid this warning.'
    );
    _teardown();
  }

  clearHooks();

  const config = createConfig(options as Partial<SyrinConfig> & { apiKey?: string });

  const sessionId = resolveSessionId(config.sessionId);
  config.sessionId = sessionId;

  const sessionStore = new SessionStore();
  const emitter = new Emitter(config, sessionStore);
  const otelBridge = new OTelBridge(config);
  const checkpointClient = new CheckpointClient(config);

  otelBridge.setup();
  emitter.start();

  // Build SyrinCore — the provider-agnostic instrumentation engine
  const core = new SyrinCore(config, sessionStore, emitter, otelBridge, checkpointClient);

  // Register the built-in OpenAI adapter (loads openai module lazily)
  await core.registerAdapter(new OpenAIAdapter());

  // Wire ConfigStore into core so framework adapters can read config
  const { ConfigStore } = await import('./config-store.js');
  const configStore = new ConfigStore();
  (core as unknown as Record<string, unknown>)['_configStore'] = configStore;

  // Wire global TunableRegistry into core
  const { globalRegistry } = await import('./tunable.js');
  (core as unknown as Record<string, unknown>)['_tunableRegistry'] = globalRegistry;

  // Try to auto-install Anthropic adapter if @anthropic-ai/sdk is available
  try {
    const { AnthropicAdapter } = await import('./adapters/anthropic.js');
    await core.registerAdapter(new AnthropicAdapter());
  } catch {
    // @anthropic-ai/sdk not installed — skip silently
  }

  // Register user-provided adapters
  if (options.adapters) {
    for (const adapter of options.adapters) {
      await core.registerAdapter(adapter);
    }
  }

  // POST config schema to backend so the dashboard knows what's remotely configurable
  await core.register();

  const instance = new SyrinSDKInstance(config, sessionStore, emitter, otelBridge, core);
  _instance = instance;

  if (config.debug) {
    console.log(
      `[Syrin] Initialized. sessionId=${sessionId} agentId=${config.agentId ?? 'none'} backend=${config.backendUrl}`
    );
  }

  sessionStore.getOrCreate(sessionId, config.agentId).catch(() => { /* ignore */ });

  return instance;
}

function _teardown(): void {
  if (_instance) {
    _instance.shutdown().catch(() => { /* ignore */ });
    _instance = null;
  }
  if (isPatched()) {
    unpatch();
  }
}

export async function shutdown(): Promise<void> {
  if (_instance) {
    await _instance.shutdown();
    _instance = null;
  }
}

export function getSessionId(): string {
  if (_instance) {
    return sessionStorage.getStore() ?? _instance.sessionId;
  }
  return sessionStorage.getStore() ?? generateId('ses_');
}

export async function withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return sessionStorage.run(sessionId, fn);
}

export function getInstance(): SyrinSDKInstance | null {
  return _instance;
}

export function getToolValidation(
  toolCallId: string,
  sessionId?: string
): { valid: boolean; error?: string } | undefined {
  return _instance?.getToolValidation(toolCallId, sessionId);
}

export function configure(overrides: Record<string, unknown>, sessionId?: string): void {
  _instance?.configure(overrides, sessionId);
}

export async function createCheckpoint(
  messages: Array<Record<string, unknown>>,
  options: { sessionId?: string; label?: string; metadata?: Record<string, unknown> } = {}
): Promise<import('./checkpoint.js').Checkpoint | undefined> {
  return _instance?.createCheckpoint(messages, options);
}

export async function restoreCheckpoint(checkpointId: string): Promise<Array<Record<string, unknown>> | undefined> {
  return _instance?.restoreCheckpoint(checkpointId);
}

export function deleteSession(sessionId: string): void {
  _instance?.deleteSession(sessionId);
}

export function clearStaleSessions(olderThanMs = 3_600_000): number {
  return _instance?.clearStaleSessions(olderThanMs) ?? 0;
}

export function configSnapshot(): Record<string, unknown> | null {
  return _instance?.configSnapshot() ?? null;
}
