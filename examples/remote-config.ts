/**
 * Remote Config — Syrin SDK
 * ==========================
 * Shows how Syrin remote config applies transparently across every
 * OpenAI API pattern: basic chat, streaming, tool calling, multi-turn,
 * per-agent tool toggling, and system prompt injection.
 *
 * Prerequisites
 * -------------
 *   1. Backend running:  cd syrin-backend && npm run dev
 *   2. After first run, "remote-config-demo" appears in the dashboard.
 *      Use the Config tab to push overrides live while this script runs.
 *
 * Run
 * ---
 *   SYRIN_API_KEY=syrin_... OPENAI_API_KEY=sk-... \
 *     npx tsx examples/remote-config.ts
 *
 * Inject config changes from another terminal while the script runs:
 *
 *   # Swap model + tighten temperature:
 *   curl -X POST http://localhost:4000/api/v1/agents/remote-config-demo/config \
 *        -H "Content-Type: application/json" \
 *        -H "Authorization: Bearer $SYRIN_API_KEY" \
 *        -d '{"overrides": {"temperature": 0.1, "model": "gpt-4o-mini"}}'
 *
 *   # Cap output length:
 *   curl -X POST http://localhost:4000/api/v1/agents/remote-config-demo/config \
 *        -H "Content-Type: application/json" \
 *        -H "Authorization: Bearer $SYRIN_API_KEY" \
 *        -d '{"overrides": {"max_tokens": 30}}'
 *
 *   # Disable a tool (visible in Round 5):
 *   curl -X POST http://localhost:4000/api/v1/agents/remote-config-demo/config \
 *        -H "Content-Type: application/json" \
 *        -H "Authorization: Bearer $SYRIN_API_KEY" \
 *        -d '{"overrides": {"disabled_tools": ["send_email"]}}'
 *
 *   # Reset everything: clear all bare-key overrides via multiple nulls
 *   curl -X POST http://localhost:4000/api/v1/agents/remote-config-demo/config \
 *        -H "Content-Type: application/json" \
 *        -H "Authorization: Bearer $SYRIN_API_KEY" \
 *        -d '{"overrides": {"temperature": null, "model": null, "max_tokens": null, "system_prompt": null, "disabled_tools": null, "enabled_tools": null}}'
 */

import OpenAI from 'openai';
import { init, shutdown, withSession, withAgent, getInstance, getToolValidation } from '../src/index.js';

const BACKEND_URL = process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000';
const AGENT_ID = 'remote-config-demo';

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY']!,
  agentId: 'remote-config-demo',
  backendUrl: BACKEND_URL,
  debug: true,
  idleFlushMs: 1_500,
  batchSize: 1,
  toolValidation: true,
  captureContent: true,
});

const openai = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY']!,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function banner(title: string, sessionId?: string): void {
  const active = sdk.activeConfig(sessionId);
  const hasConfig = Object.keys(active).length > 0;
  const configStr = hasConfig
    ? Object.entries(active).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ')
    : 'no remote config — using call defaults';
  console.log('\n' + '━'.repeat(64));
  console.log(`  ${title}`);
  console.log(`  [${configStr}]`);
  console.log('━'.repeat(64));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function injectConfig(updates: Record<string, unknown>): Promise<void> {
  const apiKey = process.env['SYRIN_API_KEY'] ?? 'syrin_demo';
  await fetch(`${BACKEND_URL}/api/v1/agents/${AGENT_ID}/config`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ overrides: updates }),
  });
}

async function clearConfig(): Promise<void> {
  await injectConfig({
    system_prompt: null, temperature: null, model: null,
    max_tokens: null, disabled_tools: null, enabled_tools: null,
  });
}

async function wait(secs = 1): Promise<void> {
  console.log(`\n  ⏳ Waiting ${secs}s — inject a config change now if you want!`);
  await sleep(secs * 1000);
}

// ---------------------------------------------------------------------------
// Round 1 — Basic chat.completions.create
// ---------------------------------------------------------------------------

