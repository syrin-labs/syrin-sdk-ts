/**
 * Syrin SDK — OpenTelemetry bridge
 */

import type { Span, Tracer } from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { SyrinConfig, CallInfo } from './types.js';

export class OTelBridge {
  private config: SyrinConfig;
  private tracer: Tracer | null = null;
  private provider: NodeTracerProvider | null = null;
  private initialized = false;

  constructor(config: SyrinConfig) {
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

    const provider = new NodeTracerProvider();

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

    // Use synchronous require-style import for OTel API since setup was async
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
        // gen_ai.* standard attributes
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
        if (callInfo.finishReason) {
          span.setAttribute('gen_ai.response.finish_reasons', callInfo.finishReason);
        }

        // syrin.* extension attributes
        span.setAttribute('syrin.session_id', callInfo.sessionId);
        span.setAttribute('syrin.cost_usd', callInfo.costUsd);
        span.setAttribute('syrin.cumulative_cost_usd', callInfo.cumulativeCostUsd);
        span.setAttribute('syrin.config_applied', callInfo.configApplied);

        if (callInfo.agentId) {
          span.setAttribute('syrin.agent_id', callInfo.agentId);
        }

        // Capture content if enabled
        if (this.config.captureContent) {
          if (callInfo.messages) {
            span.addEvent('gen_ai.content.prompt', {
              'gen_ai.prompt': JSON.stringify(callInfo.messages),
            });
          }
          if (callInfo.responseText) {
            span.addEvent('gen_ai.content.completion', {
              'gen_ai.completion': callInfo.responseText,
            });
          }
        }

        // Handle error
        if (callInfo.error) {
          span.recordException(callInfo.error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: callInfo.error.message });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
      }
    );
  }

  async shutdown(): Promise<void> {
    if (this.provider) {
      await this.provider.shutdown();
    }
  }
}
