/**
 * Syrin SDK — Code Scanner
 *
 * Scans the user's agent source files for cfg()/activeConfig() usage patterns
 * and extracts config key → default-value pairs.  Called once at init() so the
 * dashboard is pre-populated with real defaults before the first LLM call.
 *
 * Supported patterns (TypeScript / JavaScript):
 *   cfg('llm.model', 'gpt-4o-mini')
 *   config('llm.temperature', 0.7)
 *   sdk.activeConfig()['llm.model'] ?? 'gpt-4o-mini'
 *   activeConfig()['prompt.system_prompt'] ?? 'You are a helpful assistant.'
 */

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import type { SchemaField } from '@/adapters/types.js';

export interface ScannedDefault {
  /** Dot-notation path, e.g. 'llm.model' or 'agent.response_style' */
  path: string;
  /** Scalar default value extracted from the source */
  default: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan the caller's file (and siblings in the same directory) for config
 * usage patterns and return all detected key → default pairs.
 *
 * @param stack - `new Error().stack` captured at the start of init()
 */
export function scanCallerDefaults(stack: string): ScannedDefault[] {
  const callerFile = _extractCallerFile(stack);
  if (!callerFile) return [];

  const results: ScannedDefault[] = [];
  const seen = new Set<string>();

  const add = (items: ScannedDefault[]) => {
    for (const item of items) {
      if (!seen.has(item.path)) {
        seen.add(item.path);
        results.push(item);
      }
    }
  };

  // 1. Scan the direct caller file first
  add(_scanFile(callerFile));

  // 2. Scan sibling source files in the same directory
  try {
    const dir = path.dirname(callerFile);
    const exts = new Set(['.ts', '.js', '.mjs', '.cjs']);
    for (const entry of readdirSync(dir)) {
      if (!exts.has(path.extname(entry))) continue;
      const sibling = path.join(dir, entry);
      if (sibling === callerFile) continue;
      add(_scanFile(sibling));
    }
  } catch { /* non-fatal — directory may not be readable */ }

  return results;
}

/**
 * Infer a SchemaField type string from a scanned default value.
 * Used when auto-creating new schema sections from detected cfg() calls.
 */
export function inferFieldType(value: unknown): SchemaField['type'] {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  return 'str';
}

// ---------------------------------------------------------------------------
// Internal — call-stack parsing
// ---------------------------------------------------------------------------

// Compute the SDK package root dynamically so that SDK-internal files are
// reliably filtered regardless of installation path or whether we're running
// from source (tsx dev) or compiled dist (Node.js production).
//
// code-scanner lives at:
//   dev:  <sdk-root>/src/utils/code-scanner.ts  → dirname ../.. = <sdk-root>
//   dist: <sdk-root>/dist/utils/code-scanner.js → dirname ../.. = <sdk-root>
const _MODULE_FILE = fileURLToPath(import.meta.url);
const _SDK_ROOT = path.resolve(path.dirname(_MODULE_FILE), '..', '..');

const _SDK_MARKERS: string[] = [
  'node_modules',                              // production npm install
  'node:internal',                             // Node.js internals
  path.join(_SDK_ROOT, 'src') + path.sep,      // dev: SDK source files
  path.join(_SDK_ROOT, 'dist') + path.sep,     // dev/prod: SDK compiled files
  '/@syrin/',                                  // scoped npm package fallback
];

/** @internal */
export function _extractCallerFile(stack: string): string | null {
  for (const line of stack.split('\n')) {
    // "at Something (file:///path:line:col)" or "at file:///path:line:col"
    const m = line.match(/\(?(file:\/\/\/[^):\s]+\.(?:ts|js|mjs|cjs)):\d+:\d+\)?/)
           ?? line.match(/\(?(\/.+?\.(?:ts|js|mjs|cjs)):\d+:\d+\)?/);
    if (!m) continue;

    let fp = m[1];
    if (fp.startsWith('file:///')) {
      try { fp = fileURLToPath(fp); } catch { continue; }
    }

    if (_SDK_MARKERS.some(marker => fp.includes(marker))) continue;
    return fp;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal — file scanning
// ---------------------------------------------------------------------------

function _scanFile(filePath: string): ScannedDefault[] {
  let src: string;
  try { src = readFileSync(filePath, 'utf-8'); } catch { return []; }
  return _extractDefaults(src);
}

/** @internal exported for tests */
export function _extractDefaults(src: string): ScannedDefault[] {
  const results: ScannedDefault[] = [];
  const seen = new Set<string>();

  // Regex component: captures a dotted config key like 'llm.model' or "agent.debug"
  const KEY = `['"]([a-z][a-z0-9_]*\\.[a-z][a-z0-9_A-Z]*)['"]`;

  const patterns: RegExp[] = [
    // cfg('key', fallback)  /  config('key', fallback)  /  getConfig('key', fallback)
    new RegExp(`\\b(?:cfg|config|getConfig)\\s*\\(\\s*${KEY}\\s*,\\s*([^)]+)\\)`, 'g'),
    // sdk.activeConfig()['key'] ?? fallback  or  activeConfig()['key'] ?? fallback
    new RegExp(`\\.?activeConfig\\s*\\(\\s*\\)\\s*\\[\\s*${KEY}\\s*\\]\\s*\\?\\?\\s*([^\\n,;)]+)`, 'g'),
  ];

  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(src)) !== null) {
      const key = m[1];
      const raw = m[2].trim().replace(/[,;)\s]+$/, '').trim();
      const val = _parseScalar(raw);
      if (val !== undefined && !seen.has(key)) {
        seen.add(key);
        results.push({ path: key, default: val });
      }
    }
  }

  return results;
}

/** Parse a raw token into a scalar JS value. Returns undefined for complex expressions. */
export function _parseScalar(s: string): unknown {
  s = s.trim().replace(/[,;)\s]+$/, '').trim();

  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);

  // Boolean
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;

  // String literal: 'text' or "text" (no backslash escapes for simplicity)
  const strM = s.match(/^['"]([^'"\\]*)['"]$/);
  if (strM) return strM[1];

  // Backtick template without interpolation: `plain text`
  const tmplM = s.match(/^`([^`${}\\]*)`$/);
  if (tmplM) return tmplM[1];

  // String('literal') or String("literal") without concatenation
  const castStr = s.match(/^String\s*\(\s*['"]([^'"\\]*)['"](?:\s*\+\s*[^)]+)?\s*\)/);
  if (castStr && !s.includes('+')) return castStr[1];

  // Number(n) cast
  const castNum = s.match(/^Number\s*\(\s*(-?\d+(?:\.\d+)?)\s*\)$/);
  if (castNum) return Number(castNum[1]);

  // parseInt / parseFloat
  const parsedNum = s.match(/^(?:parseInt|parseFloat)\s*\(\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*\d+)?\s*\)$/);
  if (parsedNum) return Number(parsedNum[1]);

  return undefined; // complex expression — skip
}
