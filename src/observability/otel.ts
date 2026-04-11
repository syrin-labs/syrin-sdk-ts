/**
 * Syrin SDK — OpenTelemetry bridge
 *
 * Emits one span per LLM call with:
 *   - Standard gen_ai.* semantic-convention attributes (v1.38+)
 *   - Syrin-specific syrin.* extension attributes
 *   - Optional per-message span events (gen_ai.{role}.message, gen_ai.choice)
 *   - W3C Baggage propagation via BaggageSpanProcessor
 *   - OTel Metrics: token usage, operation duration, cost
 */

import type { Span, Tracer } from '@opentelemetry/api';
import type { NodeTracerProvider, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import type { SyrinSDKConfig, CallInfo } from '@/types.js';

// ---------------------------------------------------------------------------
// BaggageSpanProcessor
// ---------------------------------------------------------------------------

/**
 * Reads W3C Baggage and copies syrin.session_id / syrin.agent_id to every new span.
 * Duck-typed — does not extend SpanProcessor to avoid a hard import dep at module level.
 */
export class BaggageSpanProcessor {
  onStart(span: Span, parentContext?: unknown): void {
    // Dynamically load OTel API to avoid hard dep
    let otelApi: typeof import('@opentelemetry/api') | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      otelApi = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
    } catch {
      return;
    }
    const ctx = (parentContext as Parameters<typeof otelApi.context.with>[0]) ?? otelApi.context.active();
    for (const key of ['syrin.session_id', 'syrin.agent_id']) {
      const val = otelApi.propagation.getBaggage(ctx)?.getEntry(key)?.value;
      if (val) {
        try {
          span.setAttribute(key, val);
        } catch {
          // ignore
        }
      }
    }
  }
  onEnd(_span: Span): void {}
  shutdown(): Promise<void> { return Promise.resolve(); }
  forceFlush(): Promise<void> { return Promise.resolve(); }
}

/**
 * Return an OTel context with W3C Baggage set for sessionId and agentId.
 */
export function setBaggageContext(sessionId: string, agentId: string): unknown {
  let otelApi: typeof import('@opentelemetry/api') | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    otelApi = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
  } catch {
    return undefined;
  }
  const bag = otelApi.propagation.createBaggage({
    'syrin.session_id': { value: sessionId },
    'syrin.agent_id': { value: agentId },
  });
  return otelApi.propagation.setBaggage(otelApi.context.active(), bag);
}

// ---------------------------------------------------------------------------
// OTel Metrics (lazy — created once on first use)
// ---------------------------------------------------------------------------

let _tokenUsageHist: unknown = null;
let _operationDurationHist: unknown = null;
let _costHist: unknown = null;
let _metricsReady = false;

function _ensureMetrics(): void {
  if (_metricsReady) return;
  _metricsReady = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { metrics } = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
    const meter = metrics.getMeter('syrin', '0.1.0');
    _tokenUsageHist = meter.createHistogram('gen_ai.client.token.usage', {
      unit: '{token}',
      description: 'Measures number of input and output tokens used',
    });
    _operationDurationHist = meter.createHistogram('gen_ai.client.operation.duration', {
      unit: 's',
      description: 'GenAI operation duration',
    });
    _costHist = meter.createHistogram('syrin.cost.usd', {
      unit: 'usd',
      description: 'Cost of GenAI operation in USD',
    });
  } catch {
    // opentelemetry/api not available — metrics disabled
  }
}

export function recordMetrics(callInfo: CallInfo): void {
  _ensureMetrics();
  if (!_tokenUsageHist) return;
  try {
    const op = 'chat';
    const system = callInfo.provider;
    const model = callInfo.model;
    const tokenBase = { 'gen_ai.operation.name': op, 'gen_ai.system': system };
    (
      _tokenUsageHist as { record(v: number, attrs: Record<string, string>): void }
    ).record(callInfo.inputTokens, { ...tokenBase, 'gen_ai.token.type': 'input' });
    (
      _tokenUsageHist as { record(v: number, attrs: Record<string, string>): void }
    ).record(callInfo.outputTokens, { ...tokenBase, 'gen_ai.token.type': 'output' });

    const durAttrs = { 'gen_ai.operation.name': op, 'gen_ai.system': system, 'gen_ai.request.model': model };
    (_operationDurationHist as { record(v: number, attrs: Record<string, string>): void }).record(
      callInfo.durationMs / 1000,
      durAttrs
    );
    (_costHist as { record(v: number, attrs: Record<string, string>): void }).record(
      callInfo.costUsd,
      durAttrs
    );
  } catch {
    // ignore metric errors
  }
}

