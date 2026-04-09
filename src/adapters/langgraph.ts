/**
 * Syrin SDK — LangGraph Adapter (TypeScript)
 *
 * Instruments @langchain/langgraph graphs with Syrin observability and remote config.
 *
 * Emits:
 *   GRAPH_EXECUTION  — one per graph.invoke() / ainvoke() call
 *   NODE_EXECUTION   — one per node execution
 *   HITL_INTERRUPT   — when interrupt() is called
 *
 * Config injection:
 *   - langgraph.recursionLimit → config.recursionLimit
 *   - langgraph.interruptBefore → config.interruptBefore
 *   - langgraph.threadId → config.configurable.thread_id
 *   - llm.temperature / maxTokens → config.configurable
 *
 * Integration:
 *   import { init } from "@syrin/sdk";
 *   import { LangGraphAdapter } from "@syrin/sdk/adapters";
 *   init({ apiKey: "...", adapters: [new LangGraphAdapter()] });
 */

import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import { BaseFrameworkAdapter } from '@/adapters/types';
import { withFrameworkContext } from '@/framework-context';
import { generateId, nowIso } from '@/utils';
import type { ISyrinCore, SchemaField } from '@/adapters/types';

// ---------------------------------------------------------------------------
// AsyncLocalStorage to pass graph run_id to node wrappers
// ---------------------------------------------------------------------------

const _graphRunIdStorage = new AsyncLocalStorage<string>();

// ---------------------------------------------------------------------------
// Module-level patch state (singleton per process)
// ---------------------------------------------------------------------------

let _patchedStateGraph = false;
let _patchedCompiledGraph = false;
let _patchedInterrupt = false;

// StateGraph patch state
let _stateGraphProto: Record<string, unknown> | null = null;
let _originalAddNode: ((...args: unknown[]) => unknown) | null = null;

// CompiledGraph patch state
let _compiledGraphProto: Record<string, (...args: unknown[]) => unknown> | null = null;
let _originalInvoke: ((...args: unknown[]) => unknown) | null = null;
let _originalAInvoke: ((...args: unknown[]) => unknown) | null = null;

// interrupt patch state
let _lgModuleRef: Record<string, unknown> | null = null;
let _originalInterrupt: ((...args: unknown[]) => unknown) | null = null;

// ---------------------------------------------------------------------------
// State hashing helper
// ---------------------------------------------------------------------------

function _hashState(state: unknown): string {
  try {
    const text = JSON.stringify(state, (_k, v) =>
      typeof v === 'bigint' ? String(v) : v
    );
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  } catch {
    return createHash('sha256').update(String(state)).digest('hex').slice(0, 16);
  }
}

// ---------------------------------------------------------------------------
// LangGraphAdapter
// ---------------------------------------------------------------------------

export class LangGraphAdapter extends BaseFrameworkAdapter {
  readonly name = 'langgraph';

  override configSchema(): Record<string, SchemaField[]> {
    return {
      llm: [
        { name: 'model', type: 'str', default: null },
        { name: 'temperature', type: 'float', default: null, constraints: { ge: 0.0, le: 2.0 } },
        { name: 'max_tokens', type: 'int', default: null, constraints: { ge: 1 } },
      ],
      langgraph: [
        { name: 'recursion_limit', type: 'int', default: 25, constraints: { ge: 1, le: 1000 } },
        { name: 'interrupt_before', type: 'str', default: null },
        { name: 'interrupt_after', type: 'str', default: null },
        { name: 'thread_id', type: 'str', default: null },
      ],
    };
  }

  protected async _doInstall(_core: ISyrinCore): Promise<void> {
    await this._patchStateGraph();
    await this._patchCompiledGraph();
    await this._patchInterrupt();
  }

  protected _doUninstall(): void {
    this._unpatchStateGraph();
    this._unpatchCompiledGraph();
    this._unpatchInterrupt();
  }

  // -------------------------------------------------------------------------
  // StateGraph patching — wrap addNode to instrument node functions
  // -------------------------------------------------------------------------

  private async _patchStateGraph(): Promise<void> {
    if (_patchedStateGraph) return;

    let lgModule: Record<string, unknown>;
    try {
      lgModule = (await import('@langchain/langgraph')) as Record<string, unknown>;
    } catch {
      return;
    }

    // Accept both StateGraph and CompiledStateGraph
    const StateGraph = (lgModule['StateGraph'] ?? lgModule['CompiledStateGraph']) as
      | { prototype: Record<string, unknown> }
      | undefined;
    if (!StateGraph?.prototype) return;

    const proto = StateGraph.prototype;
    const addNodeKey = 'addNode' in proto ? 'addNode' : 'add_node' in proto ? 'add_node' : null;
    if (!addNodeKey) return;

    _originalAddNode = proto[addNodeKey] as (...args: unknown[]) => unknown;
    _stateGraphProto = proto;

    const adapter = this;

    proto[addNodeKey] = function patchedAddNode(
      nodeName: unknown,
      fn: unknown,
      ...rest: unknown[]
    ): unknown {
      const wrappedFn =
        typeof fn === 'function'
          ? adapter._wrapNode(String(nodeName), fn as (...args: unknown[]) => unknown)
          : fn;
      return _originalAddNode!.call(this, nodeName, wrappedFn, ...rest);
    };

    _patchedStateGraph = true;
  }

