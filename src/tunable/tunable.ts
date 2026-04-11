/**
 * Syrin SDK — Tunable
 *
 * Provides runtime-configurable fields for arbitrary objects and classes.
 * Uses a marker-object approach (no reflect-metadata) so it works in all
 * TypeScript environments without extra tsconfig flags.
 *
 * Usage (class decorator):
 *   @tunable({ namespace: "processor" })
 *   class DocumentProcessor {
 *     batchSize = TunableField({ default: 10, ge: 1 });
 *     temperature = TunableField({ default: 0.7, ge: 0.0, le: 2.0 });
 *   }
 *
 * Usage (standalone):
 *   tune({ target: myObj, namespace: "myns", fields: { x: "number" } });
 */

import type { FieldSchema } from '@/config/store.js';

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export interface TunableFieldOptions {
  default?: unknown;
  description?: string;
  ge?: number;
  le?: number;
  enum?: unknown[];
  applyTiming?: 'immediate' | 'beforeNextCall' | 'manual';
}

export interface TuneOptions {
  target: object;
  namespace: string;
  /** Either fields or schema must be provided */
  fields?: Record<string, 'number' | 'string' | 'boolean' | 'array'>;
  schema?: object;  // Zod schema (optional, ignored if Zod not installed)
  apply?: (target: object, key: string, value: unknown) => void;
  applyTiming?: 'immediate' | 'beforeNextCall' | 'manual';
  /** Inject a custom registry (defaults to globalRegistry) */
  registry?: TunableRegistry;
}

// ---------------------------------------------------------------------------
// TunableField marker
// ---------------------------------------------------------------------------

export const TUNABLE_FIELD_MARKER = '__tunableField__';

export type TunableFieldMarker = TunableFieldOptions & { [TUNABLE_FIELD_MARKER]: true };

/**
 * Mark a class property as tunable. Returns a marker object.
 * The @tunable class decorator replaces markers with their default values
 * and registers the field schema.
 */
export function TunableField(options: TunableFieldOptions = {}): unknown {
  return { [TUNABLE_FIELD_MARKER]: true, ...options } as TunableFieldMarker;
}

export function isTunableFieldMarker(v: unknown): v is TunableFieldMarker {
  return (
    typeof v === 'object' &&
    v !== null &&
    TUNABLE_FIELD_MARKER in v &&
    (v as Record<string, unknown>)[TUNABLE_FIELD_MARKER] === true
  );
}

// ---------------------------------------------------------------------------
// TunableEntry (internal)
// ---------------------------------------------------------------------------

interface TunableEntry {
  namespace: string;
  target: object;
  fields: Record<string, FieldSchema>;
  apply?: (target: object, key: string, value: unknown) => void;
  applyTiming: 'immediate' | 'beforeNextCall' | 'manual';
  /** Buffered values awaiting applyPending() */
  pending: Record<string, unknown>;
  /** Current logical values (may differ from target properties when buffered) */
  current: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TunableRegistry
// ---------------------------------------------------------------------------

export class TunableRegistry {
  private _entries: Map<string, TunableEntry> = new Map();

  /**
   * Register a TunableEntry (called internally by tune() and @tunable).
   */
  register(entry: TunableEntry): void {
    this._entries.set(entry.namespace, entry);
  }

  /**
   * Apply a single field update to the named namespace.
   * Respects applyTiming: 'immediate' writes through to target,
   * 'beforeNextCall' and 'manual' buffer in pending.
   */
  applyUpdate(namespace: string, field: string, value: unknown): void {
    const entry = this._entries.get(namespace);
    if (!entry) return;

    // Always update the logical current value
    entry.current[field] = value;

    if (entry.applyTiming === 'immediate') {
      this._applyToTarget(entry, field, value);
    } else {
      entry.pending[field] = value;
    }
  }

  /**
   * Flush all buffered (pending) values for the given namespace,
   * or all namespaces if namespace is omitted.
   */
  applyPending(namespace?: string): void {
    const targets = namespace ? [this._entries.get(namespace)] : [...this._entries.values()];
    for (const entry of targets) {
      if (!entry) continue;
      for (const [field, value] of Object.entries(entry.pending)) {
        this._applyToTarget(entry, field, value);
      }
      entry.pending = {};
    }
  }

  /**
   * Get the current logical values for a namespace (includes buffered).
   * Returns {} if unknown.
   */
  get(namespace: string): Record<string, unknown> {
    const entry = this._entries.get(namespace);
    if (!entry) return {};
    return { ...entry.current };
  }

  /**
   * Export all FieldSchema definitions keyed by namespace.
   */
  exportSchemas(): Record<string, Record<string, FieldSchema>> {
    const result: Record<string, Record<string, FieldSchema>> = {};
    for (const [ns, entry] of this._entries) {
      result[ns] = { ...entry.fields };
    }
    return result;
  }

  /**
   * Remove a namespace from the registry.
   */
  unregister(namespace: string): void {
    this._entries.delete(namespace);
  }

  /**
   * Clear all registered entries (useful for tests).
   */
  clear(): void {
    this._entries.clear();
  }

