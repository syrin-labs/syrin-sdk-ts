/**
 * LangGraph Adapter — Adapter class
 */

import { BaseFrameworkAdapter } from '@/adapters/types.js';
import type { ISyrinCore, SchemaField } from '@/adapters/types.js';
import {
  patchStateGraph,
  patchCompiledGraph,
  patchInterrupt,
  unpatchStateGraph,
  unpatchCompiledGraph,
  unpatchInterrupt,
} from './patch.js';
import { patchBaseChatModel, unpatchBaseChatModel } from '../langchain/patch-llm.js';

export class LangGraphAdapter extends BaseFrameworkAdapter {
  readonly name = 'langgraph';

  override configSchema(): Record<string, SchemaField[]> {
    // Telemetry-only adapter — config fields are declared via cfg() in user code
    return {};
  }

  protected async _doInstall(_core: ISyrinCore): Promise<void> {
    await patchStateGraph(this);
    await patchCompiledGraph(this);
    await patchInterrupt(this);
    await patchBaseChatModel(this);
  }

  protected _doUninstall(): void {
    unpatchStateGraph();
    unpatchCompiledGraph();
    unpatchInterrupt();
    unpatchBaseChatModel();
  }
}
