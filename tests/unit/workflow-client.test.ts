import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkflowClient } from '../../src/core/workflow-client.js';
import type { SyrinConfig } from '../../src/types.js';

const BASE_CONFIG: SyrinConfig = {
  apiKey: 'syrin_test_key',
  backendUrl: 'http://localhost:4000',
  agentId: 'test-agent',
};

function makeClient(config: Partial<SyrinConfig> = {}): WorkflowClient {
  return new WorkflowClient({ ...BASE_CONFIG, ...config });
}

// Mock global fetch
function mockFetch(responses: Array<{ ok: boolean; data: unknown }>) {
  let callIndex = 0;
  global.fetch = vi.fn().mockImplementation(async () => {
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: response.ok,
      status: response.ok ? 200 : 500,
      text: async () => JSON.stringify(response.data),
      json: async () => response.data,
    };
  }) as any;
}

describe('WorkflowClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('registerWorkflow()', () => {
    it('POSTs to /api/v1/workflows', async () => {
      mockFetch([{ ok: true, data: { ok: true, workflow: { workflowId: 'wf-001' } } }]);
      const client = makeClient();

      await client.registerWorkflow({
        workflowId: 'wf-001',
        name: 'Research Pipeline',
        goal: 'Produce a report',
        agents: [
          { agentId: 'researcher', role: 'Researcher', stageIndex: 0 },
          { agentId: 'analyst', role: 'Analyst', stageIndex: 1 },
        ],
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = (global.fetch as any).mock.calls[0];
      expect(url).toContain('/api/v1/workflows');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body);
      expect(body.workflow_id).toBe('wf-001');
      expect(body.agents).toHaveLength(2);
      expect(body.sage_mode).toBe('between-all');
    });

    it('is idempotent — only posts once per workflow', async () => {
      mockFetch([{ ok: true, data: { ok: true, workflow: {} } }]);
      const client = makeClient();

      await client.registerWorkflow({ workflowId: 'wf-idem', name: 'Test', agents: [] });
      await client.registerWorkflow({ workflowId: 'wf-idem', name: 'Test', agents: [] });

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('fails open on network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('network error')) as any;
      const client = makeClient();

      // Should not throw
      await expect(
        client.registerWorkflow({ workflowId: 'wf-fail', name: 'Test', agents: [] }),
      ).resolves.toBeUndefined();
    });
  });

  describe('handoff()', () => {
    it('POSTs to /api/v1/handoffs with correct payload', async () => {
      mockFetch([
        {
          ok: true,
          data: { ok: true, handoff_id: 'hid-001', sage_status: 'pending', drift_detected: null, recovery_action: null },
        },
      ]);
      const client = makeClient();

      const result = await client.handoff(
        'ses-001',
        'wf-001',
        'researcher',
        'analyst',
        'Research output here',
        0,
        1,
      );

      expect(result.handoffId).toBe('hid-001');
      expect(result.sageStatus).toBe('pending');
      expect(result.driftDetected).toBeNull();
      expect(result.recoveryAction).toBeNull();

      const [url, opts] = (global.fetch as any).mock.calls[0];
      expect(url).toContain('/api/v1/handoffs');
      const body = JSON.parse(opts.body);
      expect(body.session_id).toBe('ses-001');
      expect(body.from_agent_id).toBe('researcher');
      expect(body.to_agent_id).toBe('analyst');
    });

    it('returns recovery action when drift detected synchronously', async () => {
      mockFetch([
        {
          ok: true,
          data: {
            ok: true,
            handoff_id: 'hid-drift',
            sage_status: 'completed',
            drift_detected: true,
            recovery_action: {
              type: 'INJECT',
              injection_text: 'CORRECTION: Stay aligned with your goal.',
              agent_id: 'analyst',
              stage_index: 1,
            },
          },
        },
      ]);
      const client = makeClient();

      const result = await client.handoff(
        'ses-drift',
        'wf-001',
        'researcher',
        'analyst',
        'Deviated output',
        0,
        1,
      );

      expect(result.driftDetected).toBe(true);
      expect(result.recoveryAction).not.toBeNull();
      expect(result.recoveryAction!.type).toBe('INJECT');
      expect(result.recoveryAction!.injectionText).toContain('CORRECTION');
    });

    it('stores pending recovery for next agent', async () => {
      mockFetch([
        {
          ok: true,
          data: {
            ok: true,
            handoff_id: 'hid-store',
            sage_status: 'completed',
            drift_detected: true,
            recovery_action: {
              type: 'INJECT',
              injection_text: 'CORRECTION: Fix your output.',
              agent_id: 'analyst',
              stage_index: 1,
            },
          },
        },
      ]);
      const client = makeClient();

      await client.handoff('ses-store', 'wf-001', 'researcher', 'analyst', 'bad output', 0, 1);

      const injection = client.buildInjectionPrompt('ses-store', 'analyst');
      expect(injection).toBe('CORRECTION: Fix your output.');

      // Consumed — second call returns null
      const injection2 = client.buildInjectionPrompt('ses-store', 'analyst');
      expect(injection2).toBeNull();
    });

    it('fails open on network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('network error')) as any;
      const client = makeClient();

      const result = await client.handoff('ses', 'wf', 'a1', 'a2', 'output', 0, 1);
      expect(result.sageStatus).toBe('failed');
      expect(result.handoffId).toBeNull();
    });
  });

  describe('getPendingRecovery()', () => {
    it('returns null when no recovery pending', () => {
      const client = makeClient();
      expect(client.getPendingRecovery('ses-empty', 'analyst')).toBeNull();
    });

    it('returns and clears pending recovery', async () => {
      mockFetch([
        {
          ok: true,
          data: {
            ok: true,
            handoff_id: 'hid-pend',
            sage_status: 'completed',
            drift_detected: true,
            recovery_action: {
              type: 'INJECT',
              injection_text: 'CORRECTION: Fix it.',
              agent_id: 'analyst',
              stage_index: 1,
            },
          },
        },
      ]);
      const client = makeClient();
      await client.handoff('ses-pend', 'wf', 'r', 'analyst', 'bad', 0, 1);

      const recovery = client.getPendingRecovery('ses-pend', 'analyst');
      expect(recovery).not.toBeNull();
      expect(recovery!.injectionText).toContain('CORRECTION');

      // Cleared
      expect(client.getPendingRecovery('ses-pend', 'analyst')).toBeNull();
    });
  });

  describe('clearSession()', () => {
    it('removes session state', async () => {
      mockFetch([
        { ok: true, data: { ok: true, handoff_id: 'h1', sage_status: 'pending', drift_detected: null, recovery_action: null } },
      ]);
      const client = makeClient();
      await client.handoff('ses-clear', 'wf', 'a1', 'a2', 'out', 0, 1);

      client.clearSession('ses-clear');
      expect(client.getPendingRecovery('ses-clear', 'a2')).toBeNull();
    });
  });
});