// ---------------------------------------------------------------------------
// OTelBridge
// ---------------------------------------------------------------------------

export class OTelBridge {
  private config: SyrinSDKConfig;
  private tracer: Tracer | null = null;
  private provider: NodeTracerProvider | null = null;
  private initialized = false;

  constructor(config: SyrinSDKConfig) {
    this.config = config;
  }

  setup(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (this.config.otelExporter === 'none') {
      return;
    }

    // Dynamically load OTel to avoid hard dependency
    this._setupAsync().catch((err) => {
      if (this.config.debug) {
        console.warn('[Syrin] Failed to initialize OTel:', err);
      }
    });
  }

  private async _setupAsync(): Promise<void> {
    let otelApi: typeof import('@opentelemetry/api');
    let otelSdkTrace: typeof import('@opentelemetry/sdk-trace-node');

    try {
      otelApi = await import('@opentelemetry/api');
      otelSdkTrace = await import('@opentelemetry/sdk-trace-node');
    } catch {
      if (this.config.debug) {
        console.warn('[Syrin] @opentelemetry packages not available. OTel spans will not be emitted.');
      }
      return;
    }

    const {
      NodeTracerProvider,
      SimpleSpanProcessor,
      ConsoleSpanExporter,
      BatchSpanProcessor,
    } = otelSdkTrace;

    if (this.config.debug) {
      const { diag, DiagConsoleLogger, DiagLogLevel } = otelApi;
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
    }

    // Resolve service.name: env var > agentId > fallback
    const serviceName =
      process.env['OTEL_SERVICE_NAME'] ||
      this.config.agentId ||
      'unknown-service';

    let otelResources: typeof import('@opentelemetry/resources') | undefined;
    try {
      otelResources = await import('@opentelemetry/resources');
    } catch {
      // Optional
    }

    let resource: ConstructorParameters<typeof NodeTracerProvider>[0] extends { resource?: infer R } ? R : never;
    if (otelResources) {
      resource = new otelResources.Resource({
        [(otelResources as unknown as Record<string, string | undefined>)['SEMRESATTRS_SERVICE_NAME'] ?? (otelResources as unknown as Record<string, string | undefined>)['ATTR_SERVICE_NAME'] ?? 'service.name']: serviceName,
        'syrin.sdk.language': 'typescript',
        'syrin.sdk.version': '0.1.0',
      }) as typeof resource;
    }

    // @ts-expect-error resource type varies by version
    const provider = new NodeTracerProvider(resource ? { resource } : undefined);

    if (this.config.otelExporter === 'console') {
      provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    } else if (this.config.otelExporter === 'otlp') {
      try {
        const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
        const exporter = new OTLPTraceExporter({
          url: `${this.config.otelEndpoint}/v1/traces`,
        });
        provider.addSpanProcessor(new BatchSpanProcessor(exporter));
      } catch (err) {
        if (this.config.debug) {
          console.warn('[Syrin] Failed to load OTLP exporter:', err);
        }
      }
    }

    // Add BaggageSpanProcessor so W3C baggage flows into spans
    provider.addSpanProcessor(new BaggageSpanProcessor() as unknown as SpanProcessor);

    provider.register();
    this.provider = provider;
    this.tracer = otelApi.trace.getTracer('syrin-sdk', '0.1.0');

    if (this.config.debug) {
      console.log(`[Syrin] OTel initialized with exporter: ${this.config.otelExporter}`);
    }
  }

  recordSpan(callInfo: CallInfo): void {
    if (this.config.otelExporter === 'none' || !this.tracer) {
      return;
    }

    let otelApi: typeof import('@opentelemetry/api');
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      otelApi = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
    } catch {
      return;
    }

    const { SpanStatusCode, SpanKind } = otelApi;
    const spanName = `chat ${callInfo.model}`;

