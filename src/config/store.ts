/**
 * Syrin SDK — ConfigStore
 *
 * Manages per-section configuration with schema validation, defaults,
 * snapshot/restore, and export for the /agents/{id}/register endpoint.
 *
 * v2 additions:
 *   Feature 1 — Allowlist / Blocklist
 *   Feature 2 — Immutable Anchors
 *   Feature 3 — Version History (ring buffer, last 50)
 *   Feature 4 — Audit Log (ring buffer, last 1000)
 */

import { nowIso } from '@/utils/helpers.js';

export interface FieldSchema {
  name: string;
  type: 'number' | 'string' | 'boolean' | 'array' | 'object';
  default: unknown;
  description?: string;
  ge?: number;    // >= constraint
  le?: number;    // <= constraint
  enum?: unknown[];  // allowed values
  required?: boolean;
}

// ---------------------------------------------------------------------------
// Feature 3 — Version History
// ---------------------------------------------------------------------------

export interface ConfigVersion {
  readonly versionId: number;
  readonly timestamp: string;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly changedKeys: readonly string[];
}

// ---------------------------------------------------------------------------
// Feature 4 — Audit Log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  readonly timestamp: string;
  readonly key: string;       // "namespace.field"
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly source: string;    // "remote", "local", "governance", "anchor", "reset"
}

// ---------------------------------------------------------------------------
// Built-in sections
// ---------------------------------------------------------------------------

