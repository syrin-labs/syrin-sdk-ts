/**
 * LangGraph Adapter — Event emission helpers
 */

import { generateId, nowIso } from '@/utils/helpers.js';

export interface LangGraphAdapterEmitter {
  emitEvent(event: Record<string, unknown>): void;
  readonly sessionId: string | undefined;
  readonly agentId: string | undefined;
  getConfig(namespace: string): Record<string, unknown>;
}

export function emitGraphExecution(
  adapter: LangGraphAdapterEmitter,
  runId: string,
  graphId: string,
  durationMs: number,
  inputHash: string,
  outputHash: string,
  error: Error | null,
  didStopEarly: boolean
): void {
  adapter.emitEvent({
    event_id: generateId('evt_'),
    event_type: 'GRAPH_EXECUTION',
    timestamp: nowIso(),
    run_id: runId,
    graph_id: graphId,
    session_id: adapter.sessionId,
    agent_id: adapter.agentId,
    duration_ms: durationMs,
    input_hash: inputHash,
    output_hash: outputHash,
    error: error?.message ?? null,
    did_stop_early: didStopEarly,
  });
}

export function emitNodeExecution(
  adapter: LangGraphAdapterEmitter,
  nodeName: string,
  graphRunId: string,
  inputHash: string,
  outputHash: string,
  durationMs: number,
  error: Error | null
): void {
  adapter.emitEvent({
    event_id: generateId('evt_'),
    event_type: 'NODE_EXECUTION',
    timestamp: nowIso(),
    node_name: nodeName,
    graph_run_id: graphRunId,
    session_id: adapter.sessionId,
    agent_id: adapter.agentId,
    duration_ms: durationMs,
    input_hash: inputHash,
    output_hash: outputHash,
    error: error?.message ?? null,
  });
}

export function emitHITL(
  adapter: LangGraphAdapterEmitter,
  graphRunId: string,
  interruptValue: unknown
): void {
  adapter.emitEvent({
    event_id: generateId('evt_'),
    event_type: 'HITL_INTERRUPT',
    timestamp: nowIso(),
    session_id: adapter.sessionId,
    agent_id: adapter.agentId,
    graph_run_id: graphRunId,
    interrupt_value: interruptValue,
  });
}

export function injectLangGraphConfig(
  adapter: LangGraphAdapterEmitter,
  config?: Record<string, unknown>
): Record<string, unknown> {
  const lgCfg = adapter.getConfig('langgraph');
  const llmCfg = adapter.getConfig('llm');

  const hasLgOverrides = Object.values(lgCfg).some((v) => v != null);
  const hasLlmOverrides = Object.values(llmCfg).some((v) => v != null);

  if (!hasLgOverrides && !hasLlmOverrides) return config ?? {};

  const result = { ...(config ?? {}) };
  const configurable = {
    ...((result['configurable'] as Record<string, unknown>) ?? {}),
  };

  if (lgCfg['recursion_limit'] != null) result['recursionLimit'] = lgCfg['recursion_limit'];
  if (lgCfg['interrupt_before'] != null) result['interruptBefore'] = lgCfg['interrupt_before'];
  if (lgCfg['interrupt_after'] != null) result['interruptAfter'] = lgCfg['interrupt_after'];
  if (lgCfg['thread_id'] != null) configurable['thread_id'] = lgCfg['thread_id'];
  if (lgCfg['max_concurrency'] != null) result['maxConcurrency'] = lgCfg['max_concurrency'];
  if (lgCfg['stream_mode'] != null) result['streamMode'] = lgCfg['stream_mode'];
  if (lgCfg['debug'] != null) result['debug'] = lgCfg['debug'];

  for (const key of ['temperature', 'max_tokens', 'model'] as const) {
    if (llmCfg[key] != null) configurable[key] = llmCfg[key];
  }

  result['configurable'] = configurable;
  return result;
}
