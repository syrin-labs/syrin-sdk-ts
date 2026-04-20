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

  // ESM live bindings are read-only — use a safe setter
  const trySet = (key: string, value: unknown): boolean => {
    try { aiModule[key] = value; return true; } catch { return false; }
  };

  if (typeof aiModule['generateText'] === 'function') {
    _originalGenerateText = aiModule['generateText'] as (...args: unknown[]) => unknown;
    trySet('generateText', makeGenerateTextWrapper(adapter, _originalGenerateText));
  }

  if (typeof aiModule['streamText'] === 'function') {
    _originalStreamText = aiModule['streamText'] as (...args: unknown[]) => unknown;
    trySet('streamText', makeStreamTextWrapper(adapter, _originalStreamText));
  }

  if (typeof aiModule['generateObject'] === 'function') {
    _originalGenerateObject = aiModule['generateObject'] as (...args: unknown[]) => unknown;
    trySet('generateObject', makeGenerateObjectWrapper(adapter, _originalGenerateObject));
  }

  _patchedVercelAI = true;
}

export function unpatchVercelAI(): void {
  if (!_patchedVercelAI) return;
  const trySet = (ref: Record<string, unknown>, key: string, value: unknown) => {
    try { ref[key] = value; } catch { /* read-only ESM binding */ }
  };
  if (_aiModuleRef) {
    if (_originalGenerateText) trySet(_aiModuleRef, 'generateText', _originalGenerateText);
    if (_originalStreamText) trySet(_aiModuleRef, 'streamText', _originalStreamText);
    if (_originalGenerateObject) trySet(_aiModuleRef, 'generateObject', _originalGenerateObject);
  }
  _aiModuleRef = null;
  _originalGenerateText = null;
  _originalStreamText = null;
  _originalGenerateObject = null;
  _patchedVercelAI = false;
}
