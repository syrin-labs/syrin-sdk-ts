/**
 * Tests for interceptors/gemini.ts — covers @google/genai API,
 * result extraction, error handling, and unpatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { patchWithModule, unpatch, isPatched } from '@/interceptors/gemini.js';
import type { ICallTarget, BeforeCallResult, NormalizedCallParams, NormalizedCallResult } from '@/core/call-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCore(overrides: Partial<ICallTarget> = {}): ICallTarget {
  return {
    config: { debug: false, captureContent: false } as ICallTarget['config'],
    sessionStore: {} as ICallTarget['sessionStore'],
    beforeCall: vi.fn().mockResolvedValue({
      modifiedRaw: { model: 'gemini-2.0-flash', contents: 'Hello', config: {} },
      sessionId: 'ses_test',
      agentId: null,
      configApplied: false,
    } as BeforeCallResult),
    afterCall: vi.fn(),
    onStreamComplete: vi.fn(),
    onCallError: vi.fn(),
    ...overrides,
  } as unknown as ICallTarget;
}

function makeBeforeCallResult(overrides: Partial<BeforeCallResult> = {}): BeforeCallResult {
  return {
    modifiedRaw: { model: 'gemini-2.0-flash', contents: 'Hello' },
    sessionId: 'ses_test',
    agentId: null,
    configApplied: false,
    ...overrides,
  } as BeforeCallResult;
}

function makeGeminiResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'Hello from Gemini!',
    candidates: [
      {
        content: { parts: [{ text: 'Hello from Gemini!' }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      totalTokenCount: 30,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock module builder
// ---------------------------------------------------------------------------

function makeGoogleModule(generateImpl: (...args: unknown[]) => unknown) {
  class MockModels {
    generateContent = generateImpl;
  }

  class MockGoogleGenAI {
    models = new MockModels();
  }

  return { GoogleGenAI: MockGoogleGenAI };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  unpatch();
});

afterEach(() => {
  unpatch();
});

// ---------------------------------------------------------------------------
// @google/genai — patchWithModule
// ---------------------------------------------------------------------------

describe('patchWithModule (@google/genai)', () => {
  it('marks as patched', () => {
    const core = makeCore();
    const mod = makeGoogleModule(vi.fn().mockResolvedValue(makeGeminiResponse()));
    patchWithModule(mod, core);
    expect(isPatched()).toBe(true);
  });

  it('is idempotent — second call does not double-wrap', () => {
    const core = makeCore();
    const mod = makeGoogleModule(vi.fn().mockResolvedValue(makeGeminiResponse()));
    patchWithModule(mod, core);
    patchWithModule(mod, core);
    expect(isPatched()).toBe(true);
  });

  it('unpatch() restores original and unmarks patched', () => {
    const core = makeCore();
    const mod = makeGoogleModule(vi.fn().mockResolvedValue(makeGeminiResponse()));
    patchWithModule(mod, core);
    unpatch();
    expect(isPatched()).toBe(false);
  });

  it('calls beforeCall and afterCall on successful generate', async () => {
    const origGenerate = vi.fn().mockResolvedValue(makeGeminiResponse());
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult({
        modifiedRaw: { model: 'gemini-2.0-flash', contents: 'Hi' },
      })),
    });

    const mod = makeGoogleModule(origGenerate);
    patchWithModule(mod, core);

    const client = new (mod.GoogleGenAI as unknown as new (opts: { apiKey: string }) => { models: { generateContent: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Hi' });

    expect(core.beforeCall).toHaveBeenCalledOnce();
    expect(core.afterCall).toHaveBeenCalledOnce();
  });

  it('passes model from params to the normalized result', async () => {
    const origGenerate = vi.fn().mockResolvedValue(makeGeminiResponse());

    let capturedResult: NormalizedCallResult | null = null;
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult({
        modifiedRaw: { model: 'gemini-2.0-flash', contents: 'Hi' },
      })),
      afterCall: vi.fn((_ctx, _params, result) => { capturedResult = result as NormalizedCallResult; }),
    });

    const mod = makeGoogleModule(origGenerate);
    patchWithModule(mod, core);

    const client = new (mod.GoogleGenAI as unknown as new (opts: { apiKey: string }) => { models: { generateContent: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Hi' });

    expect(capturedResult?.model).toBe('gemini-2.0-flash');
  });

  it('extracts usageMetadata token counts', async () => {
    const origGenerate = vi.fn().mockResolvedValue(makeGeminiResponse({
      usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 75, totalTokenCount: 100 },
    }));

    let capturedResult: NormalizedCallResult | null = null;
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult({
        modifiedRaw: { model: 'gemini-2.0-flash', contents: 'Hi' },
      })),
      afterCall: vi.fn((_ctx, _params, result) => { capturedResult = result as NormalizedCallResult; }),
    });

    const mod = makeGoogleModule(origGenerate);
    patchWithModule(mod, core);

    const client = new (mod.GoogleGenAI as unknown as new (opts: { apiKey: string }) => { models: { generateContent: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Hi' });

    expect(capturedResult?.inputTokens).toBe(25);
    expect(capturedResult?.outputTokens).toBe(75);
  });

  it('uses candidates[0].finishReason as finishReason', async () => {
    const origGenerate = vi.fn().mockResolvedValue(makeGeminiResponse({
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'truncated' }] } }],
    }));

    let capturedResult: NormalizedCallResult | null = null;
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult({
        modifiedRaw: { model: 'gemini-2.0-flash', contents: 'Hi' },
      })),
      afterCall: vi.fn((_ctx, _params, result) => { capturedResult = result as NormalizedCallResult; }),
    });

    const mod = makeGoogleModule(origGenerate);
    patchWithModule(mod, core);

    const client = new (mod.GoogleGenAI as unknown as new (opts: { apiKey: string }) => { models: { generateContent: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Hi' });

    expect(capturedResult?.finishReason?.toLowerCase()).toBe('max_tokens');
  });

  it('calls onCallError and re-throws on failure', async () => {
    const error = new Error('quota exceeded');
    const origGenerate = vi.fn().mockRejectedValue(error);
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult({
        modifiedRaw: { model: 'gemini-2.0-flash', contents: 'Hi' },
      })),
      onCallError: vi.fn(),
    });

    const mod = makeGoogleModule(origGenerate);
    patchWithModule(mod, core);

    const client = new (mod.GoogleGenAI as unknown as new (opts: { apiKey: string }) => { models: { generateContent: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await expect(client.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Hi' })).rejects.toThrow('quota exceeded');

    expect(core.onCallError).toHaveBeenCalledOnce();
    expect(core.afterCall).not.toHaveBeenCalled();
  });

  it('returns original response unchanged', async () => {
    const response = makeGeminiResponse({ text: 'unique response' });
    const origGenerate = vi.fn().mockResolvedValue(response);
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult({
        modifiedRaw: { model: 'gemini-2.0-flash', contents: 'Hi' },
      })),
    });

    const mod = makeGoogleModule(origGenerate);
    patchWithModule(mod, core);

    const client = new (mod.GoogleGenAI as unknown as new (opts: { apiKey: string }) => { models: { generateContent: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    const result = await client.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Hi' });

    expect(result).toBe(response);
  });

  it('normalizes string contents to messages array', async () => {
    const origGenerate = vi.fn().mockResolvedValue(makeGeminiResponse());

    let capturedParams: NormalizedCallParams | null = null;
    const core = makeCore({
      beforeCall: vi.fn().mockImplementation(async (params: NormalizedCallParams) => {
        capturedParams = params;
        return makeBeforeCallResult({ modifiedRaw: { ...params.raw } });
      }),
    });

    const mod = makeGoogleModule(origGenerate);
    patchWithModule(mod, core);

    const client = new (mod.GoogleGenAI as unknown as new (opts: { apiKey: string }) => { models: { generateContent: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Tell me a joke' });

    expect(capturedParams?.messages).toHaveLength(1);
    expect(capturedParams?.messages[0].role).toBe('user');
    expect(capturedParams?.messages[0].content).toBe('Tell me a joke');
  });
});

// ---------------------------------------------------------------------------
// Content capture
// ---------------------------------------------------------------------------

describe('content capture', () => {
  it('includes responseText when captureContent=true', async () => {
    const origGenerate = vi.fn().mockResolvedValue(makeGeminiResponse({ text: 'gemini answer' }));

    let capturedResult: NormalizedCallResult | null = null;
    const core = makeCore({
      config: { debug: false, captureContent: true } as ICallTarget['config'],
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult({
        modifiedRaw: { model: 'gemini-2.0-flash', contents: 'Hi' },
      })),
      afterCall: vi.fn((_ctx, _params, result) => { capturedResult = result as NormalizedCallResult; }),
    });

    const mod = makeGoogleModule(origGenerate);
    patchWithModule(mod, core);

    const client = new (mod.GoogleGenAI as unknown as new (opts: { apiKey: string }) => { models: { generateContent: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Hi' });

    expect(capturedResult?.responseText).toBe('gemini answer');
  });

  it('omits responseText when captureContent=false', async () => {
    const origGenerate = vi.fn().mockResolvedValue(makeGeminiResponse({ text: 'secret' }));

    let capturedResult: NormalizedCallResult | null = null;
    const core = makeCore({
      beforeCall: vi.fn().mockResolvedValue(makeBeforeCallResult({
        modifiedRaw: { model: 'gemini-2.0-flash', contents: 'Hi' },
      })),
      afterCall: vi.fn((_ctx, _params, result) => { capturedResult = result as NormalizedCallResult; }),
    });

    const mod = makeGoogleModule(origGenerate);
    patchWithModule(mod, core);

    const client = new (mod.GoogleGenAI as unknown as new (opts: { apiKey: string }) => { models: { generateContent: (...a: unknown[]) => Promise<unknown> } })({ apiKey: 'test' });
    await client.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Hi' });

    expect(capturedResult?.responseText).toBeUndefined();
  });
});
