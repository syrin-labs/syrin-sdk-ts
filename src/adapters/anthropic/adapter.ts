/**
 * Anthropic Adapter — Adapter class
 */

import type { ISyrinCore, SyrinAdapter, SchemaField } from '@/adapters/types.js';
import { patchWithModule, unpatch, isPatched, type AnthropicModule } from './patch.js';

export class AnthropicAdapter implements SyrinAdapter {
  readonly name = 'anthropic';

  constructor(private readonly _anthropicModule?: AnthropicModule | null) {}

  configSchema(): Record<string, SchemaField[]> {
    // Telemetry-only adapter — config fields are declared via cfg() in user code
    return {};
  }

  async install(core: ISyrinCore): Promise<void> {
    if (this._anthropicModule === null) return;
    const mod = this._anthropicModule ?? (await _loadAnthropic(core.config.debug));
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

async function _loadAnthropic(debug?: boolean): Promise<AnthropicModule | null> {
  try {
    return (await import('@anthropic-ai/sdk')) as unknown as AnthropicModule;
  } catch {
    if (debug) {
      console.warn('[Syrin] @anthropic-ai/sdk not found. Install with: npm install @anthropic-ai/sdk');
    }
    return null;
  }
}
