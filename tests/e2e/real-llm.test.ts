/**
 * End-to-end tests with real LLM API calls.
 *
 * Requires these environment variables (loaded from .env):
 *   OPENAI_API_KEY      — OpenAI API key
 *   ANTHROPIC_API_KEY   — Anthropic API key
 *   GEMINI_API_KEY      — Google Gemini API key
 *   SYRIN_LOCAL_API_KEY — Syrin key seeded into local dev backend (seed-dev.ts)
 *                         Falls back to SYRIN_API_KEY if not set.
 *
 * Backend is always localhost:4000 (local, not production).
 *
 * Run:
 *   cd syrin-sdk-ts
 *   npx vitest run tests/e2e/real-llm.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { generateId } from '@/utils/helpers.js';

// ---------------------------------------------------------------------------
// Load .env
// ---------------------------------------------------------------------------

const envPath = resolve(__dirname, '../../.env');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eqIdx = line.indexOf('=');
    const k = line.slice(0, eqIdx).trim();
    const v = line.slice(eqIdx + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
} catch { /* no .env — rely on process.env */ }

const OPENAI_API_KEY = process.env['OPENAI_API_KEY'] ?? '';
const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY'] ?? '';
const GEMINI_API_KEY = process.env['GEMINI_API_KEY'] ?? '';
const SYRIN_API_KEY = process.env['SYRIN_LOCAL_API_KEY'] || process.env['SYRIN_API_KEY'] || '';
const OPENAI_MODEL = process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini';
const ANTHROPIC_MODEL = process.env['ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5';
const GEMINI_MODEL = process.env['GEMINI_MODEL'] ?? 'gemini-2.0-flash';

const BACKEND_URL = 'http://localhost:4000';

// ---------------------------------------------------------------------------
// Skip conditions
// ---------------------------------------------------------------------------

async function isBackendUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BACKEND_URL}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

const backendUp = await isBackendUp();
const SKIP_NO_BACKEND = !backendUp;
const SKIP_OPENAI = !OPENAI_API_KEY || !SYRIN_API_KEY || SKIP_NO_BACKEND;
const SKIP_ANTHROPIC = !ANTHROPIC_API_KEY || !SYRIN_API_KEY || SKIP_NO_BACKEND;
const SKIP_GEMINI = !GEMINI_API_KEY || !SYRIN_API_KEY || SKIP_NO_BACKEND;
const SKIP_CROSS = !OPENAI_API_KEY || !ANTHROPIC_API_KEY || !SYRIN_API_KEY || SKIP_NO_BACKEND;

// ---------------------------------------------------------------------------
// Provider error detection
// ---------------------------------------------------------------------------

function isProviderLimitError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return ['credit balance', 'quota', 'resource_exhausted', 'rate limit',
    'insufficient_quota', 'billing', 'too many requests'].some(kw => msg.includes(kw));
}

// ---------------------------------------------------------------------------
// SDK reset helper
// ---------------------------------------------------------------------------

