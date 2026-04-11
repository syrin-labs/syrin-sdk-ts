/**
 * Mastra Adapter — Adapter class
 */

import { BaseFrameworkAdapter } from '@/adapters/types.js';
import type { ISyrinCore, SchemaField } from '@/adapters/types.js';
import { patchAgent, unpatchAgent, _patchedMastra } from './patch.js';

interface ModelObject {
  modelId?: string;
  provider?: string;
  config?: { provider?: string };
  name?: string;
}

export function extractModelInfo(model: unknown): { modelId: string; provider: string } {
  if (model == null) return { modelId: 'unknown', provider: 'unknown' };
  if (typeof model === 'string') return { modelId: model, provider: 'unknown' };
  const m = model as ModelObject;
  const modelId = m.modelId ?? m.name ?? 'unknown';
  const rawProvider = m.provider ?? m.config?.provider ?? 'unknown';
  const provider = rawProvider.split('.')[0] ?? rawProvider;
  return { modelId, provider };
}

export class MastraAdapter extends BaseFrameworkAdapter {
  readonly name = 'mastra';

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
        { name: 'max_steps',         type: 'int',   default: null, constraints: { ge: 1, le: 100 } },
      ],
    };
  }

  protected async _doInstall(_core: ISyrinCore): Promise<void> {
    await patchAgent(this);
  }

  protected _doUninstall(): void {
    unpatchAgent();
  }
}
