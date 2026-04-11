/**
 * Mastra Adapter — Generate and stream wrappers
 */

import { withFrameworkContext } from '@/agent/framework-context.js';
import { generateId } from '@/utils/helpers.js';
import type { SyrinSDKBaseFrameworkAdapter } from '@/adapters/types.js';
import { extractModelInfo } from './adapter.js';

export interface MastraAdapterLike extends SyrinSDKBaseFrameworkAdapter {
  readonly agentId: string | undefined;
  readonly sessionId: string | undefined;
  readonly captureContent: boolean;
  getConfig(namespace: string): Record<string, unknown>;
  emitLlmCallEvent(data: {
    agentName?: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    error: string | null;
    operation?: string;
    promptMessages?: Array<{ role: string; content: string }>;
    completionText?: string;
  }): void;
}

export function makeGenerateWrapper(
  adapter: MastraAdapterLike,
  origFn: (...args: unknown[]) => unknown,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedGenerate(
    this: Record<string, unknown>,
    prompt: unknown,
    opts?: unknown,
    ...rest: unknown[]
  ): Promise<unknown> {
    const agentName = typeof this['name'] === 'string' ? this['name'] : 'unknown';
    const { modelId, provider } = extractModelInfo(this['model']);

    const llmCfg = adapter.getConfig('llm');
    const mastraCfg = adapter.getConfig('mastra');
    const promptCfg = adapter.getConfig('prompt');
    const injectedOpts = _injectLlmConfig(opts as Record<string, unknown> | undefined, llmCfg, mastraCfg, promptCfg);

    const runId = generateId('mrun_');
    const start = Date.now();

    // Resolve instructions — remote config overrides agent's own instructions
    const remoteSystemPrompt = promptCfg['system_prompt'];
    const resolvedInstructions = typeof remoteSystemPrompt === 'string' && remoteSystemPrompt
      ? remoteSystemPrompt
      : await _resolveInstructions(this);

    return withFrameworkContext(
      {
        framework: 'mastra',
        agentId: adapter.agentId,
        sessionId: adapter.sessionId ?? 'unknown',
        runId,
        extra: { agentName },
      },
      async () => {
        try {
          const result = (await origFn.call(this, prompt, injectedOpts, ...rest)) as {
            text?: string;
            usage?: {
              promptTokens?: number;
              completionTokens?: number;
              totalTokens?: number;
            } | null;
          } | null;

          const usage = result?.usage as Record<string, number> | null | undefined;
          const inputTokens = (usage?.['inputTokens'] ?? usage?.['promptTokens']) ?? 0;
          const outputTokens = (usage?.['outputTokens'] ?? usage?.['completionTokens']) ?? 0;

          // Build prompt messages for content capture
          const promptMsg = _buildPromptMessages(resolvedInstructions, prompt);

          adapter.emitLlmCallEvent({
            agentName,
            model: modelId,
            provider,
            inputTokens,
            outputTokens,
            durationMs: Date.now() - start,
            error: null,
            promptMessages: promptMsg.length > 0 ? promptMsg : undefined,
            completionText: result?.text,
          });

          return result;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          adapter.emitLlmCallEvent({
            agentName,
            model: modelId,
            provider,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: Date.now() - start,
            error: error.message,
          });
          throw err;
        }
      },
    );
  };
}

