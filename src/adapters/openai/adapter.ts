/**
 * OpenAI Adapter — Adapter class
 */

import type { ISyrinCore, SyrinAdapter, SchemaField } from '@/adapters/types.js';
import { patchWithModule, unpatch, isPatched, type OpenAIModule } from './patch.js';

export class OpenAIAdapter implements SyrinAdapter {
  readonly name = 'openai';

  constructor(private readonly _openaiModule?: OpenAIModule) {}

  configSchema(): Record<string, SchemaField[]> {
    // Telemetry-only adapter — config fields are declared via cfg() in user code
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
  try {
    return await import('openai') as unknown as OpenAIModule;
  } catch {
    if (debug) {
      console.warn('[Syrin] openai module not found. Install with: npm install openai');
    }
    return null;
  }
}
