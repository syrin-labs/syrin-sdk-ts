/**
 * Syrin telemetry event type string constants.
 *
 * Use these instead of bare strings so that any future renames are a
 * one-line change in this file.
 *
 * @example
 * ```ts
 * import { EventType } from '@/constants/index.js';
 * const event = { event_type: EventType.LLM_CALL, ... };
 * ```
 */
export const EventType = {
  // LLM calls
  LLM_CALL: 'LLM_CALL',
  LLM_ERROR: 'LLM_ERROR',

  // Session lifecycle
  SESSION_STARTED: 'SESSION_STARTED',
  SESSION_ENDED: 'SESSION_ENDED',
  SESSION_SUMMARY: 'SESSION_SUMMARY',

  // Agent lifecycle
  AGENT_RUN_STARTED: 'AGENT_RUN_STARTED',
  AGENT_RUN_ENDED: 'AGENT_RUN_ENDED',

  // Workflow / swarm lifecycle
  WORKFLOW_STARTED: 'WORKFLOW_STARTED',
  WORKFLOW_ENDED: 'WORKFLOW_ENDED',
  SWARM_STARTED: 'SWARM_STARTED',
  SWARM_ENDED: 'SWARM_ENDED',

  // Config
  CONFIG_APPLIED: 'CONFIG_APPLIED',

  // Tools
  TOOL_CALL: 'TOOL_CALL',
  TOOL_RESULT: 'TOOL_RESULT',
  TOOL_SELECTED: 'TOOL_SELECTED',

  // Approvals (HITL)
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  APPROVAL_GRANTED: 'APPROVAL_GRANTED',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',

  // Governance
  GOVERNANCE_TRIGGERED: 'GOVERNANCE_TRIGGERED',

  // Observability
  CONTEXT_INJECTION: 'CONTEXT_INJECTION',
  EXPERIMENT_ASSIGNED: 'EXPERIMENT_ASSIGNED',
  MEMORY_RETRIEVAL: 'MEMORY_RETRIEVAL',
  CUSTOM_LOG: 'CUSTOM_LOG',
  CUSTOM: 'CUSTOM',

  // Multi-agent routing
  HANDOFF: 'HANDOFF',
  AGENT_FORK: 'AGENT_FORK',
  AGENT_JOIN: 'AGENT_JOIN',
  WORKER_SPAWNED: 'WORKER_SPAWNED',

  // Guardrails / circuit breakers
  GUARDRAIL_INPUT: 'GUARDRAIL_INPUT',
  GUARDRAIL_OUTPUT: 'GUARDRAIL_OUTPUT',
  CIRCUIT_BREAKER_OPEN: 'CIRCUIT_BREAKER_OPEN',
  CIRCUIT_BREAKER_CLOSE: 'CIRCUIT_BREAKER_CLOSE',

  // Budget
  BUDGET_ESTIMATION: 'BUDGET_ESTIMATION',

  // Framework adapters
  CHAIN_EXECUTION: 'CHAIN_EXECUTION',

  // Internal
  QUEUE_OVERFLOW: 'QUEUE_OVERFLOW',
} as const;

export type EventTypeName = typeof EventType[keyof typeof EventType];
