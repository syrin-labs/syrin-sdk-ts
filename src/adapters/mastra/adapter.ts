/**
 * Mastra Adapter — Adapter class
 */

import { SyrinSDKBaseFrameworkAdapter } from '@/adapters/types.js';
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

export class MastraAdapter extends SyrinSDKBaseFrameworkAdapter {
  readonly name = 'mastra';

  override configSchema(): Record<string, SchemaField[]> {
    // Adapters are telemetry-only — config schema is declared by users via sdk.cfg()
    return {};
  }

  protected async _doInstall(_core: ISyrinCore): Promise<void> {
    await patchAgent(this);
  }

  protected _doUninstall(): void {
    unpatchAgent();
  }
}
