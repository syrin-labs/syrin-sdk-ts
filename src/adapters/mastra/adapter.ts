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
  if (typeof model === 'string') {
    // Mastra uses "{provider}/{model}" format e.g. "openai/gpt-4o-mini"
    const slashIdx = model.indexOf('/');
    if (slashIdx > 0) {
      return {
        provider: model.slice(0, slashIdx),
        modelId: model.slice(slashIdx + 1),
      };
    }
    return { modelId: model, provider: 'unknown' };
  }
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
        { name: 'system_prompt',     type: 'str',   default: null, multiline: true },
      ],
      mastra: [
        /** Max reasoning/tool-call steps per agent.generate() call */
        { name: 'max_steps',     type: 'int',   default: 5,    constraints: { ge: 1, le: 100 } },
        /** Retry failed steps this many times before surfacing the error */
        { name: 'max_retries',   type: 'int',   default: 2,    constraints: { ge: 0, le: 10  } },
        /** Telemetry: record intermediate step results in the event */
        { name: 'record_steps',  type: 'bool',  default: false },
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