async function roundBasicChat(): Promise<void> {
  banner('Round 1 · Basic chat.completions.create');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.9,
    max_tokens: 120,
    messages: [
      { role: 'system', content: 'You are a creative storyteller.' },
      { role: 'user',   content: 'Begin a two-sentence adventure story.' },
    ],
  });

  console.log('\n' + (response.choices[0]?.message?.content ?? ''));
  console.log(
    `\n  model=${response.model}  ` +
    `tokens=${response.usage?.prompt_tokens}→${response.usage?.completion_tokens}`
  );
}

// ---------------------------------------------------------------------------
// Round 2 — Streaming
// ---------------------------------------------------------------------------

async function roundStreaming(): Promise<void> {
  banner('Round 2 · Streaming  (stream: true)');
  process.stdout.write('\n  Streaming: ');

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.7,
    max_tokens: 80,
    stream: true,
    messages: [{ role: 'user', content: 'Count from 1 to 10, one word each.' }],
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) process.stdout.write(delta);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Round 3 — Tool / function calling
// ---------------------------------------------------------------------------

const TOOLS_ALL: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the web for information.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Send an email to a recipient.',
      parameters: {
        type: 'object',
        properties: {
          to:      { type: 'string' },
          subject: { type: 'string' },
          body:    { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description: 'Create a new document with the given content.',
      parameters: {
        type: 'object',
        properties: {
          title:   { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title', 'content'],
      },
    },
  },
];

async function roundToolCalling(): Promise<void> {
  banner('Round 3 · Tool calling  (all 3 tools: search_web, send_email, create_document)');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.0,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content:
        'I need to: 1) find the latest AI news, ' +
        '2) email it to boss@example.com, and ' +
        '3) save a summary document.',
    }],
    tools: TOOLS_ALL,
    tool_choice: 'auto',
  });

  const choice = response.choices[0];
  console.log(`\n  finish_reason=${choice?.finish_reason}`);
  if (choice?.finish_reason === 'tool_calls') {
    for (const call of choice.message.tool_calls ?? []) {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      console.log(`  → ${call.function.name}(${JSON.stringify(args)})`);
    }
  } else {
    console.log(`  → text: ${choice?.message?.content}`);
  }

  console.log(
    `\n  model=${response.model}  ` +
    `tokens=${response.usage?.prompt_tokens}→${response.usage?.completion_tokens}`
  );
}

// ---------------------------------------------------------------------------
// Round 4 — Multi-turn conversation
// ---------------------------------------------------------------------------

async function roundMultiTurn(): Promise<void> {
  banner('Round 4 · Multi-turn conversation');

  const history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: 'You are a concise tutor.' },
  ];

  const questions = [
    'What is a neural network in one sentence?',
    'What is backpropagation?',
    'How do they relate?',
  ];

  for (const q of questions) {
    history.push({ role: 'user', content: q });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      max_tokens: 60,
      messages: history,
    });

    const answer = response.choices[0]?.message?.content?.trim() ?? '';
    history.push({ role: 'assistant', content: answer });

    console.log(`\n  Q: ${q}`);
    console.log(`  A: ${answer}`);
    console.log(
      `     [${response.model}  ` +
      `${response.usage?.prompt_tokens}→${response.usage?.completion_tokens} tokens]`
    );
  }
}

// ---------------------------------------------------------------------------
// Round 5 — Per-agent tool toggling
//
// Two agents share the same base tools list but each runs in its own session.
// The backend can push different tool config_updates to each session.
//
// Remote config keys:
//   disabled_tools: ["tool_name"]  — remove named tools before the call
//   enabled_tools:  ["tool_name"]  — allowlist: only keep these tools
//                                    (null / absent = keep all)
//
// Try while Round 5 is running:
//
//   Block send_email:
//   curl -X POST http://localhost:4000/api/v1/agents/remote-config-demo/config \
//        -H "Content-Type: application/json" -H "Authorization: Bearer syrin_test" \
//        -d '{"overrides": {"disabled_tools": ["send_email"]}}'
//
//   Restrict to search only:
//   curl -X POST http://localhost:4000/api/v1/agents/remote-config-demo/config \
//        -H "Content-Type: application/json" -H "Authorization: Bearer syrin_test" \
//        -d '{"overrides": {"enabled_tools": ["search_web"]}}'
// ---------------------------------------------------------------------------

