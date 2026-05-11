/**
 * WorkflowClient — Async SAGE Recovery Integration
 *
 * Provides the SDK-side of the multi-agent workflow recovery pipeline:
 *
 * 1. registerWorkflow() — declares workflow topology (agents, roles, goals, SAGE config)
 * 2. handoff() — notifies SAGE of an agent handoff; receives recovery action if drift found
 * 3. Auto-injects recovery prompts into the next agent's context when SAGE detects drift
 *
 * RECOVERY FLOW:
 * Agent A → calls handoff(A→B) → SAGE detects drift → returns injection_text
 * → inject into Agent B's system prompt → Agent B produces corrected output
 *
 * FAST AGENT PROBLEM (2ms agents, 3s SAGE):
 * When bufferMs=0 (default), handoff() returns immediately (non-blocking).
 * The SDK polls for SAGE results in the background and injects recovery at the
 * NEXT available handoff point that hasn't started yet.
 *
 * SAGE DOWN:
 * All HTTP errors are fail-open — workflow continues without correction.
 * Errors are logged but never thrown.
 */

import type { SyrinConfig } from '@/types.js';
import {
  HANDOFF_RESULT_PATH,
  HANDOFFS_PATH,
  RecoveryType,
  type RecoveryTypeName,
  SageMode,
  type SageModeName,
  SageStatus,
  type SageStatusName,
  WORKFLOWS_PATH,
} from '@/constants/index.js';

export interface WorkflowAgentSpec {
  agentId: string;
  role: string;
  goal?: string;
  stageIndex: number;
}

export interface RegisterWorkflowOptions {
  /** Unique ID for this workflow */
  workflowId: string;
  /** Human-readable name */
  name: string;
  /** Overall goal of the workflow */
  goal?: string;
  /** All agents in this workflow */
  agents: WorkflowAgentSpec[];
  /** Where SAGE runs — use SageMode.* constants */
  sageMode?: SageModeName;
  /** Agent IDs where SAGE runs (for sageMode='custom') */
  sagePositions?: string[];
  /** Wait N ms for SAGE before continuing (0 = fully async) */
  bufferMs?: number;
  /** Domain context + normal samples for SAGE baseline scoring */
  domainContext?: Record<string, unknown>;
}

export interface RecoveryAction {
  type: RecoveryTypeName;
  injectionText: string | null;
  agentId: string;
  stageIndex: number;
}

export interface HandoffResult {
  handoffId: string | null;
  sageStatus: SageStatusName;
  driftDetected: boolean | null;
  recoveryAction: RecoveryAction | null;
}

/** Per-session state tracked by the client */
interface SessionState {
  workflowId: string;
  pendingRecovery: Map<string, RecoveryAction>; // agentId → pending injection
  handoffIds: string[];
  lastAgentId: string | null;
  stageCounter: number;
}

export class WorkflowClient {
  private sessions = new Map<string, SessionState>();
  private registeredWorkflows = new Set<string>();

  constructor(private readonly config: SyrinConfig) {}

  /**
   * Register a workflow topology with the SAGE backend.
   * Call this once before any agents start executing.
   */
  async registerWorkflow(options: RegisterWorkflowOptions): Promise<void> {
    const { workflowId } = options;
    const key = `${workflowId}:${this.config.apiKey ?? ''}`;
    if (this.registeredWorkflows.has(key)) return; // idempotent

    try {
      const res = await this.post(WORKFLOWS_PATH, {
        workflow_id: options.workflowId,
        name: options.name,
        goal: options.goal,
        agents: options.agents.map((a) => ({
          agent_id: a.agentId,
          role: a.role,
          goal: a.goal,
          stage_index: a.stageIndex,
        })),
        sage_mode: options.sageMode ?? SageMode.BETWEEN_ALL,
        sage_positions: options.sagePositions,
        buffer_ms: options.bufferMs ?? 0,
        domain_context: options.domainContext,
      });

      if (res.ok) {
        this.registeredWorkflows.add(key);
      }
    } catch (err) {
      // Fail open: workflow continues even if registration fails
      console.warn('[Syrin SDK] Workflow registration failed (fail-open):', err);
    }
  }

