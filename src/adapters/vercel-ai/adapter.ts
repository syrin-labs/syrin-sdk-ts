/**
 * Vercel AI Adapter — Adapter class
 */

import { BaseFrameworkAdapter } from '@/adapters/types.js';
import type { ISyrinCore, SchemaField } from '@/adapters/types.js';
import { patchVercelAI, unpatchVercelAI, _patchedVercelAI } from './patch.js';

export class VercelAIAdapter extends BaseFrameworkAdapter {
  readonly name = 'vercel-ai';

  override configSchema(): Record<string, SchemaField[]> {
    return {
      llm: [
        { name: 'model',             type: 'str',   default: null },
        { name: 'temperature',       type: 'float', default: null, constraints: { ge: 0.0, le: 2.0 } },
        { name: 'max_tokens',        type: 'int',   default: null, constraints: { ge: 1 } },
        { name: 'top_p',             type: 'float', default: null, constraints: { ge: 0.0, le: 1.0 } },
        { name: 'frequency_penalty', type: 'float', default: null, constraints: { ge: -2.0, le: 2.0 } },
        { name: 'presence_penalty',  type: 'float', default: null, constraints: { ge: -2.0, le: 2.0 } },
        { name: 'seed',              type: 'int',   default: null },
        { name: 'max_retries',       type: 'int',   default: null, constraints: { ge: 0, le: 10 } },
        { name: 'max_steps',         type: 'int',   default: null, constraints: { ge: 1, le: 100 } },
      ],
    };
  }

  protected async _doInstall(_core: ISyrinCore): Promise<void> {
    await patchVercelAI(this);
  }

  protected _doUninstall(): void {
    unpatchVercelAI();
  }
}