const BUILTIN_SECTIONS: Record<string, Record<string, FieldSchema>> = {
  llm: {
    temperature:       { name: 'temperature',       type: 'number',  default: null, ge: 0.0, le: 2.0 },
    max_tokens:        { name: 'max_tokens',         type: 'number',  default: null, ge: 1 },
    model:             { name: 'model',              type: 'string',  default: null },
    system_prompt:     { name: 'system_prompt',      type: 'string',  default: null },
    top_p:             { name: 'top_p',              type: 'number',  default: null, ge: 0.0, le: 1.0 },
    frequency_penalty: { name: 'frequency_penalty',  type: 'number',  default: null, ge: -2.0, le: 2.0 },
    presence_penalty:  { name: 'presence_penalty',   type: 'number',  default: null, ge: -2.0, le: 2.0 },
    stop:              { name: 'stop',               type: 'array',   default: null },
    stream:            { name: 'stream',             type: 'boolean', default: null },
  },
  langgraph: {
    recursion_limit:  { name: 'recursion_limit',  type: 'number',  default: 25, ge: 1 },
    interrupt_before: { name: 'interrupt_before', type: 'array',   default: null },
    interrupt_after:  { name: 'interrupt_after',  type: 'array',   default: null },
    max_concurrency:  { name: 'max_concurrency',  type: 'number',  default: null, ge: 1 },
    stream_mode:      { name: 'stream_mode',      type: 'string',  default: null },
    thread_id:        { name: 'thread_id',        type: 'string',  default: null },
  },
  mastra: {
    model:         { name: 'model',         type: 'string',  default: null },
    temperature:   { name: 'temperature',   type: 'number',  default: null },
    max_tokens:    { name: 'max_tokens',    type: 'number',  default: null },
    system_prompt: { name: 'system_prompt', type: 'string',  default: null },
    max_steps:     { name: 'max_steps',     type: 'number',  default: null, ge: 1 },
    toolChoice:    { name: 'toolChoice',    type: 'string',  default: null },
  },
  vercel_ai: {
    model:         { name: 'model',         type: 'string',  default: null },
    temperature:   { name: 'temperature',   type: 'number',  default: null },
    max_tokens:    { name: 'max_tokens',    type: 'number',  default: null },
    system_prompt: { name: 'system_prompt', type: 'string',  default: null },
    max_steps:     { name: 'max_steps',     type: 'number',  default: null, ge: 1 },
    tool_choice:   { name: 'tool_choice',   type: 'string',  default: null },
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 50;
const AUDIT_LIMIT = 1000;

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

export class ConfigStore {
  private _sections: Record<string, Record<string, FieldSchema>>;
  private _values: Record<string, Record<string, unknown>>;

  // Feature 1 — Allowlist / Blocklist
  private _allowlist: Set<string> = new Set();
  private _blocklist: Set<string> = new Set();

  // Feature 2 — Immutable Anchors
  private _anchors: Map<string, unknown> = new Map();

  // Feature 3 — Version History
  private _history: ConfigVersion[] = [];
  private _nextVersionId = 1;

  // Feature 4 — Audit Log
  private _auditLog: AuditEntry[] = [];

  constructor() {
    // Deep-copy BUILTIN_SECTIONS into _sections
    this._sections = {};
    this._values = {};
    for (const [ns, fields] of Object.entries(BUILTIN_SECTIONS)) {
      this._sections[ns] = { ...fields };
      this._values[ns] = {};
      for (const [fieldName, schema] of Object.entries(fields)) {
        this._values[ns][fieldName] = schema.default;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Feature 1 — Allowlist / Blocklist
  // ---------------------------------------------------------------------------

  setAllowlist(keys: ReadonlySet<string>): void {
    this._allowlist = new Set(keys);
  }

  setBlocklist(keys: ReadonlySet<string>): void {
    this._blocklist = new Set(keys);
  }

  getAllowlist(): ReadonlySet<string> {
    return this._allowlist;
  }

  getBlocklist(): ReadonlySet<string> {
    return this._blocklist;
  }

  /**
   * Returns true if the given dot-notation path is permitted for applyUpdates().
   * Anchored keys are checked separately before this method is called.
   * Blocklist wins over allowlist; empty allowlist means all keys pass.
   */
  private _isAllowed(path: string): boolean {
    if (this._blocklist.has(path)) return false;
    if (this._allowlist.size > 0) return this._allowlist.has(path);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Feature 2 — Immutable Anchors
  // ---------------------------------------------------------------------------

  /**
   * Pin a key to a value. Immediately applies the value via set() and blocks
   * future applyUpdates() calls from changing it.
   */
  anchor(key: string, value: unknown): void {
    const dotIdx = key.indexOf('.');
    if (dotIdx !== -1) {
      const namespace = key.substring(0, dotIdx);
      const field = key.substring(dotIdx + 1);
      this.set(namespace, field, value);
    }
    this._anchors.set(key, value);
  }

  unanchor(key: string): void {
    this._anchors.delete(key);
  }

  getAnchors(): Readonly<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of this._anchors) {
      result[k] = v;
    }
    return result;
  }

  isAnchored(key: string): boolean {
    return this._anchors.has(key);
  }

  // ---------------------------------------------------------------------------
  // Feature 3 — Version History
  // ---------------------------------------------------------------------------

  get currentVersionId(): number {
    return this._history.length === 0 ? 0 : this._history[this._history.length - 1].versionId;
  }

  /**
   * Returns the version history, newest first.
   * @param limit  Max entries to return. 0 means return all.
   *               Defaults to 10 when not provided.
   */
  getHistory(limit?: number): readonly ConfigVersion[] {
    const sorted = [...this._history].reverse();
    const cap = limit === undefined ? 10 : limit === 0 ? sorted.length : limit;
    // Return deep-copied versions so callers can mutate the snapshot without affecting history
    return sorted.slice(0, cap).map(v => ({
      ...v,
      snapshot: { ...v.snapshot },
      changedKeys: [...v.changedKeys],
    }));
  }

  /**
   * Restore the store state to a previously recorded version.
   * Does NOT add a new history entry.
   * @returns true if the versionId was found, false otherwise.
   */
  rollback(versionId: number): boolean {
    const version = this._history.find(v => v.versionId === versionId);
    if (!version) return false;
    this.restoreSnapshot(version.snapshot as Record<string, unknown>);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Feature 4 — Audit Log
  // ---------------------------------------------------------------------------

  /**
   * Returns audit log entries, newest first.
   * @param limit  Max entries to return. 0 means return all.
   *               Defaults to 100 when not provided.
   */
  getAuditLog(limit?: number): readonly AuditEntry[] {
    const sorted = [...this._auditLog].reverse();
    const cap = limit === undefined ? 100 : limit === 0 ? sorted.length : limit;
    return sorted.slice(0, cap);
  }

  clearAuditLog(): void {
    this._auditLog = [];
  }

  // ---------------------------------------------------------------------------
  // Core section management
  // ---------------------------------------------------------------------------

  /**
   * Register a new (user-defined) configuration section.
   * Initialises each field to its declared default.
   */
  registerSection(name: string, fields: Record<string, FieldSchema>): void {
    this._sections[name] = { ...fields };
    this._values[name] = {};
    for (const [fieldName, schema] of Object.entries(fields)) {
      this._values[name][fieldName] = schema.default;
    }
  }

  /**
   * Get a single field value. Returns null if namespace or field is unknown.
   */
  get(namespace: string, field: string): unknown {
    if (!(namespace in this._values)) return null;
    if (!(field in this._values[namespace])) return null;
    return this._values[namespace][field];
  }

  /**
   * Get all values for a section. Returns {} if unknown.
   */
  getSection(namespace: string): Record<string, unknown> {
    if (!(namespace in this._values)) return {};
    return { ...this._values[namespace] };
  }

  /**
   * Set a field value directly (no validation, not filtered by allowlist/blocklist/anchors).
   * Creates section if needed.
   */
  set(namespace: string, field: string, value: unknown): void {
    if (!(namespace in this._values)) {
      this._values[namespace] = {};
    }
    this._values[namespace][field] = value;
  }

  /**
   * Apply a flat map of "namespace.field" → value updates with validation.
   *
   * Filtering order (highest priority first):
   *   1. Anchors — silently skip (value preserved), NOT in rejected, NOT in changedKeys, NOT logged
   *   2. Blocklist — silently skip, NOT in rejected, NOT in changedKeys, NOT logged
   *   3. Allowlist (when non-empty) — silently skip unlisted keys
   *   4. Unknown namespace — silently ignore
   *   5. Validation failure — added to rejected map, NOT logged
   *   6. Apply and record in history / audit log
   *
   * @param updates  Flat map of dot-notation paths to new values.
   *                 Null resets the field to its declared schema default.
   * @param source   The origin of this update (default: 'remote').
   * @returns A map of rejected field paths → reason strings.
   */
  applyUpdates(updates: Record<string, unknown>, source = 'remote'): Record<string, string> {
    const rejected: Record<string, string> = {};
    const changedKeys: string[] = [];
    const auditEntries: AuditEntry[] = [];
    const before = this.snapshot();

    for (const [path, value] of Object.entries(updates)) {
      const dotIdx = path.indexOf('.');
      if (dotIdx === -1) continue;

      const namespace = path.substring(0, dotIdx);
      const field = path.substring(dotIdx + 1);

      // Priority 1 — Anchors: silently skip (do not appear in rejected)
      if (this._anchors.has(path)) continue;

      // Priority 2 & 3 — Blocklist / Allowlist: silently skip
      if (!this._isAllowed(path)) continue;

      // Priority 4 — Unknown namespace → silently ignore
      if (!(namespace in this._sections)) continue;

      // Unknown field in known namespace → apply without schema constraints
      if (!(field in this._sections[namespace])) {
        if (!(namespace in this._values)) this._values[namespace] = {};
        const oldValue = this._values[namespace][field];
        this._values[namespace][field] = value;
        changedKeys.push(path);
        auditEntries.push({
          timestamp: nowIso(),
          key: path,
          oldValue,
          newValue: value,
          source,
        });
        continue;
      }

      // Null → reset to schema default
      if (value === null) {
        const schema = this._sections[namespace][field];
        const oldValue = this._values[namespace][field];
        const newValue = schema.default;
        this._values[namespace][field] = newValue;
        changedKeys.push(path);
        auditEntries.push({
          timestamp: nowIso(),
          key: path,
          oldValue,
          newValue,
          source,
        });
        continue;
      }

      // Validate
      const err = this.validateValue(namespace, field, value);
      if (err) {
        rejected[path] = err;
        continue;
      }

      const oldValue = this._values[namespace][field];
      this._values[namespace][field] = value;
      changedKeys.push(path);
      auditEntries.push({
        timestamp: nowIso(),
        key: path,
        oldValue,
        newValue: value,
        source,
      });
    }

    // Feature 3 — record version only if something changed
    if (changedKeys.length > 0) {
      const snap = this.snapshot();
      const version: ConfigVersion = {
        versionId: this._nextVersionId++,
        timestamp: nowIso(),
        snapshot: Object.freeze({ ...snap }),
        source,
        changedKeys: Object.freeze([...changedKeys]),
      };
      this._history.push(version);
      // Ring buffer: keep only the last HISTORY_LIMIT entries
      if (this._history.length > HISTORY_LIMIT) {
        this._history.splice(0, this._history.length - HISTORY_LIMIT);
      }
    }

    // Feature 4 — append audit entries
    if (auditEntries.length > 0) {
      this._auditLog.push(...auditEntries);
      // Ring buffer: keep only the last AUDIT_LIMIT entries
      if (this._auditLog.length > AUDIT_LIMIT) {
        this._auditLog.splice(0, this._auditLog.length - AUDIT_LIMIT);
      }
    }

    void before; // captured but used only for context; actual old values captured per field above

    return rejected;
  }

  /**
   * Validate a value against the field's schema.
   * Returns an error message string, or null if valid.
   * Returns null if the namespace/field is unknown (no constraints).
   * Null values are always valid (treated as "reset to default").
   */
  validateValue(namespace: string, field: string, value: unknown): string | null {
    if (value === null) return null;

    const schema = this.getFieldSchema(namespace, field);
    if (!schema) return null;

    // Type check
    const typeErr = this._checkType(schema, value);
    if (typeErr) return typeErr;

    // Range checks (numbers only)
    if (schema.type === 'number' && typeof value === 'number') {
      if (schema.ge !== undefined && value < schema.ge) {
        return `${field} must be >= ${schema.ge}, got ${value}`;
      }
      if (schema.le !== undefined && value > schema.le) {
        return `${field} must be <= ${schema.le}, got ${value}`;
      }
    }

    // Enum check
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
      return `${field} must be one of [${schema.enum.join(', ')}], got ${String(value)}`;
    }

    return null;
  }

  private _checkType(schema: FieldSchema, value: unknown): string | null {
    switch (schema.type) {
      case 'number':
        if (typeof value !== 'number') {
          return `${schema.name} must be a number, got ${typeof value}`;
        }
        break;
      case 'string':
        if (typeof value !== 'string') {
          return `${schema.name} must be a string, got ${typeof value}`;
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          return `${schema.name} must be a boolean, got ${typeof value}`;
        }
        break;
      case 'array':
        if (!Array.isArray(value)) {
          return `${schema.name} must be an array, got ${typeof value}`;
        }
        break;
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) {
          return `${schema.name} must be an object, got ${typeof value}`;
        }
        break;
    }
    return null;
  }

  /**
   * Export the full schema for all registered sections.
   * Suitable for sending to /agents/{id}/register.
   */
  exportSchema(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [ns, fields] of Object.entries(this._sections)) {
      result[ns] = { ...fields };
    }
    return result;
  }

  /**
   * Take a flat snapshot of all current values keyed as "namespace.field".
   * Returns a fresh object; mutations do not affect stored state.
   */
  snapshot(): Record<string, unknown> {
    const snap: Record<string, unknown> = {};
    for (const [ns, fields] of Object.entries(this._values)) {
      for (const [field, value] of Object.entries(fields)) {
        snap[`${ns}.${field}`] = value;
      }
    }
    return snap;
  }

  /**
   * Restore from a snapshot produced by snapshot().
   */
  restoreSnapshot(snap: Record<string, unknown>): void {
    for (const [path, value] of Object.entries(snap)) {
      const dotIdx = path.indexOf('.');
      if (dotIdx === -1) continue;
      const namespace = path.substring(0, dotIdx);
      const field = path.substring(dotIdx + 1);
      if (!(namespace in this._values)) {
        this._values[namespace] = {};
      }
      this._values[namespace][field] = value;
    }
  }

  /**
   * Get the FieldSchema for a specific field. Returns null if not found.
   */
  getFieldSchema(namespace: string, field: string): FieldSchema | null {
    if (!(namespace in this._sections)) return null;
    if (!(field in this._sections[namespace])) return null;
    return this._sections[namespace][field];
  }
}
