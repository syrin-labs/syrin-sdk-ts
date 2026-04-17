/**
 * Syrin SDK Identity — tracks session, agent, user, and execution context.
 *
 * Features:
 * - Session lifecycle tracking
 * - User identity mapping
 * - Agent identification
 * - Framework context (LangChain, OpenAI, etc.)
 * - Execution context with call hierarchy
 */

import { generateId, nowIso } from '@/utils/helpers.js';
import { sessionStorage } from './session.js';

export interface IdentityContext {
  sessionId: string;
  userId?: string;
  agentId?: string;
  agentName?: string;
  framework?: string;
  runId?: string;
  callStack: CallContext[];
  startedAt: string;
  metadata: Record<string, unknown>;
}

export interface CallContext {
  callId: string;
  type: 'llm_call' | 'tool_call' | 'framework_call' | 'agentic_call';
  functionName: string;
  provider?: string;
  model?: string;
  timestamp: string;
  duration?: number; // ms
  status: 'pending' | 'success' | 'error';
  parentCallId?: string;
}

/**
 * Manages execution identity and context throughout the call lifecycle.
 * Tracks who is making calls, what they're calling, and their execution hierarchy.
 */
export class IdentityManager {
  private sessionToIdentity = new Map<string, IdentityContext>();
  private sessionToCallStack = new Map<string, CallContext[]>();

  /**
   * Create or retrieve the identity context for a session.
   */
  getOrCreateIdentity(
    sessionId: string,
    options?: { userId?: string; agentId?: string; agentName?: string; framework?: string },
  ): IdentityContext {
    const existing = this.sessionToIdentity.get(sessionId);
    if (existing) {
      // Update optional fields if provided
      if (options?.userId !== undefined) existing.userId = options.userId;
      if (options?.agentId !== undefined) existing.agentId = options.agentId;
      if (options?.agentName !== undefined) existing.agentName = options.agentName;
      if (options?.framework !== undefined) existing.framework = options.framework;
      return existing;
    }

    const identity: IdentityContext = {
      sessionId,
      userId: options?.userId,
      agentId: options?.agentId,
      agentName: options?.agentName,
      framework: options?.framework,
      runId: generateId('run_'),
      callStack: [],
      startedAt: nowIso(),
      metadata: {},
    };

    this.sessionToIdentity.set(sessionId, identity);
    this.sessionToCallStack.set(sessionId, []);
    return identity;
  }

  /**
   * Get the current identity context from AsyncLocalStorage (if available)
   * or fallback to default session.
   */
  getCurrentIdentity(): IdentityContext | undefined {
    const sessionId = sessionStorage.getStore();
    if (sessionId) {
      return this.sessionToIdentity.get(sessionId);
    }
    return undefined;
  }

  /**
   * Push an LLM call onto the call stack.
   */
  pushLlmCall(
    provider: string,
    model: string,
    sessionId: string,
  ): CallContext {
    const identity = this.getOrCreateIdentity(sessionId);
    const callStack = this.sessionToCallStack.get(sessionId) ?? [];

    const callContext: CallContext = {
      callId: generateId('call_'),
      type: 'llm_call',
      functionName: `${provider}/${model}`,
      provider,
      model,
      timestamp: nowIso(),
      status: 'pending',
      parentCallId: callStack[callStack.length - 1]?.callId,
    };

    callStack.push(callContext);
    identity.callStack.push(callContext);
    this.sessionToCallStack.set(sessionId, callStack);

    return callContext;
  }

  /**
   * Push a tool call onto the call stack.
   */
  pushToolCall(
    toolName: string,
    sessionId: string,
  ): CallContext {
    const identity = this.getOrCreateIdentity(sessionId);
    const callStack = this.sessionToCallStack.get(sessionId) ?? [];

    const callContext: CallContext = {
      callId: generateId('tcall_'),
      type: 'tool_call',
      functionName: toolName,
      timestamp: nowIso(),
      status: 'pending',
      parentCallId: callStack[callStack.length - 1]?.callId,
    };

    callStack.push(callContext);
    identity.callStack.push(callContext);
    this.sessionToCallStack.set(sessionId, callStack);

    return callContext;
  }

  /**
   * Mark a call as complete (success or error).
   */
  completeCall(
    callContext: CallContext,
    status: 'success' | 'error',
    durationMs?: number,
  ): void {
    callContext.status = status;
    callContext.duration = durationMs;
  }

  /**
   * Pop the last call from the stack.
   */
  popCall(sessionId: string): CallContext | undefined {
    const callStack = this.sessionToCallStack.get(sessionId);
    if (!callStack || callStack.length === 0) return undefined;
    return callStack.pop();
  }

  /**
   * Get the current call stack depth.
   */
  getCallStackDepth(sessionId: string): number {
    return this.sessionToCallStack.get(sessionId)?.length ?? 0;
  }

  /**
   * Get the parent call context.
   */
  getParentCall(sessionId: string): CallContext | undefined {
    const callStack = this.sessionToCallStack.get(sessionId);
    if (!callStack || callStack.length < 2) return undefined;
    return callStack[callStack.length - 2];
  }

  /**
   * Set user identity for a session.
   */
  setUserId(sessionId: string, userId: string): void {
    const identity = this.getOrCreateIdentity(sessionId);
    identity.userId = userId;
  }

  /**
   * Set agent identity for a session.
   */
  setAgentId(sessionId: string, agentId: string, agentName?: string): void {
    const identity = this.getOrCreateIdentity(sessionId);
    identity.agentId = agentId;
    if (agentName) identity.agentName = agentName;
  }

  /**
   * Set framework context for a session.
   */
  setFramework(sessionId: string, framework: string): void {
    const identity = this.getOrCreateIdentity(sessionId);
    identity.framework = framework;
  }

  /**
   * Store arbitrary metadata.
   */
  setMetadata(sessionId: string, key: string, value: unknown): void {
    const identity = this.getOrCreateIdentity(sessionId);
    identity.metadata[key] = value;
  }

  /**
   * Get metadata value.
   */
  getMetadata(sessionId: string, key: string): unknown {
    return this.getOrCreateIdentity(sessionId).metadata[key];
  }

  /**
   * Delete a session's identity context.
   */
  deleteSession(sessionId: string): void {
    this.sessionToIdentity.delete(sessionId);
    this.sessionToCallStack.delete(sessionId);
  }

  /**
   * Export identity context as a clean object (for logging/debugging).
   */
  exportIdentity(sessionId: string): Record<string, unknown> {
    const identity = this.sessionToIdentity.get(sessionId);
    if (!identity) return {};

    const recentCalls = identity.callStack.slice(-10).map((c) => ({
      callId: c.callId,
      type: c.type,
      function: c.functionName,
      provider: c.provider,
      status: c.status,
      duration: c.duration,
    }));

    return {
      sessionId: identity.sessionId,
      userId: identity.userId,
      agentId: identity.agentId,
      agentName: identity.agentName,
      framework: identity.framework,
      runId: identity.runId,
      startedAt: identity.startedAt,
      callStackDepth: identity.callStack.length,
      recentCalls,
      metadata: identity.metadata,
    };
  }
}

// Global identity manager instance
let globalIdentityManager = new IdentityManager();

export function getIdentityManager(): IdentityManager {
  return globalIdentityManager;
}

export function setIdentityManager(manager: IdentityManager): void {
  globalIdentityManager = manager;
}
