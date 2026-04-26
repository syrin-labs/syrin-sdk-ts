/**
 * AgentHandle — returned by sdk.agent(id), provides scoped cfg/field/run/chat
 */

import type { SyrinSDKInstance } from '@/index';
import type { FieldSchema } from '@/config/store';
import { agentStorage } from '@/agent/context.js';
import { sessionStorage } from '@/core/session.js';
import { generateId } from '@/utils/helpers.js';

export interface AgentFieldDecl {
  key: string;
  default: unknown;
  label?: string;
  type?: string;
  ge?: number;
  le?: number;
  enum?: unknown[];
  multiline?: boolean;
  description?: string;
}

export class AgentHandle {
  private outputSchema: Record<string, string> | undefined;

  constructor(
    private readonly agentId: string,
    private readonly sdk: SyrinSDKInstance,
  ) {}

  get id(): string {
    return this.agentId;
  }

  /**
   * Declare a remotely-configurable field scoped to this agent.
   * Registers in the SDK's schema so the dashboard shows a config panel.
   * Returns self for chaining.
   */
  field<T>(key: string, defaultValue: T, opts?: Partial<FieldSchema> & { label?: string; ge?: number; le?: number; enum?: unknown[]; multiline?: boolean }): this {
    const core = (this.sdk as unknown as { _core: Record<string, unknown> })._core;
    if (core) {
      if (!core['_agentFields']) core['_agentFields'] = {} as Record<string, AgentFieldDecl[]>;
      const agentFields = core['_agentFields'] as Record<string, AgentFieldDecl[]>;
      if (!agentFields[this.agentId]) agentFields[this.agentId] = [];
      agentFields[this.agentId].push({
        key,
        default: defaultValue,
        label: opts?.['label'],
        ge: opts?.ge,
        le: opts?.le,
        enum: opts?.enum,
        multiline: opts?.multiline,
        description: opts?.description,
      });
    }
    return this;
  }

  /**
   * Declare what outputs this agent produces.
   * Used by workflows to track data flow between agents.
   */
  outputs(schema: Record<string, string>): this {
    this.outputSchema = schema;
    return this;
  }

  /**
   * Read config scoped to this agent.
   * Priority: agents.{agentId}.{key} → {key} (global) → defaultValue
   */
  cfg<T>(key: string, defaultValue: T): T {
    const sessionId = sessionStorage.getStore() ?? (this.sdk as unknown as { _sessionId: string })._sessionId;
    const effectiveConfig = this.sdk.activeConfig(sessionId);

    // Check agent-scoped key first
    const agentScopedKey = `agents.${this.agentId}.${key}`;
    if (effectiveConfig[agentScopedKey] != null) return effectiveConfig[agentScopedKey] as T;

    // Then global key
    if (effectiveConfig[key] != null) return effectiveConfig[key] as T;

    // Then last segment only (e.g. "llm.model" → "model")
    const lastSegment = key.split('.').pop()!;
    if (lastSegment !== key && effectiveConfig[lastSegment] != null) return effectiveConfig[lastSegment] as T;

    return defaultValue;
  }

