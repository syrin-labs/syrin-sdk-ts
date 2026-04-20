/**
 * Tests: ConfigStore v2 features
 *   Feature 1 — Allowlist / Blocklist
 *   Feature 2 — Immutable Anchors
 *   Feature 3 — Version History
 *   Feature 4 — Audit Log
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigStore } from '@/config/store';
import type { ConfigVersion, AuditEntry } from '@/config/store';

// ---------------------------------------------------------------------------
// Feature 1 — Allowlist / Blocklist
// ---------------------------------------------------------------------------

describe('ConfigStore — Allowlist / Blocklist', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('allowlist empty allows all keys', () => {
    const rejected = store.applyUpdates({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o' });
    expect(rejected).toEqual({});
    expect(store.get('llm', 'temperature')).toBe(0.5);
    expect(store.get('llm', 'model')).toBe('gpt-4o');
  });

  it('allowlist set allows only listed keys', () => {
    store.setAllowlist(new Set(['llm.temperature']));
    const rejected = store.applyUpdates({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o' });
    expect(rejected).toEqual({});
    expect(store.get('llm', 'temperature')).toBe(0.5);
    expect(store.get('llm', 'model')).toBeNull(); // not allowed, silently skipped
  });

  it('allowlist blocks unlisted keys silently (not in rejected)', () => {
    store.setAllowlist(new Set(['llm.temperature']));
    const rejected = store.applyUpdates({ 'llm.model': 'gpt-4o' });
    expect(rejected).toEqual({});
    expect(store.get('llm', 'model')).toBeNull();
  });

  it('blocklist blocks listed keys silently', () => {
    store.setBlocklist(new Set(['llm.model']));
    const rejected = store.applyUpdates({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o' });
    expect(rejected).toEqual({});
    expect(store.get('llm', 'temperature')).toBe(0.5);
    expect(store.get('llm', 'model')).toBeNull();
  });

  it('blocklist overrides allowlist (key in both → blocked, not in rejected)', () => {
    store.setAllowlist(new Set(['llm.temperature', 'llm.model']));
    store.setBlocklist(new Set(['llm.model']));
    const rejected = store.applyUpdates({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o' });
    expect(rejected).toEqual({});
    expect(store.get('llm', 'temperature')).toBe(0.5);
    expect(store.get('llm', 'model')).toBeNull();
  });

  it('setAllowlist replaces previous allowlist', () => {
    store.setAllowlist(new Set(['llm.temperature']));
    store.setAllowlist(new Set(['llm.model']));
    const rejected = store.applyUpdates({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o' });
    expect(rejected).toEqual({});
    expect(store.get('llm', 'temperature')).toBeNull(); // old allowlist entry no longer valid
    expect(store.get('llm', 'model')).toBe('gpt-4o');
  });

  it('setBlocklist replaces previous blocklist', () => {
    store.setBlocklist(new Set(['llm.temperature']));
    store.setBlocklist(new Set(['llm.model']));
    const rejected = store.applyUpdates({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o' });
    expect(rejected).toEqual({});
    expect(store.get('llm', 'temperature')).toBe(0.5); // old blocklist no longer active
    expect(store.get('llm', 'model')).toBeNull();
  });

  it('getAllowlist returns current set', () => {
    const al = new Set(['llm.temperature', 'llm.model']);
    store.setAllowlist(al);
    const returned = store.getAllowlist();
    expect(returned.has('llm.temperature')).toBe(true);
    expect(returned.has('llm.model')).toBe(true);
    expect(returned.size).toBe(2);
  });

  it('getBlocklist returns current set', () => {
    const bl = new Set(['llm.model']);
    store.setBlocklist(bl);
    const returned = store.getBlocklist();
    expect(returned.has('llm.model')).toBe(true);
    expect(returned.size).toBe(1);
  });

  it('direct set() not filtered by allowlist or blocklist', () => {
    store.setAllowlist(new Set(['llm.temperature']));
    store.setBlocklist(new Set(['llm.model']));
    store.set('llm', 'model', 'gpt-4o-mini');
    expect(store.get('llm', 'model')).toBe('gpt-4o-mini');
  });

  it('blocked keys do not appear in returned rejected map', () => {
    store.setBlocklist(new Set(['llm.model']));
    const rejected = store.applyUpdates({ 'llm.model': 'gpt-4o' });
    expect('llm.model' in rejected).toBe(false);
    expect(Object.keys(rejected)).toHaveLength(0);
  });

  it('allowlist with valid and blocked key → only valid applied', () => {
    store.setAllowlist(new Set(['llm.temperature']));
    store.setBlocklist(new Set(['llm.temperature'])); // blocklist wins
    const rejected = store.applyUpdates({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o' });
    expect(rejected).toEqual({});
    expect(store.get('llm', 'temperature')).toBeNull(); // blocked
    expect(store.get('llm', 'model')).toBeNull(); // not in allowlist
  });
});

// ---------------------------------------------------------------------------
// Feature 2 — Immutable Anchors
// ---------------------------------------------------------------------------

describe('ConfigStore — Immutable Anchors', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('anchor sets value immediately', () => {
    store.anchor('llm.temperature', 0.3);
    expect(store.get('llm', 'temperature')).toBe(0.3);
  });

  it('anchor blocks applyUpdates for anchored key (appears in rejected, value preserved)', () => {
    store.anchor('llm.temperature', 0.3);
    const rejected = store.applyUpdates({ 'llm.temperature': 0.9 });
    expect(Object.keys(rejected)).toContain('llm.temperature');
    expect(store.get('llm', 'temperature')).toBe(0.3); // unchanged
  });

  it('unanchor allows key to be updated again', () => {
    store.anchor('llm.temperature', 0.3);
    store.unanchor('llm.temperature');
    const rejected = store.applyUpdates({ 'llm.temperature': 0.9 });
    expect(rejected).toEqual({});
    expect(store.get('llm', 'temperature')).toBe(0.9);
  });

  it('getAnchors returns all active anchors', () => {
    store.anchor('llm.temperature', 0.3);
    store.anchor('llm.model', 'gpt-4o');
    const anchors = store.getAnchors();
    expect(anchors['llm.temperature']).toBe(0.3);
    expect(anchors['llm.model']).toBe('gpt-4o');
  });

  it('isAnchored returns true for anchored key', () => {
    store.anchor('llm.temperature', 0.3);
    expect(store.isAnchored('llm.temperature')).toBe(true);
  });

  it('isAnchored returns false for unanchored key', () => {
    expect(store.isAnchored('llm.temperature')).toBe(false);
  });

  it('direct set() not blocked by anchor', () => {
    store.anchor('llm.temperature', 0.3);
    store.set('llm', 'temperature', 0.9);
    expect(store.get('llm', 'temperature')).toBe(0.9);
  });

  it('multiple anchors all respected', () => {
    store.anchor('llm.temperature', 0.1);
    store.anchor('llm.model', 'gpt-4o');
    store.anchor('langgraph.recursion_limit', 5);
    const rejected = store.applyUpdates({
      'llm.temperature': 0.9,
      'llm.model': 'gpt-3.5-turbo',
      'langgraph.recursion_limit': 50,
    });
    expect(Object.keys(rejected)).toContain('llm.temperature');
    expect(Object.keys(rejected)).toContain('llm.model');
    expect(Object.keys(rejected)).toContain('langgraph.recursion_limit');
    expect(store.get('llm', 'temperature')).toBe(0.1);
    expect(store.get('llm', 'model')).toBe('gpt-4o');
    expect(store.get('langgraph', 'recursion_limit')).toBe(5);
  });

  it('anchor with unknown namespace does not crash', () => {
    expect(() => store.anchor('unknown_ns.field', 'value')).not.toThrow();
  });

  it('unanchor nonexistent key is no-op', () => {
    expect(() => store.unanchor('llm.temperature')).not.toThrow();
    expect(store.isAnchored('llm.temperature')).toBe(false);
  });

  it('getAnchors returns defensive copy (mutation does not affect store)', () => {
    store.anchor('llm.temperature', 0.3);
    const anchors = store.getAnchors();
    (anchors as Record<string, unknown>)['llm.temperature'] = 0.9;
    expect(store.getAnchors()['llm.temperature']).toBe(0.3);
  });

  it('anchor takes priority over blocklist (anchor in rejected, value preserved)', () => {
    store.anchor('llm.temperature', 0.3);
    store.setBlocklist(new Set(['llm.temperature']));
    // Anchor check runs first — appears in rejected, value preserved
    const rejected = store.applyUpdates({ 'llm.temperature': 0.9 });
    expect(Object.keys(rejected)).toContain('llm.temperature');
    expect(store.get('llm', 'temperature')).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// Feature 3 — Version History
// ---------------------------------------------------------------------------

describe('ConfigStore — Version History', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('history empty on init', () => {
    expect(store.getHistory()).toHaveLength(0);
  });

  it('currentVersionId is 0 on init', () => {
    expect(store.currentVersionId).toBe(0);
  });

  it('applyUpdates records a version', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 });
    expect(store.getHistory()).toHaveLength(1);
  });

  it('applyUpdates does not record version if nothing changed', () => {
    // No matching namespace → nothing changes
    store.applyUpdates({ 'unknown_ns.field': 'value' });
    expect(store.getHistory()).toHaveLength(0);
    expect(store.currentVersionId).toBe(0);
  });

  it('getHistory returns newest first', () => {
    store.applyUpdates({ 'llm.temperature': 0.3 });
    store.applyUpdates({ 'llm.temperature': 0.7 });
    const history = store.getHistory();
    expect(history[0].versionId).toBeGreaterThan(history[1].versionId);
  });

  it('getHistory limit respected', () => {
    store.applyUpdates({ 'llm.temperature': 0.1 });
    store.applyUpdates({ 'llm.temperature': 0.2 });
    store.applyUpdates({ 'llm.temperature': 0.3 });
    const limited = store.getHistory(2);
    expect(limited).toHaveLength(2);
  });

  it('history ring buffer caps at 50 (51st drops oldest)', () => {
    for (let i = 0; i < 51; i++) {
      store.applyUpdates({ 'llm.temperature': (i + 1) / 100 });
    }
    const history = store.getHistory(0); // 0 = no limit, get all
    expect(history.length).toBeLessThanOrEqual(50);
    expect(history.length).toBe(50);
  });

  it('version has correct changedKeys', () => {
    store.applyUpdates({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o' });
    const version = store.getHistory(1)[0];
    expect(version.changedKeys).toContain('llm.temperature');
    expect(version.changedKeys).toContain('llm.model');
  });

  it('version has correct source defaulting to remote', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 });
    const version = store.getHistory(1)[0];
    expect(version.source).toBe('remote');
  });

  it('version has correct custom source', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 }, 'governance');
    const version = store.getHistory(1)[0];
    expect(version.source).toBe('governance');
  });

  it('rollback restores previous state', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 });
    const v1 = store.getHistory(1)[0];
    store.applyUpdates({ 'llm.temperature': 0.9 });
    expect(store.get('llm', 'temperature')).toBe(0.9);
    store.rollback(v1.versionId);
    expect(store.get('llm', 'temperature')).toBe(0.5);
  });

  it('rollback returns true when versionId found', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 });
    const v1 = store.getHistory(1)[0];
    expect(store.rollback(v1.versionId)).toBe(true);
  });

  it('rollback returns false for unknown versionId', () => {
    expect(store.rollback(99999)).toBe(false);
  });

  it('currentVersionId increments on each apply', () => {
    expect(store.currentVersionId).toBe(0);
    store.applyUpdates({ 'llm.temperature': 0.3 });
    expect(store.currentVersionId).toBe(1);
    store.applyUpdates({ 'llm.temperature': 0.5 });
    expect(store.currentVersionId).toBe(2);
  });

  it('version snapshot is a deep copy (mutation safe)', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 });
    const version = store.getHistory(1)[0];
    const snap = version.snapshot as Record<string, unknown>;
    snap['llm.temperature'] = 9999;
    // Re-fetch: should still be 0.5 in the stored version
    const refetched = store.getHistory(1)[0];
    expect(refetched.snapshot['llm.temperature']).toBe(0.5);
  });

  it('rollback does not add a new history entry', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 });
    store.applyUpdates({ 'llm.temperature': 0.9 });
    const countBefore = store.getHistory().length;
    const v1 = store.getHistory()[1]; // oldest
    store.rollback(v1.versionId);
    expect(store.getHistory().length).toBe(countBefore);
  });

  it('blocked/anchored keys not in changedKeys', () => {
    store.setBlocklist(new Set(['llm.model']));
    store.anchor('llm.system_prompt', 'stay safe');
    store.applyUpdates({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o', 'llm.system_prompt': 'new prompt' });
    const version = store.getHistory(1)[0];
    expect(version.changedKeys).toContain('llm.temperature');
    expect(version.changedKeys).not.toContain('llm.model');
    expect(version.changedKeys).not.toContain('llm.system_prompt');
  });
});

// ---------------------------------------------------------------------------
// Feature 4 — Audit Log
// ---------------------------------------------------------------------------

describe('ConfigStore — Audit Log', () => {
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore();
  });

  it('audit log empty on init', () => {
    expect(store.getAuditLog()).toHaveLength(0);
  });

  it('applyUpdates creates audit entry per changed field', () => {
    store.applyUpdates({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o' });
    const log = store.getAuditLog();
    expect(log).toHaveLength(2);
  });

  it('audit entry has correct key, oldValue, newValue', () => {
    store.set('llm', 'temperature', 0.7);
    store.applyUpdates({ 'llm.temperature': 0.5 });
    const entry = store.getAuditLog().find(e => e.key === 'llm.temperature');
    expect(entry).toBeDefined();
    expect(entry!.key).toBe('llm.temperature');
    expect(entry!.oldValue).toBe(0.7);
    expect(entry!.newValue).toBe(0.5);
  });

  it('audit entry has correct timestamp (ISO string)', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 });
    const entry = store.getAuditLog()[0];
    expect(typeof entry.timestamp).toBe('string');
    expect(() => new Date(entry.timestamp)).not.toThrow();
    // Should be a valid ISO date
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  it('audit entry source is remote by default', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 });
    const entry = store.getAuditLog()[0];
    expect(entry.source).toBe('remote');
  });

  it('audit entry custom source respected', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 }, 'governance');
    const entry = store.getAuditLog()[0];
    expect(entry.source).toBe('governance');
  });

  it('null update logged with newValue = schema default', () => {
    store.set('llm', 'temperature', 0.9);
    store.applyUpdates({ 'llm.temperature': null });
    const entry = store.getAuditLog().find(e => e.key === 'llm.temperature');
    expect(entry).toBeDefined();
    expect(entry!.oldValue).toBe(0.9);
    expect(entry!.newValue).toBeNull(); // llm.temperature default is null
  });

  it('blocked keys not logged', () => {
    store.setBlocklist(new Set(['llm.model']));
    store.applyUpdates({ 'llm.temperature': 0.5, 'llm.model': 'gpt-4o' });
    const log = store.getAuditLog();
    const modelEntry = log.find(e => e.key === 'llm.model');
    expect(modelEntry).toBeUndefined();
  });

  it('anchored keys not logged', () => {
    store.anchor('llm.temperature', 0.3);
    store.applyUpdates({ 'llm.temperature': 0.9 });
    const log = store.getAuditLog();
    // The anchor() call itself doesn't log; update attempt is skipped (not logged)
    const tempEntries = log.filter(e => e.key === 'llm.temperature');
    expect(tempEntries).toHaveLength(0);
  });

  it('unknown namespace not logged', () => {
    store.applyUpdates({ 'unknown_ns.field': 'value' });
    expect(store.getAuditLog()).toHaveLength(0);
  });

  it('getAuditLog returns newest first', () => {
    store.applyUpdates({ 'llm.temperature': 0.3 });
    store.applyUpdates({ 'llm.temperature': 0.7 });
    const log = store.getAuditLog();
    expect(log[0].newValue).toBe(0.7);
    expect(log[1].newValue).toBe(0.3);
  });

  it('getAuditLog limit respected', () => {
    store.applyUpdates({ 'llm.temperature': 0.1 });
    store.applyUpdates({ 'llm.temperature': 0.2 });
    store.applyUpdates({ 'llm.temperature': 0.3 });
    const limited = store.getAuditLog(2);
    expect(limited).toHaveLength(2);
  });

  it('audit log caps at 1000 entries (oldest dropped)', () => {
    // Apply 600 updates each with 2 fields = 1200 entries; should cap at 1000
    for (let i = 0; i < 600; i++) {
      store.applyUpdates({
        'llm.temperature': (i % 20) / 20,
        'llm.max_tokens': (i + 1) * 10,
      });
    }
    const log = store.getAuditLog(0);
    expect(log.length).toBe(1000);
  });

  it('clearAuditLog empties the log', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 });
    store.clearAuditLog();
    expect(store.getAuditLog()).toHaveLength(0);
  });

  it('validation failure not logged (rejected field not logged)', () => {
    store.applyUpdates({ 'llm.temperature': 'not-a-number' });
    expect(store.getAuditLog()).toHaveLength(0);
  });

  it('getAuditLog returns copy (mutation safe)', () => {
    store.applyUpdates({ 'llm.temperature': 0.5 });
    const log = store.getAuditLog();
    (log as AuditEntry[])[0] = { key: 'hacked', oldValue: null, newValue: null, source: 'x', timestamp: '' };
    expect(store.getAuditLog()[0].key).toBe('llm.temperature');
  });
});