  private _unpatchStateGraph(): void {
    if (!_patchedStateGraph) return;
    if (_stateGraphProto && _originalAddNode) {
      const addNodeKey = 'addNode' in _stateGraphProto ? 'addNode' : 'add_node';
      _stateGraphProto[addNodeKey] = _originalAddNode;
    }
    _stateGraphProto = null;
    _originalAddNode = null;
    _patchedStateGraph = false;
  }

  private _wrapNode(
    nodeName: string,
    fn: (...args: unknown[]) => unknown
  ): (...args: unknown[]) => unknown {
    const adapter = this;
    return async function wrappedNode(...args: unknown[]): Promise<unknown> {
      const state = args[0];
      const inputHash = _hashState(state);
      const graphRunId = _graphRunIdStorage.getStore() ?? 'unknown';
      const start = Date.now();
      try {
        const result = await Promise.resolve(fn(...args));
        const outputHash = _hashState(result ?? state);
        adapter._emitNodeEvent(nodeName, graphRunId, inputHash, outputHash, Date.now() - start, null);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        adapter._emitNodeEvent(nodeName, graphRunId, inputHash, inputHash, Date.now() - start, error);
        throw err;
      }
    };
  }

  private _emitNodeEvent(
    nodeName: string,
    graphRunId: string,
    inputHash: string,
    outputHash: string,
    durationMs: number,
    error: Error | null
  ): void {
    this.emitEvent({
      event_id: generateId('evt_'),
      event_type: 'NODE_EXECUTION',
      timestamp: nowIso(),
      node_name: nodeName,
      graph_run_id: graphRunId,
      session_id: this.sessionId,
      agent_id: this.agentId,
      duration_ms: durationMs,
      input_hash: inputHash,
      output_hash: outputHash,
      error: error?.message ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // CompiledGraph patching — wrap invoke() / ainvoke()
  // -------------------------------------------------------------------------

  private async _patchCompiledGraph(): Promise<void> {
    if (_patchedCompiledGraph) return;

    let lgModule: Record<string, unknown>;
    try {
      lgModule = (await import('@langchain/langgraph')) as Record<string, unknown>;
    } catch {
      return;
    }

    const CompiledGraph = (lgModule['CompiledGraph'] ?? lgModule['CompiledStateGraph']) as
      | { prototype: Record<string, (...args: unknown[]) => unknown> }
      | undefined;
    if (!CompiledGraph?.prototype) return;

    const proto = CompiledGraph.prototype;
    _compiledGraphProto = proto;

    if (typeof proto['invoke'] === 'function') {
      _originalInvoke = proto['invoke'];
      proto['invoke'] = this._makeInvokeWrapper(_originalInvoke, false);
    }

    if (typeof proto['ainvoke'] === 'function') {
      _originalAInvoke = proto['ainvoke'];
      proto['ainvoke'] = this._makeInvokeWrapper(_originalAInvoke, true);
    }

    _patchedCompiledGraph = true;
  }

  private _unpatchCompiledGraph(): void {
    if (!_patchedCompiledGraph) return;
    if (_compiledGraphProto) {
      if (_originalInvoke) _compiledGraphProto['invoke'] = _originalInvoke;
      if (_originalAInvoke) _compiledGraphProto['ainvoke'] = _originalAInvoke;
    }
    _compiledGraphProto = null;
    _originalInvoke = null;
    _originalAInvoke = null;
    _patchedCompiledGraph = false;
  }

  private _makeInvokeWrapper(
    origFn: (...args: unknown[]) => unknown,
    _isAsync: boolean
  ): (...args: unknown[]) => Promise<unknown> {
    const adapter = this;

    return async function patchedInvoke(
      this: Record<string, unknown>,
      input: unknown,
      config?: unknown,
      ...rest: unknown[]
    ): Promise<unknown> {
      const injectedConfig = adapter._injectConfig(config as Record<string, unknown>);
      const runId = generateId('lgrun_');
      const graphId = String(this['name'] ?? 'unknown');
      const inputHash = _hashState(input);
      const start = Date.now();

      return _graphRunIdStorage.run(
        runId,
        () =>
          withFrameworkContext(
            {
              framework: 'langgraph',
              agentId: adapter.agentId,
              sessionId: adapter.sessionId ?? 'unknown',
              runId,
              graphId,
              extra: {},
            },
            async () => {
              try {
                const result = await origFn.call(this, input, injectedConfig, ...rest);
                adapter._emitGraphEvent(
                  runId,
                  graphId,
                  Date.now() - start,
                  inputHash,
                  _hashState(result),
                  null,
                  false
                );
                return result;
              } catch (err) {
                const isStopError =
                  typeof err === 'object' &&
                  err !== null &&
                  (err as Record<string, unknown>)['name'] === 'GovernanceStopError';
                const error = err instanceof Error ? err : new Error(String(err));
                adapter._emitGraphEvent(
                  runId,
                  graphId,
                  Date.now() - start,
                  inputHash,
                  '',
                  error,
                  isStopError
                );
                throw err;
              }
            }
          )
      );
    };
  }

  private _emitGraphEvent(
    runId: string,
    graphId: string,
    durationMs: number,
    inputHash: string,
    outputHash: string,
    error: Error | null,
    didStopEarly: boolean
  ): void {
    this.emitEvent({
      event_id: generateId('evt_'),
      event_type: 'GRAPH_EXECUTION',
      timestamp: nowIso(),
      run_id: runId,
      graph_id: graphId,
      session_id: this.sessionId,
      agent_id: this.agentId,
      duration_ms: durationMs,
      input_hash: inputHash,
      output_hash: outputHash,
      error: error?.message ?? null,
      did_stop_early: didStopEarly,
    });
  }

  // -------------------------------------------------------------------------
  // Config injection
  // -------------------------------------------------------------------------

  private _injectConfig(config?: Record<string, unknown>): Record<string, unknown> {
    const lgCfg = this.getConfig('langgraph');
    const llmCfg = this.getConfig('llm');

    // Check if any relevant fields are set (non-null)
    const hasLgOverrides = Object.values(lgCfg).some((v) => v != null);
    const hasLlmOverrides = Object.values(llmCfg).some((v) => v != null);

    if (!hasLgOverrides && !hasLlmOverrides) return config ?? {};

    const result = { ...(config ?? {}) };
    const configurable = {
      ...((result['configurable'] as Record<string, unknown>) ?? {}),
    };

    if (lgCfg['recursion_limit'] != null) result['recursionLimit'] = lgCfg['recursion_limit'];
    if (lgCfg['interrupt_before'] != null) result['interruptBefore'] = lgCfg['interrupt_before'];
    if (lgCfg['interrupt_after'] != null) result['interruptAfter'] = lgCfg['interrupt_after'];
    if (lgCfg['thread_id'] != null) configurable['thread_id'] = lgCfg['thread_id'];
    if (lgCfg['max_concurrency'] != null) result['maxConcurrency'] = lgCfg['max_concurrency'];
    if (lgCfg['stream_mode'] != null) result['streamMode'] = lgCfg['stream_mode'];

    for (const key of ['temperature', 'max_tokens', 'model'] as const) {
      if (llmCfg[key] != null) configurable[key] = llmCfg[key];
    }

    result['configurable'] = configurable;
    return result;
  }

  // -------------------------------------------------------------------------
  // interrupt() patching — emit HITL_INTERRUPT
  // -------------------------------------------------------------------------

  private async _patchInterrupt(): Promise<void> {
    if (_patchedInterrupt) return;

    let lgModule: Record<string, unknown>;
    try {
      lgModule = (await import('@langchain/langgraph')) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof lgModule['interrupt'] !== 'function') return;

    _lgModuleRef = lgModule;
    _originalInterrupt = lgModule['interrupt'] as (...args: unknown[]) => unknown;

    const adapter = this;
    lgModule['interrupt'] = function patchedInterrupt(value: unknown, ...rest: unknown[]): unknown {
      adapter._emitInterruptEvent(value);
      return _originalInterrupt!(value, ...rest);
    };

    _patchedInterrupt = true;
  }

  private _unpatchInterrupt(): void {
    if (!_patchedInterrupt) return;
    if (_lgModuleRef && _originalInterrupt) {
      _lgModuleRef['interrupt'] = _originalInterrupt;
    }
    _lgModuleRef = null;
    _originalInterrupt = null;
    _patchedInterrupt = false;
  }

  private _emitInterruptEvent(interruptValue: unknown): void {
    this.emitEvent({
      event_id: generateId('evt_'),
      event_type: 'HITL_INTERRUPT',
      timestamp: nowIso(),
      session_id: this.sessionId,
      agent_id: this.agentId,
      graph_run_id: _graphRunIdStorage.getStore() ?? 'unknown',
      interrupt_value: interruptValue,
    });
  }
}