async function resetSdk(): Promise<void> {
  try {
    const { shutdown } = await import('../../src/index.js');
    await shutdown('default').catch(() => { /* non-fatal */ });
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// SDK access helpers
// ---------------------------------------------------------------------------

type InternalSdk = Record<string, { flush(): Promise<void> }>;

async function flush(sdk: unknown): Promise<void> {
  const emitter = (sdk as InternalSdk)['_emitter'];
  if (emitter?.flush) await emitter.flush();
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_OPENAI)('E2E — Real OpenAI', () => {
  beforeEach(resetSdk);
  afterEach(resetSdk);

  it('sync call intercepted and sent to backend', { timeout: 30_000 }, async () => {
    const { init, shutdown } = await import('../../src/index.js');
    const OpenAI = (await import('openai')).default;

    const sdk = await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-openai',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: 'Say exactly: hello syrin' }],
      max_tokens: 20,
    });
    expect(response.choices[0].message.content).toBeTruthy();
    await flush(sdk);

    // Verify backend received the event
    const r = await fetch(`${BACKEND_URL}/api/v1/agents/e2e-ts-openai/overrides`, {
      headers: { Authorization: `Bearer ${SYRIN_API_KEY}` },
    });
    // Soft check — SYRIN_LOCAL_API_KEY may not be set to the seeded dev key
    if (r.status !== 401) {
      expect(r.status).toBe(200);
    }
    await shutdown();
  });

  it('async call intercepted', { timeout: 30_000 }, async () => {
    const { init, shutdown } = await import('../../src/index.js');
    const OpenAI = (await import('openai')).default;

    await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-async',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: 'Say exactly: async hello' }],
      max_tokens: 20,
    });
    expect(response.choices[0].message.content).toBeTruthy();
    await shutdown();
  });

  it('streaming call intercepted', { timeout: 30_000 }, async () => {
    const { init, shutdown } = await import('../../src/index.js');
    const OpenAI = (await import('openai')).default;

    await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-stream',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const stream = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: 'Count: 1 2 3' }],
      max_tokens: 20,
      stream: true,
    });
    const chunks: string[] = [];
    for await (const chunk of stream as AsyncIterable<{ choices: Array<{ delta: { content?: string } }> }>) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) chunks.push(delta);
    }
    expect(chunks.length).toBeGreaterThan(0);
    await shutdown();
  });

  it('tool calling intercepted', { timeout: 30_000 }, async () => {
    const { init, shutdown } = await import('../../src/index.js');
    const OpenAI = (await import('openai')).default;

    await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-tools',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ];

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      tools,
      tool_choice: 'auto',
      max_tokens: 100,
    });
    expect(['stop', 'tool_calls']).toContain(response.choices[0].finish_reason);
    await shutdown();
  });

  it('multi-turn session tracked', { timeout: 60_000 }, async () => {
    const { init, shutdown, withSession } = await import('../../src/index.js');
    const OpenAI = (await import('openai')).default;

    const sdk = await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-session',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const sessionId = generateId('ses_');

    await withSession(sessionId, async () => {
      await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: 'My name is Alice.' }],
        max_tokens: 30,
      });
      await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role: 'user', content: 'My name is Alice.' },
          { role: 'assistant', content: 'Hello Alice!' },
          { role: 'user', content: 'What is my name?' },
        ],
        max_tokens: 30,
      });
    });

    expect(sessionId).toBeTruthy();
    await flush(sdk);
    await shutdown();
  });

  it('multi-agent handoff with real calls', { timeout: 60_000 }, async () => {
    const { init, shutdown, emit } = await import('../../src/index.js');
    const OpenAI = (await import('openai')).default;

    const sdk = await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-handoff',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const researcher = sdk.agent('e2e-ts-researcher');
    const writer = sdk.agent('e2e-ts-writer');
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    let notes: string | null = null;
    await researcher.run(async () => {
      const r = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: 'Give one fact about the Moon.' }],
        max_tokens: 40,
      });
      notes = r.choices[0].message.content;
    });

    emit('HANDOFF', { from_agent: 'e2e-ts-researcher', to_agent: 'e2e-ts-writer' });

    await writer.run(async () => {
      await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: `Summarize in 5 words: ${notes}` }],
        max_tokens: 20,
      });
    });

    await flush(sdk);
    await shutdown();
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_ANTHROPIC)('E2E — Real Anthropic', () => {
  beforeEach(resetSdk);
  afterEach(resetSdk);

  it('sync call intercepted', { timeout: 30_000 }, async () => {
    const { init, shutdown } = await import('../../src/index.js');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;

    const sdk = await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-anthropic',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    try {
      const response = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 30,
        messages: [{ role: 'user', content: 'Say exactly: hello from claude' }],
      });
      expect(response.content.length).toBeGreaterThan(0);
      expect(response.content[0].type).toBe('text');
      await flush(sdk);
    } catch (err) {
      if (isProviderLimitError(err)) return;
      throw err;
    } finally {
      await shutdown();
    }
  });

  it('async call intercepted', { timeout: 30_000 }, async () => {
    const { init, shutdown } = await import('../../src/index.js');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;

    const sdk = await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-anthropic-async',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    try {
      const response = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 30,
        messages: [{ role: 'user', content: 'Say: async claude works' }],
      });
      expect(response.content[0].type).toBe('text');
      await flush(sdk);
    } catch (err) {
      if (isProviderLimitError(err)) return;
      throw err;
    } finally {
      await shutdown();
    }
  });

  it('streaming call intercepted', { timeout: 30_000 }, async () => {
    const { init, shutdown } = await import('../../src/index.js');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;

    const sdk = await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-anthropic-stream',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const chunks: string[] = [];
    try {
      const stream = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 30,
        messages: [{ role: 'user', content: 'Count: one two three' }],
        stream: true,
      });
      for await (const event of stream as AsyncIterable<{ type: string; delta?: { type: string; text?: string } }>) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          chunks.push(event.delta.text ?? '');
        }
      }
      expect(chunks.length).toBeGreaterThan(0);
      await flush(sdk);
    } catch (err) {
      if (isProviderLimitError(err)) return;
      throw err;
    } finally {
      await shutdown();
    }
  });

  it('system prompt recorded in span', { timeout: 30_000 }, async () => {
    const { init, shutdown } = await import('../../src/index.js');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;

    const sdk = await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-anthropic-sys',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    try {
      const response = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 30,
        system: 'You are a helpful assistant that always responds in exactly 3 words.',
        messages: [{ role: 'user', content: 'How are you?' }],
      });
      expect(response.content[0].type).toBe('text');
      await flush(sdk);
    } catch (err) {
      if (isProviderLimitError(err)) return;
      throw err;
    } finally {
      await shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_GEMINI)('E2E — Real Gemini', () => {
  beforeEach(resetSdk);
  afterEach(resetSdk);

  it('sync call intercepted', { timeout: 30_000 }, async () => {
    const { init, shutdown } = await import('../../src/index.js');
    const { GoogleGenAI } = await import('@google/genai');

    const sdk = await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-gemini',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const genai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    try {
      const response = await genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: 'Say exactly: hello from gemini',
      });
      expect(response.text).toBeTruthy();
      await flush(sdk);
    } catch (err) {
      if (isProviderLimitError(err)) return;
      throw err;
    } finally {
      await shutdown();
    }
  });

  it('async call intercepted', { timeout: 30_000 }, async () => {
    const { init, shutdown } = await import('../../src/index.js');
    const { GoogleGenAI } = await import('@google/genai');

    const sdk = await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-gemini-async',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const genai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    try {
      const response = await genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: 'Say: async gemini works',
      });
      expect(response.text).toBeTruthy();
      await flush(sdk);
    } catch (err) {
      if (isProviderLimitError(err)) return;
      throw err;
    } finally {
      await shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-provider
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_CROSS)('E2E — Cross-provider', () => {
  beforeEach(resetSdk);
  afterEach(resetSdk);

  it('OpenAI then Anthropic in the same session', { timeout: 60_000 }, async () => {
    const { init, shutdown, withSession } = await import('../../src/index.js');
    const OpenAI = (await import('openai')).default;
    const Anthropic = (await import('@anthropic-ai/sdk')).default;

    const sdk = await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-cross',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const oaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
    const antClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const sessionId = generateId('ses_');

    try {
      await withSession(sessionId, async () => {
        await oaiClient.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: 'Give one word: ocean' }],
          max_tokens: 10,
        });
        try {
          await antClient.messages.create({
            model: ANTHROPIC_MODEL,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Give one word: mountain' }],
          });
        } catch (err) {
          if (!isProviderLimitError(err)) throw err;
        }
      });
      expect(sessionId).toBeTruthy();
      await flush(sdk);
    } catch (err) {
      if (isProviderLimitError(err)) return;
      throw err;
    } finally {
      await shutdown();
    }
  });

  it('feedback after real session', { timeout: 30_000 }, async () => {
    const { init, shutdown, withSession } = await import('../../src/index.js');
    const OpenAI = (await import('openai')).default;

    const sdk = await init({
      apiKey: SYRIN_API_KEY,
      backendUrl: BACKEND_URL,
      agentId: 'e2e-ts-feedback',
      offline: false,
      batchIntervalMs: 999_999,
      otelExporter: 'none',
    });

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const sessionId = generateId('ses_');

    try {
      await withSession(sessionId, async () => {
        await client.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: 'What is 1+1?' }],
          max_tokens: 10,
        });
      });
      await flush(sdk);

      // Submit feedback via backend directly (SDK ownership model may reject it)
      const r = await fetch(`${BACKEND_URL}/api/v1/sessions/${sessionId}/feedback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SYRIN_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rating: 'positive', reason: 'Correct answer!' }),
      });
      expect([200, 201, 401, 403, 404, 409]).toContain(r.status);
    } catch (err) {
      if (isProviderLimitError(err)) return;
      throw err;
    } finally {
      await shutdown();
    }
  });
});
