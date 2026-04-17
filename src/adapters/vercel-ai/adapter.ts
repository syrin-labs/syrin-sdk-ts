/**
 * Vercel AI Adapter — Adapter class
 */

import { SyrinSDKBaseFrameworkAdapter } from '@/adapters/types.js';
import type { ISyrinCore, SchemaField } from '@/adapters/types.js';
import { patchVercelAI, unpatchVercelAI, _originalGenerateText, _originalStreamText, _originalGenerateObject } from './patch.js';
import { makeGenerateTextWrapper, makeStreamTextWrapper, makeGenerateObjectWrapper } from './wrappers.js';

export class VercelAIAdapter extends SyrinSDKBaseFrameworkAdapter {
  readonly name = 'vercel-ai';

  override configSchema(): Record<string, SchemaField[]> {
    // Adapters are telemetry-only — config schema is declared by users via sdk.cfg()
    return {};
  }

  protected async _doInstall(_core: ISyrinCore): Promise<void> {
    await patchVercelAI(this);
  }

  protected _doUninstall(): void {
    unpatchVercelAI();
  }

  /**
   * Instrumented generateText — use this instead of importing from 'ai' directly
   * when ESM module patching is unavailable.
   */
  async generateText(opts: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> {
    const orig = _originalGenerateText ?? ((await import('ai')) as Record<string, unknown>)['generateText'] as (...args: unknown[]) => unknown;
    return makeGenerateTextWrapper(this, orig)(opts, ...rest);
  }

  /**
   * Instrumented streamText — use this instead of importing from 'ai' directly
   * when ESM module patching is unavailable.
   */
  streamText(opts: Record<string, unknown>, ...rest: unknown[]): unknown {
    // Note: _originalStreamText may be null before install; fall back gracefully
    if (!_originalStreamText) {
      throw new Error('[Syrin] VercelAIAdapter.streamText() called before adapter is installed');
    }
    return makeStreamTextWrapper(this, _originalStreamText)(opts, ...rest);
  }

  /**
   * Instrumented generateObject — use this instead of importing from 'ai' directly
   * when ESM module patching is unavailable.
   */
  async generateObject(opts: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> {
    const orig = _originalGenerateObject ?? ((await import('ai')) as Record<string, unknown>)['generateObject'] as (...args: unknown[]) => unknown;
    return makeGenerateObjectWrapper(this, orig)(opts, ...rest);
  }
}
