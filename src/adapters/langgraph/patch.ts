/**
 * LangGraph Adapter — Graph patching mechanics
 */

import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import { withFrameworkContext, getFrameworkContext } from '@/agent/framework-context.js';
import { generateId } from '@/utils/helpers.js';
import { emitGraphExecution, emitNodeExecution, emitHITL, injectLangGraphConfig, type LangGraphAdapterEmitter } from './events.js';

export const _graphRunIdStorage = new AsyncLocalStorage<string>();

// Module-level patch state (singleton per process)
export let _patchedStateGraph = false;
export let _patchedCompiledGraph = false;
export let _patchedInterrupt = false;

export let _stateGraphProto: Record<string, unknown> | null = null;
export let _originalAddNode: ((...args: unknown[]) => unknown) | null = null;

export let _compiledGraphProto: Record<string, (...args: unknown[]) => unknown> | null = null;
export let _originalInvoke: ((...args: unknown[]) => unknown) | null = null;
export let _originalAInvoke: ((...args: unknown[]) => unknown) | null = null;

export let _lgModuleRef: Record<string, unknown> | null = null;
export let _originalInterrupt: ((...args: unknown[]) => unknown) | null = null;

export function hashState(state: unknown): string {
  try {
    const text = JSON.stringify(state, (_k, v) =>
      typeof v === 'bigint' ? String(v) : v
    );
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  } catch {
    return createHash('sha256').update(String(state)).digest('hex').slice(0, 16);
  }
}

export async function patchStateGraph(adapter: LangGraphAdapterEmitter): Promise<void> {
  if (_patchedStateGraph) return;

  let lgModule: Record<string, unknown>;
  try {
    lgModule = (await import('@langchain/langgraph')) as Record<string, unknown>;
  } catch {
    return;
  }

  const StateGraph = (lgModule['StateGraph'] ?? lgModule['CompiledStateGraph']) as
    | { prototype: Record<string, unknown> }
    | undefined;
  if (!StateGraph?.prototype) return;

  const proto = StateGraph.prototype;
  const addNodeKey = 'addNode' in proto ? 'addNode' : 'add_node' in proto ? 'add_node' : null;
  if (!addNodeKey) return;

  _originalAddNode = proto[addNodeKey] as (...args: unknown[]) => unknown;
  _stateGraphProto = proto;

  proto[addNodeKey] = function patchedAddNode(
    nodeName: unknown,
    fn: unknown,
    ...rest: unknown[]
  ): unknown {
    const wrappedFn =
      typeof fn === 'function'
        ? wrapNode(String(nodeName), fn as (...args: unknown[]) => unknown, adapter)
        : fn;
    return _originalAddNode!.call(this, nodeName, wrappedFn, ...rest);
  };

  _patchedStateGraph = true;
}

export function unpatchStateGraph(): void {
  if (!_patchedStateGraph) return;
  if (_stateGraphProto && _originalAddNode) {
    const addNodeKey = 'addNode' in _stateGraphProto ? 'addNode' : 'add_node';
    _stateGraphProto[addNodeKey] = _originalAddNode;
  }
  _stateGraphProto = null;
  _originalAddNode = null;
  _patchedStateGraph = false;
}

function wrapNode(
  nodeName: string,
  fn: (...args: unknown[]) => unknown,
  adapter: LangGraphAdapterEmitter
): (...args: unknown[]) => unknown {
  return async function wrappedNode(...args: unknown[]): Promise<unknown> {
    const state = args[0];
    const inputHash = hashState(state);
    const graphRunId = _graphRunIdStorage.getStore() ?? 'unknown';
    const start = Date.now();

    // Update FrameworkContext with the current node name so LLM_CALL events
    // emitted by a Tier 1 adapter (OpenAI) know which node triggered them.
    const parentCtx = getFrameworkContext();

    const runNode = async () => {
      try {
        const result = await Promise.resolve(fn(...args));
        const outputHash = hashState(result ?? state);
        emitNodeExecution(adapter, nodeName, graphRunId, inputHash, outputHash, Date.now() - start, null);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        emitNodeExecution(adapter, nodeName, graphRunId, inputHash, inputHash, Date.now() - start, error);
        throw err;
      }
    };

    if (parentCtx) {
      // Run inside updated context so LLM calls inherit nodeName
      return withFrameworkContext({ ...parentCtx, nodeName }, runNode);
    }
    return runNode();
  };
}

export async function patchCompiledGraph(adapter: LangGraphAdapterEmitter): Promise<void> {
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
    proto['invoke'] = makeInvokeWrapper(_originalInvoke, adapter);
  }

  if (typeof proto['ainvoke'] === 'function') {
    _originalAInvoke = proto['ainvoke'];
    proto['ainvoke'] = makeInvokeWrapper(_originalAInvoke, adapter);
  }

  _patchedCompiledGraph = true;
}

export function unpatchCompiledGraph(): void {
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

function makeInvokeWrapper(
  origFn: (...args: unknown[]) => unknown,
  adapter: LangGraphAdapterEmitter,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedInvoke(
    this: Record<string, unknown>,
    input: unknown,
    config?: unknown,
    ...rest: unknown[]
  ): Promise<unknown> {
    const injectedConfig = injectLangGraphConfig(adapter, config as Record<string, unknown>);
    const runId = generateId('lgrun_');
    const graphId = String(this['name'] ?? 'unknown');
    const inputHash = hashState(input);
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
              emitGraphExecution(
                adapter,
                runId,
                graphId,
                Date.now() - start,
                inputHash,
                hashState(result),
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
              emitGraphExecution(
                adapter,
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

export async function patchInterrupt(adapter: LangGraphAdapterEmitter): Promise<void> {
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

  try {
    lgModule['interrupt'] = function patchedInterrupt(value: unknown, ...rest: unknown[]): unknown {
      const graphRunId = _graphRunIdStorage.getStore() ?? 'unknown';
      emitHITL(adapter, graphRunId, value);
      return _originalInterrupt!(value, ...rest);
    };
  } catch {
    // ESM module bindings are read-only — skip patching interrupt (non-fatal)
    _patchedInterrupt = false;
    return;
  }

  _patchedInterrupt = true;
}

export function unpatchInterrupt(): void {
  if (!_patchedInterrupt) return;
  if (_lgModuleRef && _originalInterrupt) {
    try { _lgModuleRef['interrupt'] = _originalInterrupt; } catch { /* read-only ESM binding */ }
  }
  _lgModuleRef = null;
  _originalInterrupt = null;
  _patchedInterrupt = false;
}
