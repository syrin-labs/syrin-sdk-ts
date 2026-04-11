/**
 * Config persistence — load/save dashboard overrides to .syrin/syrin.config.json.
 * Parity with Python SDK's _config_persist.py.
 *
 * The `dir` parameter (default: process.cwd()) lets tests point at a temp dir.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const SYRIN_DIR = '.syrin';
const CONFIG_FILE = 'syrin.config.json';

function configPath(dir: string): string {
  return join(dir, SYRIN_DIR, CONFIG_FILE);
}

export function load(dir = process.cwd()): Record<string, unknown> {
  try {
    const raw = readFileSync(configPath(dir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // File missing, unreadable, or invalid JSON — return empty
  }
  return {};
}

export function save(overrides: Record<string, unknown>, dir = process.cwd()): void {
  try {
    const syrinDir = join(dir, SYRIN_DIR);
    mkdirSync(syrinDir, { recursive: true });
    // Write to .tmp then rename for atomic replacement
    const target = configPath(dir);
    const tmp = target + '.tmp';
    writeFileSync(tmp, JSON.stringify(overrides, null, 2), 'utf8');
    // Node.js fs.rename is atomic on POSIX (same filesystem)
    const { renameSync } = require('fs') as typeof import('fs');
    renameSync(tmp, target);
  } catch {
    // Non-fatal — persistence is best-effort
  }
}
