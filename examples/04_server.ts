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
 * Works with any LLM library. cfg() declares remotely configurable fields
 * so the dashboard can tune the agent without a redeploy.
 *
 * Run:
 *   npm install express openai
 *   SYRIN_API_KEY=syrin_... OPENAI_API_KEY=sk-... npx ts-node examples/04_server.ts
 */

import express, { Request, Response } from 'express';
import { init, shutdown, GovernanceStopError, onAlert, withSession, withAgent } from '@syrin/sdk';

const PORT = parseInt(process.env['PORT'] ?? '8080', 10);
const app = express();
app.use(express.json());

async function start(): Promise<void> {
  // ── Init ──────────────────────────────────────────────────────────────────
  const sdk = await init({
    apiKey: process.env['SYRIN_API_KEY'] ?? '',
    name: 'my-agent',
    url: process.env['SYRIN_URL'] ?? 'https://api.syrin.ai',
    serverUrl: process.env['SERVER_URL'] ?? `http://localhost:${PORT}/`,
    captureContent: true,
  });

  onAlert((alert) => console.warn('[ALERT]', JSON.stringify(alert)));

  // ── Declare all remotely configurable fields ──────────────────────────────
  // These appear in the Syrin dashboard. Dashboard users can change them live.
  sdk.cfg('llm.model',             'gpt-4o-mini', { label: 'LLM Model' });
  sdk.cfg('llm.temperature',        0.7,           { label: 'Temperature',  ge: 0.0, le: 2.0 });
  sdk.cfg('llm.max_tokens',         1024,          { label: 'Max Tokens',   ge: 1 });
  sdk.cfg('prompt.system_prompt',  'You are a helpful assistant.', {
    label: 'System Prompt',
    multiline: true,
  });

  console.log(`[my-agent] SDK ready | model=${String(sdk.cfg('llm.model', 'gpt-4o-mini'))}`);

  // ── LLM client (OpenAI example — swap for your library) ──────────────────
  let callLLM: (messages: Array<{ role: string; content: string }>) => Promise<string>;
  try {
    const { default: OpenAI } = await import('openai') as { default: new (opts: { apiKey: string }) => { chat: { completions: { create(opts: unknown): Promise<{ choices: Array<{ message: { content: string } }> }> } } } };
    const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] ?? '' });

    callLLM = async (messages) => {
      // Read cfg() values at call time — picks up live dashboard changes
      const model  = sdk.cfg('llm.model',         'gpt-4o-mini') as string;
      const temp   = sdk.cfg('llm.temperature',    0.7, { ge: 0, le: 2 }) as number;
      const maxTok = sdk.cfg('llm.max_tokens',     1024, { ge: 1 }) as number;
      const sysPr  = sdk.cfg('prompt.system_prompt', 'You are a helpful assistant.') as string;

      const r = await client.chat.completions.create({
        model, temperature: temp, max_tokens: maxTok,
        messages: [{ role: 'system', content: sysPr }, ...messages],
      });
      return r.choices[0].message.content;
    };
  } catch {
    callLLM = async (_messages) => '[OpenAI not installed — add your LLM call here]';
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, agent: 'my-agent', version: '1.0.0' });
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

    const today     = new Date().toISOString().split('T')[0];
    const sessionId = `${String(user_id)}_${today}`;

    try {
      let reply = '';
      await withSession(sessionId, async () => {
        await withAgent('chat-agent', async () => {
          reply = await callLLM(messages);
        });
      });
      res.json({ reply, session_id: sessionId });
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
