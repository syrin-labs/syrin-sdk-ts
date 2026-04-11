/**
 * Syrin SDK — ConfigStore
 *
 * Manages per-section configuration with schema validation, defaults,
 * snapshot/restore, and export for the /agents/{id}/register endpoint.
 */

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
// ConfigStore
// ---------------------------------------------------------------------------

export class ConfigStore {
  private _sections: Record<string, Record<string, FieldSchema>>;
  private _values: Record<string, Record<string, unknown>>;

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
   * Set a field value directly (no validation). Creates section if needed.
   */
  set(namespace: string, field: string, value: unknown): void {
    if (!(namespace in this._values)) {
      this._values[namespace] = {};
    }
    this._values[namespace][field] = value;
  }

  /**
   * Apply a flat map of "namespace.field" → value updates with validation.
   * Returns a map of rejected field paths → reason strings.
   * A null value resets to the field's declared default.
   * Unknown namespaces are silently ignored.
   */
  applyUpdates(updates: Record<string, unknown>): Record<string, string> {
    const rejected: Record<string, string> = {};

    for (const [path, value] of Object.entries(updates)) {
      const dotIdx = path.indexOf('.');
      if (dotIdx === -1) continue;

      const namespace = path.substring(0, dotIdx);
      const field = path.substring(dotIdx + 1);

      // Unknown namespace → silently ignore
      if (!(namespace in this._sections)) continue;

      // Unknown field in known namespace → silently ignore (no schema = no constraints)
      if (!(field in this._sections[namespace])) {
        // Still apply the value even without schema
        if (!(namespace in this._values)) this._values[namespace] = {};
        this._values[namespace][field] = value;
        continue;
      }

      // null → reset to default
      if (value === null) {
        this._values[namespace][field] = this._sections[namespace][field].default;
        continue;
      }

      // Validate
      const err = this.validateValue(namespace, field, value);
      if (err) {
        rejected[path] = err;
        continue;
      }

      this._values[namespace][field] = value;
    }

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
