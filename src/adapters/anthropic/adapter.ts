/**
 * Anthropic Adapter — Adapter class
 */

import type { ISyrinCore, SyrinAdapter, SchemaField } from '@/adapters/types.js';
import { patchWithModule, unpatch, isPatched, type AnthropicModule } from './patch.js';

export class AnthropicAdapter implements SyrinAdapter {
  readonly name = 'anthropic';

  constructor(private readonly _anthropicModule?: AnthropicModule | null) {}

  configSchema(): Record<string, SchemaField[]> {
    return {
      llm: [
        { name: 'model',       type: 'str',   default: null },
        { name: 'temperature', type: 'float', default: null, constraints: { ge: 0.0, le: 2.0 } },
        { name: 'max_tokens',  type: 'int',   default: null, constraints: { ge: 1 } },
        { name: 'top_p',       type: 'float', default: null, constraints: { ge: 0.0, le: 1.0 } },
        { name: 'top_k',       type: 'int',   default: null, constraints: { ge: 0 } },
      ],
      prompt: [
        { name: 'system_prompt', type: 'str', default: null, multiline: true },
      ],
    };
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
    return (await import('@anthropic-ai/sdk')) as AnthropicModule;
  } catch {
    if (debug) {
      console.warn('[Syrin] @anthropic-ai/sdk not found. Install with: npm install @anthropic-ai/sdk');
    }
    return null;
  }
}