    this.tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        startTime: Date.now() - callInfo.durationMs,
      },
      (span: Span) => {
        // ---- Standard gen_ai.* attributes ----
        span.setAttribute('gen_ai.system', callInfo.provider);
        span.setAttribute('gen_ai.operation.name', 'chat');
        span.setAttribute('gen_ai.request.model', callInfo.model);
        span.setAttribute('gen_ai.response.model', callInfo.model);
        span.setAttribute('gen_ai.usage.input_tokens', callInfo.inputTokens);
        span.setAttribute('gen_ai.usage.output_tokens', callInfo.outputTokens);
        span.setAttribute(
          'gen_ai.usage.total_tokens',
          callInfo.inputTokens + callInfo.outputTokens
        );

        if (callInfo.temperature !== undefined) {
          span.setAttribute('gen_ai.request.temperature', callInfo.temperature);
        }
        if (callInfo.maxTokens !== undefined) {
          span.setAttribute('gen_ai.request.max_tokens', callInfo.maxTokens);
        }

        // Optional request attributes
        if (callInfo.topP !== undefined) {
          span.setAttribute('gen_ai.request.top_p', callInfo.topP);
        }
        if (callInfo.frequencyPenalty !== undefined) {
          span.setAttribute('gen_ai.request.frequency_penalty', callInfo.frequencyPenalty);
        }
        if (callInfo.presencePenalty !== undefined) {
          span.setAttribute('gen_ai.request.presence_penalty', callInfo.presencePenalty);
        }
        if (callInfo.stop !== undefined) {
          const stopSeqs = Array.isArray(callInfo.stop) ? callInfo.stop : [callInfo.stop];
          span.setAttribute('gen_ai.request.stop_sequences', stopSeqs);
        }

        if (callInfo.finishReason) {
          // finish_reasons must be an array
          span.setAttribute('gen_ai.response.finish_reasons', [callInfo.finishReason]);
        }

        // ---- Syrin core attributes ----
        span.setAttribute('syrin.session_id', callInfo.sessionId);
        span.setAttribute('syrin.cost_usd', callInfo.costUsd);
        span.setAttribute('syrin.cumulative_cost_usd', callInfo.cumulativeCostUsd);
        span.setAttribute('syrin.config_applied', callInfo.configApplied);

        if (callInfo.agentId) {
          span.setAttribute('syrin.agent_id', callInfo.agentId);
        }

        // ---- Framework context attributes ----
        if (callInfo.framework) {
          span.setAttribute('syrin.framework', callInfo.framework);
        }
        if (callInfo.langgraphGraphId) {
          span.setAttribute('langgraph.graph_id', callInfo.langgraphGraphId);
        }
        if (callInfo.langgraphNodeName) {
          span.setAttribute('langgraph.node_name', callInfo.langgraphNodeName);
        }

        // ---- Telemetry signal attributes ----
        if (callInfo.callIndex !== undefined) {
          span.setAttribute('syrin.call_index', callInfo.callIndex);
        }
        if (callInfo.contextUtilization !== undefined) {
          span.setAttribute('syrin.context_utilization', callInfo.contextUtilization);
        }
        if (callInfo.conversationHash !== undefined) {
          span.setAttribute('syrin.conversation_hash', callInfo.conversationHash);
        }
        if (callInfo.systemPromptHash !== undefined) {
          span.setAttribute('syrin.system_prompt_hash', callInfo.systemPromptHash);
        }
        if (callInfo.toolSetHash !== undefined) {
          span.setAttribute('syrin.tool_set_hash', callInfo.toolSetHash);
        }
        if (callInfo.modelConfigHash !== undefined) {
          span.setAttribute('syrin.model_config_hash', callInfo.modelConfigHash);
        }
        if (callInfo.messageCount !== undefined) {
          span.setAttribute('syrin.message_count', callInfo.messageCount);
        }
        if (callInfo.repeatedToolCalls !== undefined) {
          span.setAttribute('syrin.repeated_tool_calls', callInfo.repeatedToolCalls);
        }

        // ---- Per-message content events ----
        if (this.config.captureContent) {
          if (callInfo.messages) {
            for (const msg of callInfo.messages as Array<Record<string, unknown>>) {
              const role = String(msg['role'] ?? 'user');
              const content = msg['content'];
              const contentStr =
                typeof content === 'string' ? content : JSON.stringify(content);
              span.addEvent(`gen_ai.${role}.message`, {
                [`gen_ai.${role}.message`]: contentStr,
              });
            }
          }
          if (callInfo.responseText) {
            span.addEvent('gen_ai.choice', {
              'gen_ai.choice.index': 0,
              'gen_ai.choice.finish_reason': callInfo.finishReason || 'stop',
              'gen_ai.choice.message.role': 'assistant',
              'gen_ai.choice.message.content': callInfo.responseText,
            });
          }
        }

        // ---- Error status ----
        if (callInfo.error) {
          span.recordException(callInfo.error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: callInfo.error.message });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
      }
    );

    // Record metrics after span finishes
    try {
      recordMetrics(callInfo);
    } catch {
      // ignore metric errors
    }
  }

  async shutdown(): Promise<void> {
    if (this.provider) {
      await this.provider.shutdown();
    }
  }
}
