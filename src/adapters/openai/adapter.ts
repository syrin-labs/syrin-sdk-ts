/**
 * OpenAI Adapter — Adapter class
 */

import type { ISyrinCore, SyrinSDKAdapter, SchemaField } from '@/adapters/types.js';
import { patchWithModule, unpatch, isPatched, type OpenAIModule } from './patch.js';

export class OpenAIAdapter implements SyrinSDKAdapter {
  readonly name = 'openai';

  constructor(private readonly _openaiModule?: OpenAIModule) {}

  configSchema(): Record<string, SchemaField[]> {
    return {
      llm: [
        { name: 'model',             type: 'str',   default: null },
        { name: 'temperature',       type: 'float', default: null, constraints: { ge: 0.0, le: 2.0 } },
        { name: 'max_tokens',        type: 'int',   default: null, constraints: { ge: 1 } },
        { name: 'top_p',             type: 'float', default: null, constraints: { ge: 0.0, le: 1.0 } },
        { name: 'frequency_penalty', type: 'float', default: null, constraints: { ge: -2.0, le: 2.0 } },
        { name: 'presence_penalty',  type: 'float', default: null, constraints: { ge: -2.0, le: 2.0 } },
        { name: 'seed',              type: 'int',   default: null },
        { name: 'n',                 type: 'int',   default: null, constraints: { ge: 1, le: 10 } },
      ],
      prompt: [
        { name: 'system_prompt', type: 'str', default: null, multiline: true },
      ],
    };
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
