/**
 * 04 — Production Server (Express)
 * ----------------------------------
 * A production-ready Express server using the Syrin SDK.
 *
 * Key endpoints:
 *   POST /chat           — LLM call with session tracking
 *   GET  /health         — liveness probe
 *   GET  /config         — current config snapshot
 *   POST /syrin/callback — governance push from Syrin backend
 *
 * Works with any LLM library. AgentHandle.field() declares remotely configurable
 * fields so the dashboard can tune the agent without a redeploy.
 *
 * Run:
 *   npm install express openai
 *   SYRIN_API_KEY=syrin_... OPENAI_API_KEY=sk-... npx ts-node examples/04_server.ts
 */

import express, { Request, Response } from 'express';
import { init, shutdown, GovernanceStopError, onAlert, withSkip } from '@syrin/sdk';

const PORT = parseInt(process.env['PORT'] ?? '8080', 10);
const app = express();
app.use(express.json());

async function start(): Promise<void> {
  // ── Init ──────────────────────────────────────────────────────────────────
  const apiKey = process.env['SYRIN_API_KEY'];
  if (!apiKey) {
    console.error(
      'Error: SYRIN_API_KEY is not set.\n' +
      '  export SYRIN_API_KEY=syrin_test\n' +
      '  Then re-run this script.'
    );
    process.exit(1);
  }

  const sdk = await init({
    apiKey,
    agentId: 'my-agent',
    backendUrl: process.env['SYRIN_BACKEND_URL'] ?? 'https://api.syrin.dev',
    serverUrl: process.env['SERVER_URL'] ?? `http://localhost:${PORT}/`,
    sessionTtlMs: 3_600_000,      // auto-clean sessions older than 1 h
    governance: { allowStop: true, allowInjectMessage: true },
  });

  onAlert((alert) => console.warn('[ALERT]', JSON.stringify(alert)));

  // ── Register agents and declare remotely configurable fields ─────────────
  // sdk.agent() returns an AgentHandle. Chain .field() to declare fields
  // that appear in the Syrin dashboard — operators can tune them live.

  const chatAgent = sdk.agent('chat-agent', {
    description: 'Handles multi-turn user conversations',
    captureContent: false,   // keep user prompts private by default
    captureToolCalls: true,  // emit TOOL_CALL events for tool-use visibility
  });
  chatAgent
    .field('llm.model',            'gpt-4o-mini', { label: 'LLM Model' })
    .field('llm.temperature',       0.7,           { label: 'Temperature', ge: 0.0, le: 2.0 })
    .field('llm.max_tokens',        1024,          { label: 'Max Tokens',  ge: 1 })
    .field('prompt.system_prompt', 'You are a helpful assistant.', {
      label: 'System Prompt',
      multiline: true,
    });

  console.log(
    `[my-agent] SDK ready | model=${String(chatAgent.cfg('llm.model', 'gpt-4o-mini'))}`
  );

  // ── LLM client (OpenAI example — swap for your library) ──────────────────
  let callLLM: (messages: Array<{ role: string; content: string }>) => Promise<string>;
  try {
    const { default: OpenAI } = await import('openai') as {
      default: new (opts: { apiKey: string }) => {
        chat: { completions: { create(opts: unknown): Promise<{ choices: Array<{ message: { content: string } }> }> } };
      };
    };
    const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] ?? '' });

    callLLM = async (messages) => {
      // Read cfg() at call time — picks up live dashboard changes
      const model  = chatAgent.cfg('llm.model',            'gpt-4o-mini') as string;
      const temp   = chatAgent.cfg('llm.temperature',       0.7, { ge: 0, le: 2 }) as number;
      const maxTok = chatAgent.cfg('llm.max_tokens',        1024, { ge: 1 }) as number;
      const sysPr  = chatAgent.cfg('prompt.system_prompt', 'You are a helpful assistant.') as string;

      const r = await client.chat.completions.create({
        model, temperature: temp, max_tokens: maxTok,
        messages: [{ role: 'system', content: sysPr }, ...messages],
      });
      return r.choices[0].message.content;
    };
  } catch {
    callLLM = async () => '[OpenAI not installed — add your LLM call here]';
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  app.get('/health', async (_req: Request, res: Response) => {
    // healthCheck() pings the Syrin backend — lets load balancers detect
    // backend connectivity loss before it affects the /chat endpoint.
    const backendOk = await sdk.healthCheck();
    res.status(backendOk ? 200 : 503).json({ ok: backendOk, agent: 'my-agent', version: '1.0.0' });
  });

  app.get('/config', (_req: Request, res: Response) => {
    res.json(sdk.configReference());
  });

  app.post('/syrin/callback', (req: Request, res: Response) => {
    console.log('[my-agent] Syrin callback:', JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  });

  app.post('/chat', async (req: Request, res: Response) => {
    const { messages = [], user_id = 'anonymous' } = req.body as {
      messages: Array<{ role: string; content: string }>;
      user_id?: string;
    };

    try {
      let reply = '';
      // chatAgent.session() replaces the nested withSession + withAgent pattern:
      // one call sets up the session, enters the agent scope, and returns ctx.
      const ctx = await chatAgent.session(
        { userId: String(user_id), window: 'day' },
        async (ctx) => {
          reply = await callLLM(messages);
          return ctx;
        }
      );
      res.json({ reply, session_id: ctx.sessionId });
      // Use withSkip() when you need to make an LLM call that must NOT be
      // observed by Syrin — e.g. internal validation, PII scrubbing, or
      // calls that fall outside your observability policy.
      // await withSkip(async () => { await callLLM([{ role: 'user', content: 'internal check' }]); });
    } catch (err) {
      if (err instanceof GovernanceStopError) {
        console.warn('[my-agent] Governance stop:', (err as Error).message);
        res.status(503).json({ error: 'stopped', reason: (err as Error).message });
      } else {
        console.error('[my-agent] Error on /chat:', err);
        res.status(500).json({ error: String(err) });
      }
    }
  });

  // ── Start ─────────────────────────────────────────────────────────────────
  app.listen(PORT, () => console.log(`[my-agent] Listening on port ${PORT}`));

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });
}

start().catch(console.error);
