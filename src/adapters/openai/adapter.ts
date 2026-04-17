/**
 * OpenAI Adapter — Adapter class
 */

import type { ISyrinCore, SyrinSDKAdapter, SchemaField } from '@/adapters/types.js';
import { patchWithModule, unpatch, isPatched, type OpenAIModule } from './patch.js';

export class OpenAIAdapter implements SyrinSDKAdapter {
  readonly name = 'openai';

  constructor(private readonly _openaiModule?: OpenAIModule) {}

  configSchema(): Record<string, SchemaField[]> {
    // Adapters are telemetry-only — config schema is declared by users via sdk.cfg()
    return {};
  }

  async install(core: ISyrinCore): Promise<void> {
    const mod = this._openaiModule ?? (await _loadOpenAI(core.config.debug));
    if (mod) {
      patchWithModule(mod, core);
    }
  }

  uninstall(): void {
    unpatch();
  }

  isInstalled(): boolean {
    return isPatched();
  }
}

async function _loadOpenAI(debug?: boolean): Promise<OpenAIModule | null> {
  // Resolve openai from the user's project root (CWD) so we patch the same
  // module instance that the user's code and frameworks like LangChain use.
  // If the SDK is installed as a dependency and has its own nested openai copy,
  // patching that copy would intercept nothing.
  try {
    const { createRequire } = await import('module');
    const { pathToFileURL } = await import('url');
    const { readFileSync } = await import('fs');
    const nodePath = await import('path');

    const cwdReq = createRequire(process.cwd() + '/package.json');
    const resolvedCJSPath = cwdReq.resolve('openai');

    // Walk up from the resolved CJS path to find the openai package.json
    let dir = nodePath.dirname(resolvedCJSPath);
    while (dir !== nodePath.dirname(dir)) {
      try {
        const pkgPath = nodePath.join(dir, 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: string;
          exports?: Record<string, Record<string, string> | string>;
        };
        if (pkg.name === 'openai') {
          // Prefer the ESM entry (index.mjs) — frameworks using ESM imports of
          // openai will share this module instance, so patching its prototype
          // intercepts all ESM-based callers (LangChain, Vercel AI, etc.)
          const exportsRoot = pkg.exports?.['.'] as Record<string, string> | undefined;
          const esmRelPath = exportsRoot?.['import'] ?? './index.mjs';
          const esmAbsPath = nodePath.resolve(dir, esmRelPath);
          try {
            return await import(pathToFileURL(esmAbsPath).href) as unknown as OpenAIModule;
          } catch {
            // ESM import failed (e.g. file doesn't exist) — fall through to CJS
            break;
          }
        }
      } catch { /* not a valid package.json — keep walking up */ }
      dir = nodePath.dirname(dir);
    }

    // Fallback: return the CJS module from the user's project
    return cwdReq('openai') as unknown as OpenAIModule;
  } catch {
    // Last resort: the SDK's own openai copy (original behaviour)
    try {
      return await import('openai') as unknown as OpenAIModule;
    } catch {
      if (debug) {
        console.warn('[Syrin] openai module not found. Install with: npm install openai');
      }
      return null;
    }
  }
}
