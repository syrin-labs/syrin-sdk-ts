/**
 * LangChain LLM patch — BaseChatModel.prototype.generate
 *
 * Patches the shared BaseChatModel.prototype.generate from @langchain/core so that
 * LLM_CALL events are captured for ALL LangChain-based models (ChatOpenAI, etc.)
 * regardless of which openai package version they use internally.
 *
 * This works for both LangChain chains and LangGraph nodes because both ultimately
 * call BaseChatModel.generate(). The FrameworkContext (set by wrap() or wrapNode())
 * is read at emit time to populate framework / graph_id / node_name.
 */

import { getFrameworkContext } from '@/agent/framework-context.js';
import { generateId, nowIso, estimateCost } from '@/utils/helpers.js';
import { sessionStorage } from '@/core/session.js';

export interface LLMPatchEmitter {
  emitEvent(event: Record<string, unknown>): void;
  get agentId(): string | undefined;
  get captureContent(): boolean;
}

// Module-level singleton state
let _patched = false;
let _originalGenerate: ((...args: unknown[]) => unknown) | null = null;
let _proto: Record<string, unknown> | null = null;
const _emitters: LLMPatchEmitter[] = [];

export async function patchBaseChatModel(emitter: LLMPatchEmitter): Promise<void> {
  // Register emitter (avoid duplicates)
  if (!_emitters.includes(emitter)) _emitters.push(emitter);
  if (_patched) return;

  let lcModule: Record<string, unknown>;
  try {
    lcModule = (await import('@langchain/core/language_models/chat_models')) as Record<string, unknown>;
  } catch {
    return; // @langchain/core not installed — skip silently
  }

  const BaseChatModel = lcModule['BaseChatModel'] as
    | { prototype: Record<string, unknown> }
    | undefined;
  if (!BaseChatModel?.prototype) return;

  const proto = BaseChatModel.prototype;
  if (typeof proto['generate'] !== 'function') return;

  _originalGenerate = proto['generate'] as (...args: unknown[]) => unknown;
  _proto = proto;

  proto['generate'] = async function patchedGenerate(
    this: Record<string, unknown>,
    messages: unknown,
    options?: unknown,
    callbacks?: unknown,
  ): Promise<unknown> {
    const startTime = Date.now();
    let llmResult: Record<string, unknown> | null = null;
    let callError: Error | null = null;

    try {
      llmResult = (await (_originalGenerate as (
        m: unknown,
        o?: unknown,
        c?: unknown,
      ) => Promise<unknown>).call(this, messages, options, callbacks)) as Record<string, unknown>;
    } catch (err) {
      callError = err instanceof Error ? err : new Error(String(err));
    }

    // Emit LLM_CALL — use first registered emitter
    const em = _emitters[0];
    if (em) {
      const durationMs = Date.now() - startTime;
      const model = String(this['model'] ?? this['modelName'] ?? 'unknown');
      const provider = _inferProvider(model);

      // Extract token counts from llmOutput.tokenUsage (set by ChatOpenAI._generate)
      let inputTokens = 0;
      let outputTokens = 0;
      const llmOutput = llmResult?.['llmOutput'] as Record<string, unknown> | undefined;
      if (llmOutput) {
        const tu = (llmOutput['tokenUsage'] ?? llmOutput['token_usage']) as
          | Record<string, number>
          | undefined;
        if (tu) {
          inputTokens =
            tu['promptTokens'] ?? tu['prompt_tokens'] ?? tu['inputTokens'] ?? 0;
          outputTokens =
            tu['completionTokens'] ?? tu['completion_tokens'] ?? tu['outputTokens'] ?? 0;
        }
        // Estimated path (reasoning models)
        const et = (llmOutput['estimatedTokenUsage']) as Record<string, number> | undefined;
        if (!inputTokens && !outputTokens && et) {
          inputTokens = et['promptTokens'] ?? et['prompt_tokens'] ?? 0;
          outputTokens = et['completionTokens'] ?? et['completion_tokens'] ?? 0;
        }
      }

      const fwCtx = getFrameworkContext();
      const sessionId = sessionStorage.getStore() ?? undefined;
      const costUsd = estimateCost(model, inputTokens, outputTokens);

      const event: Record<string, unknown> = {
        event_id: generateId('evt_'),
        event_type: 'LLM_CALL',
        timestamp: nowIso(),
        session_id: sessionId,
        agent_id: em.agentId,
        model,
        provider,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        duration_ms: durationMs,
        cost_usd: costUsd,
        error: callError?.message ?? null,
        framework: fwCtx?.framework ?? 'langchain',
        ...(fwCtx?.graphId ? { graph_id: fwCtx.graphId } : {}),
        ...(fwCtx?.nodeName ? { node_name: fwCtx.nodeName } : {}),
      };

      // Capture conversation content when enabled
      if (em.captureContent) {
        // Prompt messages — extract from the messages[][] input
        const promptMessages = _extractPromptMessages(messages);
        if (promptMessages.length > 0) event['prompt_messages'] = promptMessages;

        // Completion text — from the first generation's message content
        if (llmResult) {
          const generations = llmResult['generations'] as unknown[][][] | undefined;
          const gen = generations?.[0]?.[0] as Record<string, unknown> | undefined;
          const msg = gen?.['message'] as Record<string, unknown> | undefined;
          const content = msg?.['content'];
          if (content != null) {
            event['completion_text'] = typeof content === 'string'
              ? content
              : _flattenContent(content);
          }
        }
      }

      em.emitEvent(event);
    }

    if (callError) throw callError;
    return llmResult;
  };

  _patched = true;
}

