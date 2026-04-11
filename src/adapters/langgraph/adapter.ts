/**
 * LangGraph Adapter — Adapter class
 */

import { SyrinSDKBaseFrameworkAdapter } from '@/adapters/types.js';
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

export class LangGraphAdapter extends SyrinSDKBaseFrameworkAdapter {
  readonly name = 'langgraph';

  override configSchema(): Record<string, SchemaField[]> {
    return {
      llm: [
        { name: 'model', type: 'str', default: null },
        { name: 'temperature', type: 'float', default: null, constraints: { ge: 0.0, le: 2.0 } },
        { name: 'max_tokens', type: 'int', default: null, constraints: { ge: 1 } },
      ],
      langgraph: [
        { name: 'recursion_limit',  type: 'int',  default: 25,   constraints: { ge: 1, le: 1000 } },
        { name: 'interrupt_before', type: 'str',  default: null },
        { name: 'interrupt_after',  type: 'str',  default: null },
        { name: 'thread_id',        type: 'str',  default: null },
        { name: 'max_concurrency',  type: 'int',  default: null, constraints: { ge: 1, le: 100 } },
        { name: 'stream_mode',      type: 'str',  default: null },
        { name: 'debug',            type: 'bool', default: null },
      ],
    };
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
