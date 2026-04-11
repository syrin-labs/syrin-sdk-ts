/**
 * Vercel AI Adapter — Module patching mechanics
 */

import type { VercelAIAdapterLike } from './wrappers.js';
import { makeGenerateTextWrapper, makeStreamTextWrapper, makeGenerateObjectWrapper } from './wrappers.js';

// Module-level patch state (singleton per process)
export let _patchedVercelAI = false;
export let _aiModuleRef: Record<string, unknown> | null = null;
export let _originalGenerateText: ((...args: unknown[]) => unknown) | null = null;
export let _originalStreamText: ((...args: unknown[]) => unknown) | null = null;
export let _originalGenerateObject: ((...args: unknown[]) => unknown) | null = null;

export async function patchVercelAI(adapter: VercelAIAdapterLike): Promise<void> {
  if (_patchedVercelAI) return;

  let aiModule: Record<string, unknown>;
  try {
    aiModule = (await import('ai')) as Record<string, unknown>;
  } catch {
    return;
  }

  _aiModuleRef = aiModule;

  if (typeof aiModule['generateText'] === 'function') {
    _originalGenerateText = aiModule['generateText'] as (...args: unknown[]) => unknown;
    aiModule['generateText'] = makeGenerateTextWrapper(adapter, _originalGenerateText);
  }

  if (typeof aiModule['streamText'] === 'function') {
    _originalStreamText = aiModule['streamText'] as (...args: unknown[]) => unknown;
    aiModule['streamText'] = makeStreamTextWrapper(adapter, _originalStreamText);
  }

  if (typeof aiModule['generateObject'] === 'function') {
    _originalGenerateObject = aiModule['generateObject'] as (...args: unknown[]) => unknown;
    aiModule['generateObject'] = makeGenerateObjectWrapper(adapter, _originalGenerateObject);
  }

  _patchedVercelAI = true;
}

export function unpatchVercelAI(): void {
  if (!_patchedVercelAI) return;
  if (_aiModuleRef) {
    if (_originalGenerateText) _aiModuleRef['generateText'] = _originalGenerateText;
    if (_originalStreamText) _aiModuleRef['streamText'] = _originalStreamText;
    if (_originalGenerateObject) _aiModuleRef['generateObject'] = _originalGenerateObject;
  }
  _aiModuleRef = null;
  _originalGenerateText = null;
  _originalStreamText = null;
  _originalGenerateObject = null;
  _patchedVercelAI = false;
}
