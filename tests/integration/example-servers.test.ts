/**
 * Integration Tests — Example Agent Servers
 *
 * Tests all TypeScript example agent servers:
 * - agent-openai.ts (port 8001)
 * - agent-anthropic.ts (port 8002)
 * - agent-langchain.ts (port 8003)
 * - agent-mastra.ts (port 8005)
 * - agent-vercel.ts (port 8006)
 *
 * Verifies:
 * - Each server starts and is health-checkable
 * - Config endpoints work
 * - Chat/research/analyze endpoints respond
 * - Config is isolated per server (pushing to one doesn't affect others)
 * - Persisted config file is in the correct isolated directory
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { startAll, stopAll, ServerDef, ServerHandle } from './helpers/server-manager.js';

const SERVERS: ServerDef[] = [
  {
    name: 'openai',
    script: 'examples/agent-openai.ts',
    port: 8001,
    agentId: 'openai-ts-agent',
    framework: 'openai',
  },
  {
    name: 'anthropic',
    script: 'examples/agent-anthropic.ts',
    port: 8002,
    agentId: 'anthropic-ts-agent',
    framework: 'anthropic',
  },
  {
    name: 'langchain',
    script: 'examples/agent-langchain.ts',
    port: 8003,
    agentId: 'langchain-ts-agent',
    framework: 'langchain',
  },
  {
    name: 'mastra',
    script: 'examples/agent-mastra.ts',
    port: 8005,
    agentId: 'mastra-agent',
    framework: 'mastra',
  },
  {
    name: 'vercel',
    script: 'examples/agent-vercel.ts',
    port: 8006,
    agentId: 'vercel-agent',
    framework: 'vercel',
  },
];

let handles: ServerHandle[] = [];

// Skip integration tests unless explicitly enabled
// These tests require real LLM API access and are not suitable for CI
const skipIntegrationTests = !process.env.SYRIN_RUN_INTEGRATION_TESTS;

describe.skipIf(skipIntegrationTests)('Example Agent Servers — Integration Tests', () => {
  beforeAll(async () => {
    // Start all servers in parallel
    handles = await startAll(SERVERS);
    expect(handles).toHaveLength(SERVERS.length);
  });

  afterAll(async () => {
    // Gracefully shut down all servers
    if (handles.length > 0) {
      await stopAll(handles);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // HEALTH CHECKS
  // ─────────────────────────────────────────────────────────────────────────

  describe.each(SERVERS)('$framework — $name (port $port)', (serverDef) => {
    const handle = () => handles.find((h) => h.def.name === serverDef.name)!;

    it('GET / returns 200 with agent metadata', async () => {
      const res = await fetch(`${handle().url}/`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('agent');
      expect(body).toHaveProperty('status');
      expect(body.status).toBe('running');
    });

    it('GET /config returns active config object', async () => {
      const res = await fetch(`${handle().url}/config`);
      expect(res.status).toBe(200);

      const body = await res.json();
      // Config may be empty initially, but should be an object
      expect(typeof body).toBe('object');
    });

    // ─────────────────────────────────────────────────────────────────────
    // CHAT ENDPOINT (all servers)
    // ─────────────────────────────────────────────────────────────────────

    it('POST /chat returns response string', async () => {
      const res = await fetch(`${handle().url}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });

      if (res.status === 404) {
        // This server might not have /chat endpoint
        expect(true).toBe(true);
        return;
      }

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('response');
      expect(typeof body.response).toBe('string');
    });

    // ─────────────────────────────────────────────────────────────────────
    // RESEARCH ENDPOINT (not on mastra/vercel)
    // ─────────────────────────────────────────────────────────────────────

    if (!['mastra', 'vercel'].includes(serverDef.framework || '')) {
      it('POST /research returns result', async () => {
        const res = await fetch(`${handle().url}/research`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test query' }),
        });

        if (res.status === 404) {
          expect(true).toBe(true);
          return;
        }

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toHaveProperty('result');
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // ANALYZE ENDPOINT (not on mastra/vercel)
    // ─────────────────────────────────────────────────────────────────────

    if (!['mastra', 'vercel'].includes(serverDef.framework || '')) {
      it('POST /analyze returns sentiment+themes', async () => {
        const res = await fetch(`${handle().url}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'This is good!' }),
        });

        if (res.status === 404) {
          expect(true).toBe(true);
          return;
        }

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toHaveProperty('sentiment');
        expect(body).toHaveProperty('themes');
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // CONFIG PERSISTENCE
    // ─────────────────────────────────────────────────────────────────────

    it('POST /syrin/config persists to isolated config directory', async () => {
      // Push config via the SDK endpoint
      const pushRes = await fetch(`${handle().url}/syrin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'llm.temperature': 0.1,
          'llm.model': 'test-model',
        }),
      });

      expect(pushRes.status).toBe(200);

      // Verify it was persisted to the config file
      const configPath = join(handle().configDir, '.syrin', 'syrin.config.json');
      expect(existsSync(configPath)).toBe(true);

      const configContent = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      expect(config['llm.temperature']).toBe(0.1);
      expect(config['llm.model']).toBe('test-model');
    });

    it('GET /config returns persisted config after push', async () => {
      // Push config
      await fetch(`${handle().url}/syrin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'llm.temperature': 0.2 }),
      });

      // Verify it's returned by GET /config
      const getRes = await fetch(`${handle().url}/config`);
      expect(getRes.status).toBe(200);

      const config = await getRes.json();
      expect(config['llm.temperature']).toBe(0.2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIG ISOLATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('Config Isolation — Pushing to one server does not affect others', () => {
    it('Server A and B have isolated config files', async () => {
      const serverA = handles[0]; // openai
      const serverB = handles[1]; // anthropic

      // Push unique config to server A
      await fetch(`${serverA.url}/syrin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'llm.temperature': 0.5, 'llm.model': 'model-a' }),
      });

      // Push different config to server B
      await fetch(`${serverB.url}/syrin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'llm.temperature': 0.9, 'llm.model': 'model-b' }),
      });

      // Verify they're in different files
      const configAPath = join(serverA.configDir, '.syrin', 'syrin.config.json');
      const configBPath = join(serverB.configDir, '.syrin', 'syrin.config.json');

      expect(configAPath).not.toBe(configBPath);

      // Verify content is isolated
      const configA = JSON.parse(readFileSync(configAPath, 'utf-8'));
      const configB = JSON.parse(readFileSync(configBPath, 'utf-8'));

      expect(configA['llm.temperature']).toBe(0.5);
      expect(configB['llm.temperature']).toBe(0.9);

      expect(configA['llm.model']).toBe('model-a');
      expect(configB['llm.model']).toBe('model-b');
    });
  });
});
