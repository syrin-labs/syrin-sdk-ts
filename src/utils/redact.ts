/**
 * Syrin SDK — PII Redaction Framework
 *
 * Provides field-level, pattern-level, and auto-PII redaction of captured content.
 * Works recursively on strings, objects, and arrays.
 * Never mutates input — always returns a deep clone with replacements.
 */

export interface RedactConfig {
  /**
   * Field paths to redact from captured content.
   * Supports dot-notation for nested fields: "user.ssn"
   * Supports array wildcard notation: "messages[].content"
   */
  redactFields?: string[];
  /**
   * Regex patterns — any matched substring is replaced with [REDACTED].
   */
  redactPatterns?: RegExp[];
  /**
   * Auto-detect and redact common PII: emails, phone numbers, credit cards.
   */
  autoRedactPii?: boolean;
}

// ── PII patterns ──────────────────────────────────────────────────────────────

/** Email addresses */
const EMAIL_PATTERN = /[a-zA-Z0-9+_.-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]+/g;

/**
 * Common US phone number formats:
 *   (555) 123-4567  |  555-123-4567  |  555.123.4567  |  5551234567  |  +1 555 123 4567
 */
const PHONE_PATTERN =
  /(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}/g;

/**
 * Credit card: 13–19 digits optionally separated by spaces or dashes in groups of 4.
 * Matches Visa, MC, Amex, Discover, etc.
 */
const CARD_PATTERN = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Redact sensitive content from `content` according to `config`.
 *
 * - Returns a deep clone with redactions applied; the original is never mutated.
 * - null / undefined are returned as-is.
 * - Primitives other than strings are returned unchanged (numbers, booleans).
 */
export function redactContent(content: unknown, config: RedactConfig): unknown {
  const hasWork =
    config.autoRedactPii ||
    (config.redactPatterns && config.redactPatterns.length > 0) ||
    (config.redactFields && config.redactFields.length > 0);

  if (!hasWork) return content;
  if (content == null) return content;

  // Handle redactFields separately — they operate on the top-level object graph.
  // We deep-clone first so field operations compose correctly with pattern operations.
  let result: unknown = _deepClone(content);

  // Apply redactFields path traversal
  if (config.redactFields && config.redactFields.length > 0) {
    for (const field of config.redactFields) {
      result = _redactPath(result, field.split('.'));
    }
  }

  // Apply string-level redactions (autoRedactPii + redactPatterns) recursively
  const needsStringRedact =
    config.autoRedactPii ||
    (config.redactPatterns && config.redactPatterns.length > 0);

  if (needsStringRedact) {
    result = _redactStrings(result, config);
  }

  return result;
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Deep-clone a value (handles objects, arrays, primitives).
 * Does not clone class instances beyond their enumerable own properties.
 */
function _deepClone(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(_deepClone);
  const obj = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    clone[key] = _deepClone(obj[key]);
  }
  return clone;
}

/**
 * Traverse an object/array graph following the given path segments and redact
 * the leaf value(s).
 *
 * A path segment of the form "key[]" (i.e. ends with "[]") means "descend into
 * each element of the array named `key`" and continue with remaining segments.
 */
function _redactPath(root: unknown, segments: string[]): unknown {
  if (segments.length === 0) return '[REDACTED]';
  if (root == null || typeof root !== 'object') return root;

  const [head, ...tail] = segments;

  // Array wildcard: "messages[]" → head = "messages[]"
  if (head.endsWith('[]')) {
    const arrayKey = head.slice(0, -2);
    if (Array.isArray(root)) {
      // root itself is an array — apply to each element
      return (root as unknown[]).map((item) => _redactPath(item, [arrayKey.length ? arrayKey : '', ...tail].filter(s => s !== '')));
    }
    const obj = root as Record<string, unknown>;
    const arr = obj[arrayKey];
    if (!Array.isArray(arr)) return root;
    return {
      ...obj,
      [arrayKey]: arr.map((item: unknown) => _redactPath(item, tail)),
    };
  }

  // Plain key
  if (Array.isArray(root)) {
    return (root as unknown[]).map((item) => _redactPath(item, segments));
  }

  const obj = root as Record<string, unknown>;
  if (!(head in obj)) return obj;

  return {
    ...obj,
    [head]: tail.length === 0 ? '[REDACTED]' : _redactPath(obj[head], tail),
  };
}

/**
 * Recursively apply string-level redactions (autoRedactPii + redactPatterns)
 * to all string leaves in a value.
 */
function _redactStrings(value: unknown, config: RedactConfig): unknown {
  if (value == null) return value;

  if (typeof value === 'string') {
    return _applyStringRedactions(value, config);
  }

  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => _redactStrings(item, config));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      result[key] = _redactStrings(obj[key], config);
    }
    return result;
  }

  return value;
}

/** Apply all string-level redactions to a single string. */
function _applyStringRedactions(str: string, config: RedactConfig): string {
  let result = str;

  if (config.autoRedactPii) {
    result = result.replace(new RegExp(CARD_PATTERN.source, 'g'), '[CARD]');
    result = result.replace(new RegExp(EMAIL_PATTERN.source, 'g'), '[EMAIL]');
    result = result.replace(new RegExp(PHONE_PATTERN.source, 'g'), '[PHONE]');
  }

  if (config.redactPatterns) {
    for (const pattern of config.redactPatterns) {
      // Create a fresh regex with the global flag to avoid lastIndex state sharing
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      result = result.replace(globalPattern, '[REDACTED]');
    }
  }

  return result;
}
