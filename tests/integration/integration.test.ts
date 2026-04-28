/**
 * Integration tests: Full lifecycle with msw
 */

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { IngestPayload, SyrinEvent } from '@/types';

// Mock openai — create on prototype (matches real SDK v4 structure)
vi.mock('openai', () => {
  const mockCreate = vi.fn();

  class MockCompletions {}
  (MockCompletions.prototype as Record<string, unknown>)['create'] = mockCreate;

  class MockChat {
    completions: MockCompletions;
    constructor() {
      this.completions = new MockCompletions();
    }
  }

  class MockOpenAI {
    chat: MockChat;
    constructor(_options?: unknown) {
      this.chat = new MockChat();
    }
    static Completions = MockCompletions;
  }

  return {
    default: MockOpenAI,
    Completions: MockCompletions,
    __mockCreate: mockCreate,
  };
});

async function getMockCreate(): Promise<ReturnType<typeof vi.fn>> {
  const mod = await import('openai');
  return (mod as unknown as { __mockCreate: ReturnType<typeof vi.fn> }).__mockCreate;
}

function makeOpenAIResponse(model = 'gpt-4o', content = 'Integration test response') {
  return {
    id: 'chatcmpl-integration',
    object: 'chat.completion',
    created: Date.now(),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
  };
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

const BACKEND_URL = 'http://localhost:4399';

describe('Integration: init → call → event at mock backend', () => {
  it('emits an event after an OpenAI call via SDK', async () => {
    const { createConfig } = await import('../../src/config/config.js');
    const { SessionStore } = await import('../../src/core/session.js');
    const { Emitter } = await import('../../src/observability/emitter.js');
    const { OTelBridge } = await import('../../src/observability/otel.js');
    const { CheckpointClient } = await import('../../src/core/checkpoint.js');
    const { SyrinCore } = await import('../../src/core/engine.js');
    const { patchWithModule, unpatch } = await import('../../src/interceptors/openai.js');

    unpatch();

    const receivedPayloads: IngestPayload[] = [];

    server.use(
      http.post(`${BACKEND_URL}/api/v1/ingest`, async ({ request }) => {
        receivedPayloads.push((await request.json()) as IngestPayload);
        return HttpResponse.json({ ok: true });
      })
    );

    const config = createConfig({
      apiKey: 'syrin_integration_test',
      backendUrl: BACKEND_URL,
      offline: false,
      batchIntervalMs: 60000,
      batchSize: 50,
    });

    const sessionStore = new SessionStore();
    const emitter = new Emitter(config, sessionStore);
    const otelBridge = new OTelBridge(config);
    otelBridge.setup();
    const checkpointClient = new CheckpointClient(config);
    const core = new SyrinCore(config, sessionStore, emitter, otelBridge, checkpointClient);

    const openaiModule = await import('openai');
    patchWithModule(openaiModule, core);

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse());

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Integration test' }],
    });

    await emitter.flush();

    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0].events).toHaveLength(1);
    expect(receivedPayloads[0].events[0].event_type).toBe('LLM_CALL');
    expect(receivedPayloads[0].events[0].model).toBe('gpt-4o');

    await emitter.stop();
    unpatch();
  });

  it('applies config update from backend to next call', async () => {
    const { createConfig } = await import('../../src/config/config.js');
    const { SessionStore } = await import('../../src/core/session.js');
    const { Emitter } = await import('../../src/observability/emitter.js');
    const { OTelBridge } = await import('../../src/observability/otel.js');
    const { CheckpointClient } = await import('../../src/core/checkpoint.js');
    const { SyrinCore } = await import('../../src/core/engine.js');
    const { patchWithModule, unpatch } = await import('../../src/interceptors/openai.js');
    const { sessionStorage } = await import('../../src/core/session.js');

    unpatch();

    let callCount = 0;

    server.use(
      http.post(`${BACKEND_URL}/api/v1/ingest`, () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json({ ok: true, config_updates: { temperature: 0.1 } });
        }
        return HttpResponse.json({ ok: true });
      })
    );

    const config = createConfig({
      apiKey: 'syrin_config_test',
      backendUrl: BACKEND_URL,
      offline: false,
      batchIntervalMs: 60000,
      batchSize: 50,
    });

    const sessionStore = new SessionStore();
    const emitter = new Emitter(config, sessionStore);
    const otelBridge = new OTelBridge(config);
    otelBridge.setup();
    const checkpointClient = new CheckpointClient(config);
    const core = new SyrinCore(config, sessionStore, emitter, otelBridge, checkpointClient);

    const openaiModule = await import('openai');
    patchWithModule(openaiModule, core);

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeOpenAIResponse());

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'config-lifecycle-session';
    await sessionStore.getOrCreate(sessionId, undefined);

    // First call
    await sessionStorage.run(sessionId, async () => {
      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'First call' }],
      });
    });

    await emitter.flush(); // Gets config_updates: { temperature: 0.1 }

    const session = sessionStore.getSession(sessionId);
    expect(session?.activeConfig['temperature']).toBe(0.1);

    // Second call — temperature should be injected
    await sessionStorage.run(sessionId, async () => {
      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Second call' }],
      });
    });

    const secondCallParams = mockCreate.mock.calls[1][0] as Record<string, unknown>;
    expect(secondCallParams['temperature']).toBe(0.1);

    await emitter.stop();
    unpatch();
  });

  it('withSession() scopes events to the correct session', async () => {
    const { createConfig } = await import('../../src/config/config.js');
    const { SessionStore } = await import('../../src/core/session.js');
    const { Emitter } = await import('../../src/observability/emitter.js');
    const { OTelBridge } = await import('../../src/observability/otel.js');
    const { CheckpointClient } = await import('../../src/core/checkpoint.js');
    const { SyrinCore } = await import('../../src/core/engine.js');
    const { patchWithModule, unpatch } = await import('../../src/interceptors/openai.js');
    const { withSession } = await import('../../src/index.js');

    unpatch();

    server.use(
      http.post(`${BACKEND_URL}/api/v1/ingest`, () => HttpResponse.json({ ok: true }))
    );

    const config = createConfig({
      apiKey: 'syrin_session_test',
      backendUrl: BACKEND_URL,
      offline: false,
      batchIntervalMs: 60000,
      batchSize: 50,
    });

    const sessionStore = new SessionStore();
    const emitter = new Emitter(config, sessionStore);
    const emitSpy = vi.spyOn(emitter, 'emit');
    const otelBridge = new OTelBridge(config);
    otelBridge.setup();
    const checkpointClient = new CheckpointClient(config);
    const core = new SyrinCore(config, sessionStore, emitter, otelBridge, checkpointClient);

    const openaiModule = await import('openai');
    patchWithModule(openaiModule, core);

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeOpenAIResponse());

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionA = 'session_user_a';
    const sessionB = 'session_user_b';

    await withSession(sessionA, async () => {
      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Session A call' }],
      });
    });

    await withSession(sessionB, async () => {
      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Session B call' }],
      });
    });

    expect(emitSpy).toHaveBeenCalledTimes(2);

    const [, emittedSessionA] = emitSpy.mock.calls[0] as [SyrinEvent, string];
    const [, emittedSessionB] = emitSpy.mock.calls[1] as [SyrinEvent, string];

    expect(emittedSessionA).toBe(sessionA);
    expect(emittedSessionB).toBe(sessionB);

    await emitter.stop();
    unpatch();
  });

  it('shutdown() flushes remaining events', async () => {
    const { createConfig } = await import('../../src/config/config.js');
    const { SessionStore } = await import('../../src/core/session.js');
    const { Emitter } = await import('../../src/observability/emitter.js');
    const { OTelBridge } = await import('../../src/observability/otel.js');
    const { CheckpointClient } = await import('../../src/core/checkpoint.js');
    const { SyrinCore } = await import('../../src/core/engine.js');
    const { patchWithModule, unpatch } = await import('../../src/interceptors/openai.js');

    unpatch();

    const receivedPayloads: IngestPayload[] = [];

    server.use(
      http.post(`${BACKEND_URL}/api/v1/ingest`, async ({ request }) => {
        receivedPayloads.push((await request.json()) as IngestPayload);
        return HttpResponse.json({ ok: true });
      })
    );

    const config = createConfig({
      apiKey: 'syrin_shutdown_test',
      backendUrl: BACKEND_URL,
      offline: false,
      batchIntervalMs: 60000,
      batchSize: 50,
    });

    const sessionStore = new SessionStore();
    const emitter = new Emitter(config, sessionStore);
    const otelBridge = new OTelBridge(config);
    otelBridge.setup();
    const checkpointClient = new CheckpointClient(config);
    const core = new SyrinCore(config, sessionStore, emitter, otelBridge, checkpointClient);

    const openaiModule = await import('openai');
    patchWithModule(openaiModule, core);

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(makeOpenAIResponse());

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: 'test' });

    const sessionId = 'shutdown-session';
    const { sessionStorage } = await import('../../src/core/session.js');

    await sessionStorage.run(sessionId, async () => {
      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Shutdown test' }],
      });
    });

    await emitter.stop();

    expect(receivedPayloads.length).toBeGreaterThan(0);
    expect(receivedPayloads[0].events).toHaveLength(1);

    unpatch();
  });
});