export function unpatchBaseChatModel(): void {
  if (!_patched || !_proto || !_originalGenerate) return;
  _proto['generate'] = _originalGenerate;
  _proto = null;
  _originalGenerate = null;
  _emitters.length = 0;
  _patched = false;
}

export function isLLMPatched(): boolean {
  return _patched;
}

/**
 * Extract prompt messages from the messages[][] input to BaseChatModel.generate.
 * LangChain BaseMessage objects have getType() / _getType() and content.
 */
function _extractPromptMessages(
  messages: unknown,
): Array<{ role: string; content: string }> {
  if (!Array.isArray(messages)) return [];
  // messages is BaseMessage[][] — take the first batch entry (typical non-batched case)
  const conversation = messages[0];
  if (!Array.isArray(conversation)) return [];

  const result: Array<{ role: string; content: string }> = [];
  for (const msg of conversation) {
    if (msg == null || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;

    // Resolve role: try getType(), _getType(), or 'type' field
    let role = 'user';
    if (typeof m['getType'] === 'function') {
      role = _lcTypeToRole(String((m['getType'] as () => string)()));
    } else if (typeof m['_getType'] === 'function') {
      role = _lcTypeToRole(String((m['_getType'] as () => string)()));
    } else if (typeof m['type'] === 'string') {
      role = _lcTypeToRole(m['type']);
    }

    // Resolve content
    const raw = m['content'];
    const content = typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? _flattenContent(raw)
        : String(raw ?? '');

    result.push({ role, content });
  }
  return result;
}

function _lcTypeToRole(type: string): string {
  switch (type) {
    case 'human': return 'user';
    case 'ai':    return 'assistant';
    case 'system': return 'system';
    case 'tool':   return 'tool';
    default:       return type;
  }
}

/** Flatten a LangChain content block array to a plain string. */
function _flattenContent(blocks: unknown): string {
  if (!Array.isArray(blocks)) return String(blocks ?? '');
  return blocks
    .map((b) => {
      if (typeof b === 'string') return b;
      if (b != null && typeof b === 'object') {
        const block = b as Record<string, unknown>;
        return typeof block['text'] === 'string' ? block['text'] : '';
      }
      return '';
    })
    .join('');
}

function _inferProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
    return 'openai';
  }
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('gemini')) return 'google';
  if (m.includes('llama') || m.includes('mistral') || m.includes('mixtral')) return 'meta';
  return 'openai'; // sensible default for LangChain agents
}
