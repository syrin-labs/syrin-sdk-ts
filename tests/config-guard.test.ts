/**
 * Tests: src/config-guard.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConfigGuard,
  ConfigFuse,
  AnchorStore,
  AutoRevert,
  DEFAULT_RECOVERY_POLICY,
  type RecoveryPolicy,
} from '@/config-guard';
import { ConfigStore } from '@/config-store';
import { TunableRegistry } from '@/tunable';

function makeStore(): ConfigStore {
  const store = new ConfigStore();
  return store;
}

function makeRegistry(): TunableRegistry {
  return new TunableRegistry();
}

function makeGuard(policyOverrides: Partial<RecoveryPolicy> = {}, healthCheck?: () => void): ConfigGuard {
  return new ConfigGuard(makeStore(), makeRegistry(), policyOverrides, healthCheck);
}

// ─── ConfigFuse ───────────────────────────────────────────────────────────────

describe('ConfigFuse', () => {
  it('fuse blows after threshold failures', () => {
    const policy = { ...DEFAULT_RECOVERY_POLICY, fuseThreshold: 3 };
    const fuse = new ConfigFuse(policy);
    expect(fuse.state).toBe('CLOSED');
    fuse.recordFailure();
    fuse.recordFailure();
    expect(fuse.state).toBe('CLOSED');
    fuse.recordFailure();
    expect(fuse.state).toBe('OPEN');
  });

  it('fuse OPEN rejects — isAccepting returns false', () => {
    const policy = { ...DEFAULT_RECOVERY_POLICY, fuseThreshold: 1 };
    const fuse = new ConfigFuse(policy);
    expect(fuse.isAccepting()).toBe(true);
    fuse.recordFailure();
    expect(fuse.state).toBe('OPEN');
    expect(fuse.isAccepting()).toBe(false);
  });

  it('fuse HALF_OPEN after reset timeout', () => {
    let now = 0;
    const policy = { ...DEFAULT_RECOVERY_POLICY, fuseThreshold: 1, fuseResetSeconds: 10 };
    const fuse = new ConfigFuse(policy, () => now);
    fuse.recordFailure();
    expect(fuse.state).toBe('OPEN');
    now = 15_000; // past the reset window
    expect(fuse.state).toBe('HALF_OPEN');
    expect(fuse.isAccepting()).toBe(true);
  });

  it('fuse closes on success from HALF_OPEN', () => {
    let now = 0;
    const policy = { ...DEFAULT_RECOVERY_POLICY, fuseThreshold: 1, fuseResetSeconds: 10 };
    const fuse = new ConfigFuse(policy, () => now);
    fuse.recordFailure();
    now = 15_000;
    expect(fuse.state).toBe('HALF_OPEN');
    fuse.recordSuccess();
    expect(fuse.state).toBe('CLOSED');
    expect(fuse.consecutiveFailures).toBe(0);
  });

  it('manual blow sets state to OPEN', () => {
    const policy = { ...DEFAULT_RECOVERY_POLICY, fuseThreshold: 100 };
    const fuse = new ConfigFuse(policy);
    fuse.blow('manual reason');
    expect(fuse.state).toBe('OPEN');
  });

  it('manualReset sets state to CLOSED', () => {
    const policy = { ...DEFAULT_RECOVERY_POLICY, fuseThreshold: 1 };
    const fuse = new ConfigFuse(policy);
    fuse.recordFailure();
    expect(fuse.state).toBe('OPEN');
    fuse.manualReset();
    expect(fuse.state).toBe('CLOSED');
    expect(fuse.consecutiveFailures).toBe(0);
  });
});

// ─── AnchorStore ─────────────────────────────────────────────────────────────

describe('AnchorStore', () => {
  it('manual anchor and restore', () => {
    const store = makeStore();
    store.set('llm', 'temperature', 0.7);
    const anchors = new AnchorStore(store);

    const anchor = anchors.take('manual');
    expect(anchor.anchorId).toBeDefined();
    expect(anchor.reason).toBe('manual');
    expect(anchor.values['llm.temperature']).toBe(0.7);

    store.set('llm', 'temperature', 1.5);
    anchors.restore(anchor.anchorId);
    expect(store.get('llm', 'temperature')).toBe(0.7);
  });

  it('anchorStore max anchors — oldest dropped', () => {
    const store = makeStore();
    const anchors = new AnchorStore(store, 3);

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const a = anchors.take(`manual_${i}`);
      ids.push(a.anchorId);
    }

    const list = anchors.list();
    expect(list.length).toBe(3);
    // Oldest (ids[0], ids[1]) should be gone
    expect(anchors.get(ids[0])).toBeUndefined();
    expect(anchors.get(ids[1])).toBeUndefined();
    // Newest should remain
    expect(anchors.get(ids[4])).toBeDefined();
  });

  it('restoreLastGood — promoteToLastGood then restore', () => {
    const store = makeStore();
    store.set('llm', 'temperature', 0.5);
    const anchors = new AnchorStore(store);
    const anchor = anchors.take('sessionStart');
    anchors.promoteToLastGood(anchor.anchorId);

    store.set('llm', 'temperature', 1.9);
    const lg = anchors.lastGood();
    expect(lg).toBeDefined();
    expect(lg!.isLastGood).toBe(true);

    anchors.restore(lg!.anchorId);
    expect(store.get('llm', 'temperature')).toBe(0.5);
  });

  it('list returns anchors newest first', () => {
    const store = makeStore();
    const anchors = new AnchorStore(store);
    anchors.take('first');
    anchors.take('second');
    anchors.take('third');
    const list = anchors.list();
    expect(list[0].reason).toBe('third');
    expect(list[list.length - 1].reason).toBe('first');
  });
});

// ─── AutoRevert ───────────────────────────────────────────────────────────────

describe('AutoRevert', () => {
  it('autoRevert shouldRevert within window', () => {
    let now = 0;
    const store = makeStore();
    store.set('llm', 'temperature', 0.7);
    const anchors = new AnchorStore(store);
    const policy = { ...DEFAULT_RECOVERY_POLICY, crashWindowSeconds: 30 };
    const revert = new AutoRevert(anchors, policy, undefined, () => now);

    revert.recordApply();
    now = 10_000; // 10s later — within the 30s window

    expect(revert.shouldRevert(new Error('runtime error'))).toBe(true);
  });

  it('autoRevert no revert outside window', () => {
    let now = 0;
    const store = makeStore();
    const anchors = new AnchorStore(store);
    const policy = { ...DEFAULT_RECOVERY_POLICY, crashWindowSeconds: 5 };
    const revert = new AutoRevert(anchors, policy, undefined, () => now);

    revert.recordApply();
    now = 10_000; // 10s later — past the 5s window

    expect(revert.shouldRevert(new Error('runtime error'))).toBe(false);
  });

  it('autoRevert doRevert restores last_good anchor', () => {
    const store = makeStore();
    store.set('llm', 'temperature', 0.7);
    const anchors = new AnchorStore(store);
    const anchor = anchors.take('sessionStart');
    anchors.promoteToLastGood(anchor.anchorId);

    const policy = { ...DEFAULT_RECOVERY_POLICY };
    const fuse = new ConfigFuse(policy);
    const revert = new AutoRevert(anchors, policy);

    store.set('llm', 'temperature', 1.9);
    revert.doRevert(new Error('crash'), fuse);

    expect(store.get('llm', 'temperature')).toBe(0.7);
  });
});

// ─── ConfigGuard ──────────────────────────────────────────────────────────────

describe('ConfigGuard — safeApply', () => {
  it('safeApply valid value — success=true, applied contains value', () => {
    const guard = makeGuard();
    const result = guard.safeApply('llm', { temperature: 0.5 });
    expect(result.success).toBe(true);
    expect(result.applied['temperature']).toBe(0.5);
    expect(result.rejected).toEqual({});
    expect(result.rolledBack).toBe(false);
  });

  it('safeApply invalid type — rejected, success=false', () => {
    const guard = makeGuard();
    const result = guard.safeApply('llm', { temperature: 'too_hot' });
    expect(result.success).toBe(false);
    expect(Object.keys(result.rejected)).toContain('temperature');
  });

  it('safeApply partial rejection — bad field rejected, rest applied', () => {
    const guard = makeGuard({ onValidationFail: 'rejectField' });
    const result = guard.safeApply('llm', { temperature: 0.7, max_tokens: 'bad' });
    expect(result.applied['temperature']).toBe(0.7);
    expect(Object.keys(result.rejected)).toContain('max_tokens');
  });

  it('safeApply rejectAll policy — entire payload rejected on any failure', () => {
    const guard = makeGuard({ onValidationFail: 'rejectAll' });
    const result = guard.safeApply('llm', { temperature: 0.7, max_tokens: 'bad' });
    expect(result.success).toBe(false);
    expect(Object.keys(result.applied)).toHaveLength(0);
    expect(result.rolledBack).toBe(true);
  });

  it('anchor taken before apply', () => {
    const guard = makeGuard();
    guard.safeApply('llm', { temperature: 0.5 });
    const anchors = guard.listAnchors();
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[0].reason).toBe('preApply');
  });

  it('rollback on healthCheck failure', () => {
    let callCount = 0;
    const healthCheck = () => {
      callCount++;
      if (callCount === 1) throw new Error('health check failed');
    };
    const guard = makeGuard({ onApplyError: 'rollback' }, healthCheck);
    const result = guard.safeApply('llm', { temperature: 0.5 });
    expect(result.rolledBack).toBe(true);
  });

  it('rollback on setattr exception — rolledBack=true, values restored', () => {
    const store = makeStore();
    store.set('llm', 'temperature', 0.7);
    const registry = makeRegistry();
    const snap = store.snapshot();

    // Intercept set to throw after we snapshot
    let throwOnSet = false;
    const origSet = store.set.bind(store);
    store.set = (ns: string, field: string, value: unknown) => {
      if (throwOnSet) throw new Error('store error');
      origSet(ns, field, value);
    };

    const guard = new ConfigGuard(store, registry, { onApplyError: 'rollback' });
    throwOnSet = true;

    const result = guard.safeApply('llm', { temperature: 0.5 });
    expect(result.rolledBack).toBe(true);
  });
});

describe('ConfigGuard — fuse management', () => {
  it('fuse blows after threshold failures', () => {
    const guard = makeGuard({ fuseThreshold: 3, onValidationFail: 'rejectAll' });
    // Force failures
    for (let i = 0; i < 3; i++) {
      guard.safeApply('llm', { temperature: 'bad' });
    }
    const fs = guard.fuseState();
    expect(fs.state).toBe('OPEN');
  });

  it('fuse OPEN rejects apply', () => {
    const guard = makeGuard({ fuseThreshold: 1, onValidationFail: 'rejectAll' });
    guard.safeApply('llm', { temperature: 'bad' }); // blow fuse
    const result = guard.safeApply('llm', { temperature: 0.5 });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/fuse/i);
  });

  it('fuseState returns correct dict', () => {
    const guard = makeGuard({ fuseThreshold: 3, onValidationFail: 'rejectAll' });
    guard.safeApply('llm', { temperature: 'bad' });
    const fs = guard.fuseState();
    expect(fs.consecutiveFailures).toBe(1);
    expect(fs.state).toBe('CLOSED');
  });

  it('resetFuse sets state to CLOSED', () => {
    const guard = makeGuard({ fuseThreshold: 1, onValidationFail: 'rejectAll' });
    guard.safeApply('llm', { temperature: 'bad' });
    expect(guard.fuseState().state).toBe('OPEN');
    guard.resetFuse();
    expect(guard.fuseState().state).toBe('CLOSED');
  });
});

describe('ConfigGuard — anchors', () => {
  it('restoreLastGood', () => {
    const store = makeStore();
    store.set('llm', 'temperature', 0.7);
    const guard = new ConfigGuard(store, makeRegistry());

    // Good state — take anchor and promote
    guard.takeAnchor('sessionStart');
    guard.promoteLastGood();

    // Bad state
    store.set('llm', 'temperature', 1.9);
    guard.restoreLastGood();

    expect(store.get('llm', 'temperature')).toBe(0.7);
  });

  it('manual anchor and restore via guard', () => {
    const store = makeStore();
    store.set('llm', 'temperature', 0.5);
    const guard = new ConfigGuard(store, makeRegistry());

    const anchor = guard.takeAnchor('manual');
    store.set('llm', 'temperature', 1.5);
    guard.restoreAnchor(anchor.anchorId);
    expect(store.get('llm', 'temperature')).toBe(0.5);
  });
});

describe('ConfigGuard — safeApplyBatch', () => {
  it('safeApplyBatch groups by namespace', () => {
    const store = makeStore();
    const guard = new ConfigGuard(store, makeRegistry());
    const results = guard.safeApplyBatch({
      'llm.temperature': 0.7,
      'llm.max_tokens': 1024,
      'langgraph.recursion_limit': 50,
    });
    // Should produce results per namespace
    expect(results.length).toBeGreaterThan(0);
    const namespaces = results.map(r => r.namespace);
    expect(namespaces).toContain('llm');
    expect(namespaces).toContain('langgraph');
  });
});
