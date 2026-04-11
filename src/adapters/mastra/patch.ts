/**
 * Mastra Adapter — Agent patching mechanics
 */

import type { MastraAdapterLike } from './stream.js';
import { makeGenerateWrapper, makeStreamWrapper } from './stream.js';

// Module-level patch state (singleton per process)
export let _patchedMastra = false;
export let _agentProto: Record<string, unknown> | null = null;
export let _originalGenerate: ((...args: unknown[]) => unknown) | null = null;
export let _originalStream: ((...args: unknown[]) => unknown) | null = null;

export async function patchAgent(adapter: MastraAdapterLike): Promise<void> {
  if (_patchedMastra) return;

  let mastraModule: Record<string, unknown>;
  try {
    mastraModule = (await import('@mastra/core/agent')) as Record<string, unknown>;
  } catch {
    return;
  }

  const AgentClass = mastraModule['Agent'] as
    | { prototype: Record<string, unknown> }
    | undefined;

  if (!AgentClass?.prototype) return;

  const proto = AgentClass.prototype;
  _agentProto = proto;

  if (typeof proto['generate'] === 'function') {
    _originalGenerate = proto['generate'] as (...args: unknown[]) => unknown;
    proto['generate'] = makeGenerateWrapper(adapter, _originalGenerate);
  }

  if (typeof proto['stream'] === 'function') {
    _originalStream = proto['stream'] as (...args: unknown[]) => unknown;
    proto['stream'] = makeStreamWrapper(adapter, _originalStream);
  }

  _patchedMastra = true;
}

export function unpatchAgent(): void {
  if (!_patchedMastra) return;
  if (_agentProto) {
    if (_originalGenerate) _agentProto['generate'] = _originalGenerate;
    if (_originalStream) _agentProto['stream'] = _originalStream;
  }
  _agentProto = null;
  _originalGenerate = null;
  _originalStream = null;
  _patchedMastra = false;
}