  /**
   * Record a handoff from fromAgentId to toAgentId.
   * Returns recovery action if SAGE detects drift synchronously (bufferMs > 0).
   * For async mode (bufferMs=0), use getPendingRecovery() after the handoff.
   */
  async handoff(
    sessionId: string,
    workflowId: string,
    fromAgentId: string,
    toAgentId: string,
    stageOutput: string,
    fromStage: number,
    toStage: number,
  ): Promise<HandoffResult> {
    // Initialize session state
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        workflowId,
        pendingRecovery: new Map(),
        handoffIds: [],
        lastAgentId: null,
        stageCounter: 0,
      });
    }
    const state = this.sessions.get(sessionId)!;

    try {
      const res = await this.post(HANDOFFS_PATH, {
        workflow_id: workflowId,
        session_id: sessionId,
        from_agent_id: fromAgentId,
        to_agent_id: toAgentId,
        from_stage: fromStage,
        to_stage: toStage,
        stage_output: stageOutput,
      });

      if (!res.ok) {
        return { handoffId: null, sageStatus: SageStatus.FAILED, driftDetected: null, recoveryAction: null };
      }

      const data = res.data as {
        handoff_id: string | null;
        sage_status: string;
        drift_detected: boolean | null;
        recovery_action: { type: string; injection_text: string; agent_id: string; stage_index: number } | null;
      };

      if (data.handoff_id) state.handoffIds.push(data.handoff_id);

      const recoveryAction = data.recovery_action
        ? ({
            type: data.recovery_action.type as RecoveryAction['type'],
            injectionText: data.recovery_action.injection_text,
            agentId: data.recovery_action.agent_id,
            stageIndex: data.recovery_action.stage_index,
          } satisfies RecoveryAction)
        : null;

      // Store pending recovery for the receiving agent
      if (recoveryAction?.injectionText) {
        state.pendingRecovery.set(toAgentId, recoveryAction);
      }

      // If async mode, start background polling
      if (data.sage_status === SageStatus.PENDING && data.handoff_id) {
        this.pollHandoffResult(sessionId, data.handoff_id, toAgentId).catch(() => {
          // Fail open
        });
      }

      return {
        handoffId: data.handoff_id,
        sageStatus: data.sage_status as HandoffResult['sageStatus'],
        driftDetected: data.drift_detected,
        recoveryAction,
      };
    } catch (err) {
      console.warn('[Syrin SDK] Handoff notification failed (fail-open):', err);
      return { handoffId: null, sageStatus: SageStatus.FAILED, driftDetected: null, recoveryAction: null };
    }
  }

  /**
   * Get any pending recovery injection for an agent before it starts.
   * Call this at the start of each agent execution to inject corrections.
   * Returns null if no recovery is pending.
   */
  getPendingRecovery(sessionId: string, agentId: string): RecoveryAction | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const recovery = state.pendingRecovery.get(agentId) ?? null;
    if (recovery) state.pendingRecovery.delete(agentId); // consume once
    return recovery;
  }

  /**
   * Build a system prompt injection string for an agent given any pending recovery.
   * Returns null if no injection needed.
   */
  buildInjectionPrompt(sessionId: string, agentId: string): string | null {
    const recovery = this.getPendingRecovery(sessionId, agentId);
    return recovery?.injectionText ?? null;
  }

  /** Clear session state when workflow completes. */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Poll for SAGE result in background. Stores recovery if drift detected. */
  private async pollHandoffResult(
    sessionId: string,
    handoffId: string,
    toAgentId: string,
  ): Promise<void> {
    const MAX_POLLS = 60; // 60 * 500ms = 30s max
    let polls = 0;

    while (polls < MAX_POLLS) {
      await sleep(500);
      polls++;

      try {
        const res = await this.get(HANDOFF_RESULT_PATH.replace('{handoffId}', handoffId));
        if (!res.ok) break;

        const data = res.data as {
          status: string;
          result: {
            drift_detected: boolean;
            recovery_action: { type: string; injection_text: string; agent_id: string; stage_index: number } | null;
          } | null;
        };

        if (data.status === SageStatus.PENDING || data.status === SageStatus.RUNNING) continue;

        const state = this.sessions.get(sessionId);
        if (!state) break;

        if (data.result?.drift_detected && data.result.recovery_action?.injection_text) {
          const ra = data.result.recovery_action;
          state.pendingRecovery.set(toAgentId, {
            type: ra.type as RecoveryAction['type'],
            injectionText: ra.injection_text,
            agentId: ra.agent_id,
            stageIndex: ra.stage_index,
          });
        }
        break;
      } catch {
        break; // Fail open
      }
    }
  }

  private async post(path: string, body: unknown): Promise<{ ok: boolean; data: unknown }> {
    const baseUrl = (this.config.backendUrl ?? 'http://localhost:4000').replace(/\/$/, '');
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey ?? ''}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[Syrin SDK] POST ${path} failed (${res.status}): ${text}`);
      return { ok: false, data: null };
    }

    const data = await res.json();
    return { ok: true, data };
  }

  private async get(path: string): Promise<{ ok: boolean; data: unknown }> {
    const baseUrl = (this.config.backendUrl ?? 'http://localhost:4000').replace(/\/$/, '');
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.apiKey ?? ''}`,
      },
    });

    if (!res.ok) return { ok: false, data: null };
    const data = await res.json();
    return { ok: true, data };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