  private _applyToTarget(entry: TunableEntry, field: string, value: unknown): void {
    if (entry.apply) {
      entry.apply(entry.target, field, value);
    } else {
      (entry.target as Record<string, unknown>)[field] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Global singleton registry
// ---------------------------------------------------------------------------

export const globalRegistry = new TunableRegistry();

// ---------------------------------------------------------------------------
// @tunable class decorator
// ---------------------------------------------------------------------------

export interface TunableDecoratorOptions {
  namespace: string;
  applyTiming?: 'immediate' | 'beforeNextCall' | 'manual';
  apply?: (target: object, key: string, value: unknown) => void;
  /** Inject a custom registry (defaults to globalRegistry) */
  registry?: TunableRegistry;
}

/**
 * Class decorator that auto-registers each instance with the TunableRegistry.
 * Scans all own properties of the instance for TunableField markers,
 * extracts their schemas, and replaces markers with default values.
 *
 * Uses a factory function pattern to avoid the `class extends` pitfall
 * in environments where the original constructor reference may be null
 * in esbuild/vitest transforms.
 */
export function tunable(options: TunableDecoratorOptions): ClassDecorator {
  return function (ctor: Function): Function {
    const registry = options.registry ?? globalRegistry;
    const applyTiming = options.applyTiming ?? 'immediate';

    // Use Reflect.construct to properly invoke ES class constructors
    // (plain `ctor.apply(this, args)` breaks for ES2022 classes)
    function TunableWrapper(this: object, ...args: unknown[]): void {
      // Reflect.construct calls `ctor` as a constructor with `this` as the
      // new.target, which satisfies the "must be called with new" constraint.
      const instance = Reflect.construct(ctor, args, new.target ?? TunableWrapper) as Record<string, unknown>;

      const fields: Record<string, FieldSchema> = {};
      const current: Record<string, unknown> = {};

      // Scan own properties for TunableField markers
      for (const key of Object.keys(instance)) {
        const val = instance[key];
        if (isTunableFieldMarker(val)) {
          const schema = buildFieldSchemaFromMarker(key, val);
          fields[key] = schema;
          const defaultVal = val.default !== undefined ? val.default : null;
          instance[key] = defaultVal;
          current[key] = defaultVal;
        }
      }

      registry.register({
        namespace: options.namespace,
        target: instance,
        fields,
        apply: options.apply,
        applyTiming,
        pending: {},
        current,
      });

      return instance;
    }

    // Wire up the prototype chain so instanceof checks and method lookups work
    TunableWrapper.prototype = ctor.prototype;
    Object.defineProperty(TunableWrapper, 'name', { value: ctor.name, configurable: true });
    Object.defineProperty(TunableWrapper, 'length', { value: ctor.length, configurable: true });

    // Copy static properties
    for (const key of Object.getOwnPropertyNames(ctor)) {
      if (['length', 'name', 'prototype', 'caller', 'arguments'].includes(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(ctor, key);
      if (descriptor) {
        Object.defineProperty(TunableWrapper, key, descriptor);
      }
    }

    return TunableWrapper as unknown as typeof ctor;
  } as ClassDecorator;
}

// ---------------------------------------------------------------------------
// tune() — programmatic registration
// ---------------------------------------------------------------------------

/**
 * Register an existing object instance with the TunableRegistry.
 * Either `fields` or `schema` must be provided.
 */
export function tune(options: TuneOptions): void {
  const registry = options.registry ?? globalRegistry;

  if (!options.fields && !options.schema) {
    throw new Error('tune() requires either fields or schema to be provided');
  }

  const fields: Record<string, FieldSchema> = {};
  const current: Record<string, unknown> = {};

  if (options.fields) {
    for (const [key, type] of Object.entries(options.fields)) {
      fields[key] = { name: key, type, default: null };
      // Read the current value from the target (supports dotted paths via apply fn)
      current[key] = readNestedValue(options.target, key);
    }
  }

  // Zod schema support is conditional and optional
  if (options.schema && !options.fields) {
    // Basic introspection for Zod schemas (if available)
    const schema = options.schema as Record<string, unknown>;
    const shape = schema['shape'] as Record<string, unknown> | undefined;
    if (shape) {
      for (const [key] of Object.entries(shape)) {
        fields[key] = { name: key, type: 'object', default: null };
        current[key] = readNestedValue(options.target, key);
      }
    }
  }

  const applyTiming = options.applyTiming ?? 'immediate';

  registry.register({
    namespace: options.namespace,
    target: options.target,
    fields,
    apply: options.apply,
    applyTiming,
    pending: {},
    current,
  });
}

/**
 * Get current values for a namespace from the registry.
 */
export function getTune(namespace: string, registry?: TunableRegistry): Record<string, unknown> {
  return (registry ?? globalRegistry).get(namespace);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFieldSchemaFromMarker(name: string, marker: TunableFieldMarker): FieldSchema {
  // Infer type from the default value
  const defaultVal = marker.default;
  let type: FieldSchema['type'] = 'object';
  if (defaultVal !== null && defaultVal !== undefined) {
    if (typeof defaultVal === 'number') type = 'number';
    else if (typeof defaultVal === 'string') type = 'string';
    else if (typeof defaultVal === 'boolean') type = 'boolean';
    else if (Array.isArray(defaultVal)) type = 'array';
  }

  return {
    name,
    type,
    default: defaultVal !== undefined ? defaultVal : null,
    description: marker.description,
    ge: marker.ge,
    le: marker.le,
    enum: marker.enum,
  };
}

function readNestedValue(target: object, key: string): unknown {
  const parts = key.split('.');
  let obj = target as Record<string, unknown>;
  for (const part of parts) {
    if (obj === null || obj === undefined) return undefined;
    obj = obj[part] as Record<string, unknown>;
  }
  return obj as unknown;
}
