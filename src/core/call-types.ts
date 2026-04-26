/**
 * Internal call-lifecycle types shared between the engine and the OpenAI interceptor.
 */

import type { SyrinConfig } from '../types.js';
import type { SessionStore } from './session.js';

export interface NormalizedMessage {
  role: string;
  content: unknown;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface NormalizedToolDefinition {
  name: string | undefined;
  parameters: unknown;
}

export interface NormalizedCallParams {
  model: string;
  messages: NormalizedMessage[];
  temperature?: number;
  max_tokens?: number;
  stream: boolean;
  tools?: NormalizedToolDefinition[];
  raw: Record<string, unknown>;
}

export interface NormalizedCallResult {
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  durationMs: number;
  toolCalls?: NormalizedToolCall[];
  toolDefinitions?: NormalizedToolDefinition[];
  responseText?: string;
  stream: boolean;
}

export interface BeforeCallResult {
  sessionId: string;
  agentId: string | undefined;
  initialCumulativeCostUsd: number;
  configApplied: boolean;
  governanceApplied: boolean;
  modifiedRaw: Record<string, unknown>;
  modifiedMessages: NormalizedMessage[];
  tempUnsupported: boolean;
}

export interface SchemaField {
  name: string;
  type: 'str' | 'float' | 'int' | 'bool';
  default?: unknown;
  multiline?: boolean;
  constraints?: { ge?: number; le?: number; gt?: number; lt?: number; enum?: unknown[] };
}

/** Minimal interface the OpenAI interceptor needs from the core. */
export interface ICallTarget {
  readonly config: SyrinConfig;
  readonly sessionStore: SessionStore;
  beforeCall(params: NormalizedCallParams): Promise<BeforeCallResult>;
  afterCall(ctx: BeforeCallResult, params: NormalizedCallParams, result: NormalizedCallResult): void;
  onStreamComplete(ctx: BeforeCallResult, params: NormalizedCallParams, result: NormalizedCallResult): void;
  onCallError(ctx: BeforeCallResult | null, params: NormalizedCallParams, error: Error, durationMs: number): void;
}