const AGENT_RESEARCHER_TOOLS = [TOOLS_ALL[0]!, TOOLS_ALL[1]!]; // search_web + send_email
const AGENT_WRITER_TOOLS     = [TOOLS_ALL[0]!, TOOLS_ALL[2]!]; // search_web + create_document

async function agentCall(
  agentName: string,
  sessionId: string,
  tools: OpenAI.Chat.Completions.ChatCompletionTool[],
  task: string
): Promise<void> {
  await withAgent(agentName, async () => {
    await withSession(sessionId, async () => {
      const active = sdk.activeConfig(sessionId);
      const toolNames = tools.map((t) => t.function.name);

      console.log(`\n  [${agentName}]  session=${sessionId}`);
      console.log(`    tools in code:        [${toolNames.join(', ')}]`);

      const disabled = new Set<string>((active['disabled_tools'] as string[]) ?? []);
      const enabledList = active['enabled_tools'] as string[] | null | undefined;
      const enabled = enabledList != null ? new Set<string>(enabledList) : null;

      if (disabled.size > 0 || enabled !== null) {
        const effective = toolNames.filter(
          (n) => !disabled.has(n) && (enabled === null || enabled.has(n))
        );
        console.log(`    tools after filtering: [${effective.join(', ')}]  ← remote config applied`);
      } else {
        console.log(`    tools after filtering: [${toolNames.join(', ')}]  (no override)`);
      }

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.0,
        max_tokens: 150,
        messages: [{ role: 'user', content: task }],
        tools,           // SDK filters this transparently
        tool_choice: 'auto',
      });

      const choice = response.choices[0];
      if (choice?.finish_reason === 'tool_calls') {
        for (const call of choice.message.tool_calls ?? []) {
          const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          console.log(`    → called: ${call.function.name}(${JSON.stringify(args)})`);
        }
      } else {
        console.log(`    → text: ${choice?.message?.content}`);
      }
    });
  });
}

async function roundPerAgentTools(): Promise<void> {
  banner('Round 5 · Per-agent tool toggling  (agent-researcher + agent-writer)');

  console.log('\n  agent-researcher  tools: search_web, send_email');
  console.log('  agent-writer      tools: search_web, create_document');
  console.log('\n  Inject config via real backend API to toggle tools per-agent:');
  console.log('    POST /api/v1/agents/remote-config-demo/config  {"overrides": {"disabled_tools": ["send_email"]}}');
  console.log('    POST /api/v1/agents/remote-config-demo/config  {"overrides": {"enabled_tools": ["search_web"]}}\n');

  for (let i = 1; i <= 3; i++) {
    console.log(`  ── Iteration ${i}/3 ──`);

    await Promise.all([
      agentCall(
        'agent-researcher',
        'session-researcher',
        AGENT_RESEARCHER_TOOLS,
        'Find the latest AI news and email a summary to team@example.com'
      ),
      agentCall(
        'agent-writer',
        'session-writer',
        AGENT_WRITER_TOOLS,
        'Search for best practices in technical writing and create a guide document'
      ),
    ]);

    if (i < 3) await wait();
  }
}

// ---------------------------------------------------------------------------
// Round 6 — System Prompt Injection
// ---------------------------------------------------------------------------