  /**
   * Run an async function within this agent's context.
   * Auto-emits HANDOFF when switching from a different agent.
   * Auto-emits AGENT_RUN_STARTED / AGENT_RUN_ENDED.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const currentCtx = agentStorage.getStore();

    if (currentCtx?.agentId && currentCtx.agentId !== this.agentId) {
      this.sdk.emit('HANDOFF', {
        from_agent: currentCtx.agentId,
        to_agent: this.agentId,
      });
    }

    const runId = generateId('run_');
    const ctx = {
      agentId: this.agentId,
      runId,
      workflowId: currentCtx?.workflowId,
      swarmId: currentCtx?.swarmId,
      parentRunId: currentCtx?.runId,
    };

    this.sdk.emit('AGENT_RUN_STARTED', { agent_id: this.agentId, run_id: runId });
    const start = Date.now();
    try {
      return await agentStorage.run(ctx, fn);
    } finally {
      this.sdk.emit('AGENT_RUN_ENDED', {
        agent_id: this.agentId,
        run_id: runId,
        duration_ms: Date.now() - start,
      });
    }
  }

  /**
   * SDK owns the tool loop — no more 40-line boilerplate per agent.
   * Auto-emits HANDOFF when switching from a different agent.
   */
  async chat(options: {
    client: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    messages: Array<{ role: string; content: string | null }>;
    tools?: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    onTool?: ((name: string, args: Record<string, unknown>) => any) // eslint-disable-line @typescript-eslint/no-explicit-any
      | Record<string, (args: Record<string, unknown>) => any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    maxRounds?: number;
    maxTokens?: number;
  }): Promise<string> {
    const {
      client,
      messages,
      tools,
      onTool,
      maxRounds = 8,
      maxTokens = 1500,
    } = options;

    // Auto-emit HANDOFF when switching agents
    const currentCtx = agentStorage.getStore();
    if (currentCtx?.agentId && currentCtx.agentId !== this.agentId) {
      this.sdk.emit('HANDOFF', {
        from_agent: currentCtx.agentId,
        to_agent: this.agentId,
      });
    }

    // Run the chat within this agent's context
    return agentStorage.run(
      {
        agentId: this.agentId,
        runId: currentCtx?.runId ?? generateId('run_'),
        workflowId: currentCtx?.workflowId,
        swarmId: currentCtx?.swarmId,
        parentRunId: currentCtx?.parentRunId,
      },
      () => this._runChat(client, messages, tools, onTool, maxRounds, maxTokens)
    );
  }

  private async _runChat(
    client: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    messages: Array<{ role: string; content: string | null }>,
    tools: Array<Record<string, any>> | undefined, // eslint-disable-line @typescript-eslint/no-explicit-any
    onTool: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    maxRounds: number,
    maxTokens: number,
  ): Promise<string> {
    const model = this.cfg('llm.model', 'gpt-4o-mini');
    const temperature = this.cfg('llm.temperature', 0.7);

    let currentMessages: Array<Record<string, any>> = [...messages]; // eslint-disable-line @typescript-eslint/no-explicit-any

    for (let round = 0; round <= maxRounds; round++) {
      const params: Record<string, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
        model,
        temperature,
        messages: currentMessages,
        max_tokens: maxTokens,
      };

      if (tools && round < maxRounds) {
        params.tools = tools;
        params.tool_choice = 'auto';
      }

      const resp = await client.chat.completions.create(params);
      const msg = resp.choices[0].message;

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return msg.content || '';
      }

      currentMessages.push({
        role: 'assistant',
        tool_calls: msg.tool_calls,
        content: msg.content,
      });

      for (const tc of msg.tool_calls) {
        const toolName = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          // keep empty
        }

        let resultStr: string | null = null;
        let errorStr: string | undefined;

        try {
          let result: any; // eslint-disable-line @typescript-eslint/no-explicit-any
          if (typeof onTool === 'function') {
            result = onTool(toolName, args);
          } else if (onTool && typeof onTool === 'object') {
            const handler = onTool[toolName];
            if (!handler) {
              errorStr = `Unknown tool: ${toolName}`;
            } else {
              result = handler(args);
            }
          } else {
            errorStr = 'No on_tool handler provided';
          }

          if (result instanceof Promise) {
            result = await result;
          }

          if (!errorStr) {
            resultStr =
              typeof result === 'string' ? result : JSON.stringify(result);
          }
        } catch (err) {
          errorStr = err instanceof Error ? err.message : String(err);
        }

        // Emit TOOL_RESULT
        if (this.sdk) {
          (this.sdk as any).emit('TOOL_RESULT', { // eslint-disable-line @typescript-eslint/no-explicit-any
            tool_call_id: tc.id,
            tool_name: toolName,
            result: resultStr,
            error: errorStr,
            latency_ms: 1,
          });
        }

        currentMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultStr || `[error] ${errorStr}`,
        });
      }
    }

    // Final call without tools
    const resp = await client.chat.completions.create({
      model,
      temperature,
      messages: currentMessages,
      max_tokens: maxTokens,
    });
    return resp.choices[0].message.content || '';
  }
}
