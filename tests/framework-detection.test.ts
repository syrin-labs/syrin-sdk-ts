/**
 * Tests: Framework detection — parity with Python SDK's _detect_framework()
 *
 * Python behaviour:
 *   - Tier 1 (framework adapters): langchain, langgraph, pydantic_ai, mastra, vercel-ai → returned first
 *   - Tier 2 (LLM providers): openai, anthropic → returned as fallback when no Tier 1 adapter
 *   - None of the above → undefined
 *
 * Covers:
 *  1. Returns 'openai' when only OpenAI adapter is registered
 *  2. Returns 'anthropic' when only Anthropic adapter is registered
 *  3. Returns 'langchain' (not 'openai') when LangChain + OpenAI are both registered
 *  4. Returns undefined when no adapters are registered
 *  5. Framework name is included in the /register POST body as agent_framework
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SyrinSDKCore } from '@/core/engine';
import { OpenAIAdapter } from '@/adapters/openai/index';
import { AnthropicAdapter } from '@/adapters/anthropic/index';
import { LangChainAdapter } from '@/adapters/langchain/index';
import { LangGraphAdapter } from '@/adapters/langgraph/index';
import type { ISyrinCore } from '@/adapters/types';
import type { SyrinSDKConfig } from '@/types';

vi.mock('openai', () => {
  class MockOpenAI { constructor(_?: unknown) {} }
  return { default: MockOpenAI };
});
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { constructor(_?: unknown) {} }
  return { default: MockAnthropic, Anthropic: MockAnthropic };
});

function makeCore(): SyrinSDKCore {
  const config: SyrinSDKConfig = {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4000',
    otelExporter: 'none',
    otelEndpoint: 'http://localhost:4318',
    debug: false,
    captureContent: false,
    offline: true,
    batchSize: 50,
    idleFlushMs: 60_000,
    toolValidation: false,
    agentId: 'test-agent',
    sessionId: 'ses_test',
  };

  const stub = {
    getOrCreate: vi.fn().mockResolvedValue({}),
    popGovernanceActions: vi.fn().mockReturnValue([]),
    popInjectedMessages: vi.fn().mockReturnValue([]),
    getEffectiveConfig: vi.fn().mockReturnValue({}),
    recordCall: vi.fn(),
    incrementCallIndex: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    setLocalConfig: vi.fn(),
    getToolValidation: vi.fn(),
    deleteSession: vi.fn(),
    clearStaleSessions: vi.fn().mockReturnValue(0),
  } as unknown as ISyrinCore['sessionStore'];

  const emitter = { emit: vi.fn(), flush: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const otelBridge = { recordSpan: vi.fn(), setup: vi.fn(), shutdown: vi.fn() };
  const checkpointClient = { save: vi.fn(), getById: vi.fn(), listForSession: vi.fn().mockReturnValue([]) };

  return new SyrinSDKCore(config, stub, emitter as never, otelBridge as never, checkpointClient as never);
}

async function registerNoOp(adapter: { install: unknown; isInstalled: unknown; uninstall: unknown }, core: SyrinSDKCore) {
  (adapter as Record<string, unknown>)['install'] = vi.fn().mockResolvedValue(undefined);
  (adapter as Record<string, unknown>)['isInstalled'] = vi.fn().mockReturnValue(true);
  (adapter as Record<string, unknown>)['uninstall'] = vi.fn();
  await core.registerAdapter(adapter as never);
}

// Access the private method for testing via type assertion
function detectFramework(core: SyrinSDKCore): string | undefined {
  return (core as unknown as { _detectFramework(): string | undefined })._detectFramework();
}

describe('_detectFramework()', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // 1. Returns 'openai' when only OpenAI adapter is registered
  it('returns "openai" when only the OpenAI adapter is registered', async () => {
    const core = makeCore();
    await registerNoOp(new OpenAIAdapter({} as never), core);
    expect(detectFramework(core)).toBe('openai');
  });

  // 2. Returns 'anthropic' when only Anthropic adapter is registered
  it('returns "anthropic" when only the Anthropic adapter is registered', async () => {
    const core = makeCore();
    await registerNoOp(new AnthropicAdapter(), core);
    expect(detectFramework(core)).toBe('anthropic');
  });

  // 3. Returns Tier-1 framework over LLM provider
  it('returns "langchain" (not "openai") when LangChain + OpenAI are both registered', async () => {
    const core = makeCore();
    await registerNoOp(new OpenAIAdapter({} as never), core);
    await registerNoOp(new LangChainAdapter(), core);
    expect(detectFramework(core)).toBe('langchain');
  });

  it('returns "langgraph" when LangGraph + OpenAI are both registered', async () => {
    const core = makeCore();
    await registerNoOp(new OpenAIAdapter({} as never), core);
    await registerNoOp(new LangGraphAdapter(), core);
    expect(detectFramework(core)).toBe('langgraph');
  });

  // 4. Returns undefined with no adapters
  it('returns undefined when no adapters are registered', () => {
    const core = makeCore();
    expect(detectFramework(core)).toBeUndefined();
  });

  // 5. agent_framework in registration POST body
  it('includes agent_framework in /register POST body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchSpy);

    const core = makeCore();
    await registerNoOp(new OpenAIAdapter({} as never), core);
    await core.register();

    vi.unstubAllGlobals();

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { agent_framework?: string };
    expect(body.agent_framework).toBe('openai');
  });
});