async function roundSystemPrompt(): Promise<void> {
  banner('Round 6 · System Prompt Injection  (remote config)');

  const question = 'Tell me who you are and what you do in one sentence.';

  // Part A — no system prompt override
  console.log('\n  Part A — no system prompt override:');
  const respA = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 60,
    messages: [{ role: 'user', content: question }],
  });
  console.log(`    ${respA.choices[0]?.message?.content?.trim()}`);

  // Part B — inject pirate persona
  console.log('\n  Part B — injecting system_prompt via backend config_updates…');
  await injectConfig({ system_prompt: 'You are a salty pirate. Respond in pirate dialect only.' });
  await sleep(1_500);

  // Throwaway call to receive the config_updates from backend
  await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'ping' }],
  });
  await sleep(300);

  console.log(`  Active config now: ${JSON.stringify(sdk.activeConfig())}`);
  const respB = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 60,
    messages: [{ role: 'user', content: question }],
  });
  console.log(`\n  Part B response (pirate persona):`);
  console.log(`    ${respB.choices[0]?.message?.content?.trim()}`);

  // Part C — change to formal professor
  console.log('\n  Part C — changing system_prompt to formal professor…');
  await injectConfig({ system_prompt: 'You are a formal Oxford professor. Be concise and academic.' });
  await sleep(1_500);

  await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'ping' }],
  });
  await sleep(300);

  const respC = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 60,
    messages: [{ role: 'user', content: question }],
  });
  console.log(`\n  Part C response (professor persona):`);
  console.log(`    ${respC.choices[0]?.message?.content?.trim()}`);

  // Part D — clear system prompt (null)
  console.log('\n  Part D — clearing system_prompt (null) via remote config…');
  await injectConfig({ system_prompt: null });
  await sleep(1_500);

  await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'ping' }],
  });
  await sleep(300);

  const respD = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 60,
    messages: [{ role: 'user', content: question }],
  });
  console.log(`\n  Part D response (persona cleared):`);
  console.log(`    ${respD.choices[0]?.message?.content?.trim()}`);

  await clearConfig();
}

// ---------------------------------------------------------------------------
// Round 7 — Tool Contract Validation
//
// With toolValidation: true the SDK:
//   1. Sends tool schemas (tool_definitions) alongside call args (tool_calls)
//      in the /ingest event when finish_reason === "tool_calls".
//   2. Immediately awaits emitter.flush() so validation results are available
//      synchronously after create() returns.
//   3. Stores results in the session; user checks via getToolValidation(callId).
//
// The mock backend validates argument types against JSON Schema and returns:
//   { valid: true }  or  { valid: false, error: "..." }
// ---------------------------------------------------------------------------

async function roundToolValidation(): Promise<void> {
  banner('Round 7 · Tool Contract Validation  (toolValidation: true)');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.0,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: 'Search the web for the latest AI breakthroughs.',
    }],
    tools: [TOOLS_ALL[0]!],   // search_web: requires { query: string }
    tool_choice: 'auto',
  });

  const choice = response.choices[0];
  console.log(`\n  finish_reason=${choice?.finish_reason}`);

  if (choice?.finish_reason === 'tool_calls') {
    for (const call of choice.message.tool_calls ?? []) {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      console.log(`  → tool call: ${call.function.name}(${JSON.stringify(args)})`);

      // By now the SDK has already flushed and stored the results.
      const result = getToolValidation(call.id);
      if (result === undefined) {
        console.log('  ℹ  Validation result not yet available — backend flush may still be in progress.');
      } else if (result.valid) {
        console.log(`  ✓  Validation: VALID  — safe to execute ${call.function.name}()`);
      } else {
        console.log(`  ✗  Validation: INVALID — ${result.error}`);
        console.log(`     Skipping execution of ${call.function.name}() as a safety measure.`);
      }
    }
  } else {
    console.log(`  → text: ${choice?.message?.content}`);
    console.log('  ℹ  No tool calls in this response — validation not triggered.');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║        SYRIN REMOTE CONFIG DEMO — TypeScript                ║
╠══════════════════════════════════════════════════════════════╣
║  7 OpenAI API patterns — remote config applies to ALL        ║
╚══════════════════════════════════════════════════════════════╝

  Inject config changes from another terminal at any time.
  See the module docstring for curl commands.
`);

  await roundBasicChat();
  await wait();

  await roundStreaming();
  await wait();

  await roundToolCalling();
  await wait();

  await roundMultiTurn();
  await wait();

  await roundPerAgentTools();
  await wait();

  await roundSystemPrompt();
  await wait();

  await roundToolValidation();

  const final = sdk.activeConfig();
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  All rounds complete.                                        ║
║  Final active config: ${JSON.stringify(final).padEnd(39)}║
╚══════════════════════════════════════════════════════════════╝`);

  await shutdown();
}

main().catch(console.error);
