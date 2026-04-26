/**
 * POST /v1/chat/completions — mock OpenAI endpoint for offline testing.
 *
 * Set OPENAI_BASE_URL=http://localhost:<PORT>/v1 to use without a real API key.
 */

import type { Request, Response } from 'express';
import { C, timestamp } from '../display.js';

interface ChatMessage {
  role: string;
  content?: string;
}

export function handleMockOpenAI(req: Request, res: Response): void {
  const body = req.body as {
    model?: string;
    messages?: ChatMessage[];
    stream?: boolean;
  };

  const model = body.model ?? 'gpt-4o-mini';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const stream = body.stream ?? false;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const replyText = `[mock] Received: ${String(lastUser?.content ?? '').substring(0, 120)}`;

  console.log(
    `\n${C.gray}[${timestamp()}]${C.reset} ${C.magenta}← MOCK OPENAI${C.reset} ` +
    `${C.bold}POST /v1/chat/completions${C.reset}  model=${C.yellow}${model}${C.reset}  msgs=${messages.length}` +
    (stream ? '  stream=true' : '')
  );

  if (stream) {
    _writeStream(res, model, replyText);
    return;
  }

  const promptTokens = messages.reduce((acc, m) => acc + Math.floor(String(m.content ?? '').length / 4), 0);
  const completionTokens = Math.floor(replyText.length / 4);

  res.json({
    id: `chatcmpl-${Math.random().toString(36).substring(2, 14)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: replyText },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

function _writeStream(res: Response, model: string, replyText: string): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const chunkId = `chatcmpl-${Math.random().toString(36).substring(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);

  const chunk = JSON.stringify({
    id: chunkId, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { role: 'assistant', content: replyText }, finish_reason: null }],
  });
  const done = JSON.stringify({
    id: chunkId, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });

  res.write(`data: ${chunk}\n\n`);
  res.write(`data: ${done}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
