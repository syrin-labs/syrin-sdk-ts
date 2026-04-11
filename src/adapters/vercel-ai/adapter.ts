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
    return {
      llm: [
        { name: 'model',             type: 'str',   default: null },
        { name: 'temperature',       type: 'float', default: null, constraints: { ge: 0.0, le: 2.0 } },
        { name: 'max_tokens',        type: 'int',   default: null, constraints: { ge: 1 } },
        { name: 'top_p',             type: 'float', default: null, constraints: { ge: 0.0, le: 1.0 } },
        { name: 'frequency_penalty', type: 'float', default: null, constraints: { ge: -2.0, le: 2.0 } },
        { name: 'presence_penalty',  type: 'float', default: null, constraints: { ge: -2.0, le: 2.0 } },
        { name: 'seed',              type: 'int',   default: null },
      ],
      prompt: [
        { name: 'system_prompt', type: 'str', default: null, multiline: true },
      ],
      vercel: [
        /** Max agentic tool-call rounds per generateText() call */
        { name: 'max_steps',             type: 'int',  default: 5,     constraints: { ge: 1, le: 50  } },
        /** Retry failed calls this many times with exponential back-off */
        { name: 'max_retries',           type: 'int',  default: 2,     constraints: { ge: 0, le: 10  } },
        /** Abort after this many milliseconds (0 = no timeout) */
        { name: 'abort_after_ms',        type: 'int',  default: 0,     constraints: { ge: 0          } },
        /** Apply structured output via the Vercel AI schema helpers */
        { name: 'structured_output',     type: 'bool', default: false },
      ],
    };
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