export function makeStreamWrapper(
  adapter: MastraAdapterLike,
  origFn: (...args: unknown[]) => unknown,
): (...args: unknown[]) => Promise<unknown> {
  return async function patchedStream(
    this: Record<string, unknown>,
    prompt: unknown,
    opts?: unknown,
    ...rest: unknown[]
  ): Promise<unknown> {
    const agentName = typeof this['name'] === 'string' ? this['name'] : 'unknown';
    const { modelId, provider } = extractModelInfo(this['model']);

    const llmCfg = adapter.getConfig('llm');
    const mastraCfg = adapter.getConfig('mastra');
    const promptCfg = adapter.getConfig('prompt');
    const injectedOpts = _injectLlmConfig(opts as Record<string, unknown> | undefined, llmCfg, mastraCfg, promptCfg);

    const start = Date.now();
    const remoteSystemPrompt = promptCfg['system_prompt'];
    const resolvedInstructions = typeof remoteSystemPrompt === 'string' && remoteSystemPrompt
      ? remoteSystemPrompt
      : await _resolveInstructions(this);
    const promptMsg = _buildPromptMessages(resolvedInstructions, prompt);

    const streamResult = (await Promise.resolve(
      origFn.call(this, prompt, injectedOpts, ...rest),
    )) as Record<string, unknown>;

    if (streamResult && typeof streamResult === 'object' && 'textStream' in streamResult) {
      const originalTextStream = streamResult['textStream'] as AsyncIterable<string>;

      async function* patchedTextStream(): AsyncGenerator<string> {
        try {
          for await (const chunk of originalTextStream) {
            yield chunk;
          }
          const usageRaw = await Promise.resolve(streamResult['usage']);
          const usage = usageRaw as Record<string, number> | null | undefined;
          const inputTokens = (usage?.['inputTokens'] ?? usage?.['promptTokens']) ?? 0;
          const outputTokens = (usage?.['outputTokens'] ?? usage?.['completionTokens']) ?? 0;
          adapter.emitLlmCallEvent({
            agentName,
            model: modelId,
            provider,
            inputTokens,
            outputTokens,
            durationMs: Date.now() - start,
            error: null,
            promptMessages: promptMsg.length > 0 ? promptMsg : undefined,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          adapter.emitLlmCallEvent({
            agentName,
            model: modelId,
            provider,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: Date.now() - start,
            error: error.message,
          });
          throw err;
        }
      }

      return { ...streamResult, textStream: patchedTextStream() };
    }

    const asyncIter = (streamResult as unknown as AsyncIterable<unknown>)?.[Symbol.asyncIterator];
    if (typeof asyncIter !== 'function') {
      adapter.emitLlmCallEvent({
        agentName, model: modelId, provider,
        inputTokens: 0, outputTokens: 0,
        durationMs: Date.now() - start, error: null,
      });
      return streamResult;
    }

    async function* wrappedIterable(): AsyncGenerator<unknown> {
      try {
        for await (const chunk of streamResult as unknown as AsyncIterable<unknown>) {
          yield chunk;
        }
        adapter.emitLlmCallEvent({
          agentName, model: modelId, provider,
          inputTokens: 0, outputTokens: 0,
          durationMs: Date.now() - start, error: null,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        adapter.emitLlmCallEvent({
          agentName, model: modelId, provider,
          inputTokens: 0, outputTokens: 0,
          durationMs: Date.now() - start, error: error.message,
        });
        throw err;
      }
    }

    return wrappedIterable();
  };
}

/**
 * Resolve agent instructions by calling the async getInstructions() method that
 * Mastra exposes. Falls back to direct property access for non-Mastra adapters.
 * Returns the instruction string, or null if not available.
 */
async function _resolveInstructions(agentThis: Record<string, unknown>): Promise<string | null> {
  // Mastra agents expose getInstructions() which resolves #private field
  if (typeof agentThis['getInstructions'] === 'function') {
    try {
      const raw = await (agentThis['getInstructions'] as () => Promise<unknown>)();
      return _extractInstructionText(raw);
    } catch { /* ignore — dynamic instructions may need request context */ }
  }

  // Fallback: check public property names used in older Mastra / other adapters
  const fallback =
    agentThis['instructions'] ??
    agentThis['_instructions'] ??
    agentThis['systemPrompt'] ??
    agentThis['system'];

  if (typeof fallback === 'string') return fallback;
  if (typeof fallback === 'function') {
    try {
      const r = (fallback as () => unknown)();
      if (typeof r === 'string') return r;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Extract a plain string from Mastra's SystemMessage union type:
 * string | string[] | CoreSystemMessage | SystemModelMessage | ...[]
 */
function _extractInstructionText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw || null;
  if (Array.isArray(raw)) {
    const parts = raw.map(_extractInstructionText).filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj['content'] === 'string') return obj['content'] || null;
    if (typeof obj['text'] === 'string') return obj['text'] || null;
  }
  return null;
}

/**
 * Build the prompt_messages array for content capture.
 * The user prompt can be a plain string or an object with a `messages` array.
 */
function _buildPromptMessages(
  systemInstruction: string | null,
  prompt: unknown,
): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = [];

  if (systemInstruction) result.push({ role: 'system', content: systemInstruction });

  if (typeof prompt === 'string') {
    result.push({ role: 'user', content: prompt });
  } else if (prompt && typeof prompt === 'object') {
    const p = prompt as Record<string, unknown>;
    // Object form: { messages: [...] }
    const msgs = Array.isArray(p['messages']) ? p['messages'] : null;
    if (msgs) {
      for (const msg of msgs) {
        const m = msg as Record<string, unknown>;
        if (typeof m['role'] === 'string') {
          const content = typeof m['content'] === 'string'
            ? m['content']
            : JSON.stringify(m['content'] ?? '');
          result.push({ role: m['role'], content });
        }
      }
    } else if (typeof p['prompt'] === 'string') {
      // Object form: { prompt: "..." }
      result.push({ role: 'user', content: p['prompt'] });
    }
  }

  return result;
}

function _injectLlmConfig(
  opts: Record<string, unknown> | undefined,
  llmCfg: Record<string, unknown>,
  mastraCfg: Record<string, unknown> = {},
  promptCfg: Record<string, unknown> = {},
): Record<string, unknown> {
  const result = { ...(opts ?? {}) };

  // LLM params
  for (const key of ['temperature', 'model', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'] as const) {
    if (llmCfg[key] != null) result[key] = llmCfg[key];
  }
  if (llmCfg['max_tokens'] != null) result['maxTokens'] = llmCfg['max_tokens'];

  // System prompt override — passed as AgentGenerateOptions.instructions
  if (typeof promptCfg['system_prompt'] === 'string' && promptCfg['system_prompt']) {
    result['instructions'] = promptCfg['system_prompt'];
  }

  // Mastra-specific params
  if (mastraCfg['max_steps'] != null) result['maxSteps'] = mastraCfg['max_steps'];
  if (mastraCfg['max_retries'] != null) result['maxRetries'] = mastraCfg['max_retries'];

  return result;
}
