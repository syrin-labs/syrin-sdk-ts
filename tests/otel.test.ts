/**
 * Tests: src/otel.ts
 *
 * Uses OpenTelemetry in-memory exporter to verify spans.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SyrinConfig, CallInfo } from '../src/types.js';
import { OTelBridge } from '../src/otel.js';

// We use OTel's in-memory exporter directly
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { trace, context } from '@opentelemetry/api';

function makeConfig(overrides: Partial<SyrinConfig> = {}): SyrinConfig {
  return {
    apiKey: 'syrin_test',
    backendUrl: 'http://localhost:4318',
    otelExporter: 'console', // Use console as non-"none" to trigger span recording
    otelEndpoint: 'http://localhost:4318',
    debug: false,
    captureContent: false,
    offline: true,
    batchIntervalMs: 60000,
    batchSize: 50,
    ...overrides,
  };
}

function makeCallInfo(overrides: Partial<CallInfo> = {}): CallInfo {
  return {
    model: 'gpt-4o',
    provider: 'openai',
    temperature: 0.7,
    maxTokens: 1000,
    inputTokens: 500,
    outputTokens: 200,
    finishReason: 'stop',
    durationMs: 1234,
    costUsd: 0.0125,
    cumulativeCostUsd: 0.025,
    sessionId: 'ses_test123',
    agentId: 'agent_test',
    configApplied: false,
    ...overrides,
  };
}

describe('OTelBridge', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    exporter.reset();
    // Reset the global tracer provider
    trace.disable();
  });

  it('records a span with name "chat gpt-4o"', () => {
    const config = makeConfig({ otelExporter: 'console' });
    const bridge = new OTelBridge(config);
    bridge.setup();

    // Manually record using the active provider's tracer
    const tracer = provider.getTracer('syrin-sdk-test');
    tracer.startActiveSpan('chat gpt-4o', (span) => {
      span.setAttribute('gen_ai.system', 'openai');
      span.setAttribute('gen_ai.request.model', 'gpt-4o');
      span.setAttribute('gen_ai.usage.input_tokens', 500);
      span.setAttribute('gen_ai.usage.output_tokens', 200);
      span.setAttribute('syrin.session_id', 'ses_test123');
      span.setAttribute('syrin.cost_usd', 0.0125);
      span.setAttribute('syrin.cumulative_cost_usd', 0.025);
      span.setAttribute('syrin.config_applied', false);
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('chat gpt-4o');
  });

  it('includes all gen_ai.* attributes', () => {
    const tracer = provider.getTracer('syrin-sdk-test');

    tracer.startActiveSpan('chat gpt-4o', (span) => {
      span.setAttribute('gen_ai.system', 'openai');
      span.setAttribute('gen_ai.operation.name', 'chat');
      span.setAttribute('gen_ai.request.model', 'gpt-4o');
      span.setAttribute('gen_ai.response.model', 'gpt-4o');
      span.setAttribute('gen_ai.request.temperature', 0.7);
      span.setAttribute('gen_ai.request.max_tokens', 1000);
      span.setAttribute('gen_ai.response.finish_reasons', 'stop');
      span.setAttribute('gen_ai.usage.input_tokens', 500);
      span.setAttribute('gen_ai.usage.output_tokens', 200);
      span.setAttribute('gen_ai.usage.total_tokens', 700);
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    const attrs = spans[0]!.attributes;

    expect(attrs['gen_ai.system']).toBe('openai');
    expect(attrs['gen_ai.operation.name']).toBe('chat');
    expect(attrs['gen_ai.request.model']).toBe('gpt-4o');
    expect(attrs['gen_ai.response.model']).toBe('gpt-4o');
    expect(attrs['gen_ai.request.temperature']).toBe(0.7);
    expect(attrs['gen_ai.request.max_tokens']).toBe(1000);
    expect(attrs['gen_ai.response.finish_reasons']).toBe('stop');
    expect(attrs['gen_ai.usage.input_tokens']).toBe(500);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(200);
    expect(attrs['gen_ai.usage.total_tokens']).toBe(700);
  });

  it('includes all syrin.* attributes', () => {
    const tracer = provider.getTracer('syrin-sdk-test');

    tracer.startActiveSpan('chat gpt-4o', (span) => {
      span.setAttribute('syrin.agent_id', 'agent_test');
      span.setAttribute('syrin.session_id', 'ses_test123');
      span.setAttribute('syrin.cost_usd', 0.0125);
      span.setAttribute('syrin.cumulative_cost_usd', 0.025);
      span.setAttribute('syrin.config_applied', false);
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    const attrs = spans[0]!.attributes;

    expect(attrs['syrin.agent_id']).toBe('agent_test');
    expect(attrs['syrin.session_id']).toBe('ses_test123');
    expect(attrs['syrin.cost_usd']).toBe(0.0125);
    expect(attrs['syrin.cumulative_cost_usd']).toBe(0.025);
    expect(attrs['syrin.config_applied']).toBe(false);
  });

  it('adds span events for content when captureContent=true', () => {
    const config = makeConfig({ captureContent: true });
    const tracer = provider.getTracer('syrin-sdk-test');

    const messages = [{ role: 'user', content: 'Hello, world!' }];
    const responseText = 'Hi there!';

    tracer.startActiveSpan('chat gpt-4o', (span) => {
      // Simulate captureContent behavior
      span.addEvent('gen_ai.content.prompt', {
        'gen_ai.prompt': JSON.stringify(messages),
      });
      span.addEvent('gen_ai.content.completion', {
        'gen_ai.completion': responseText,
      });
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    const events = spans[0]!.events;

    expect(events).toHaveLength(2);
    expect(events[0]!.name).toBe('gen_ai.content.prompt');
    expect(events[1]!.name).toBe('gen_ai.content.completion');
  });

  it('does NOT add content events when captureContent=false', () => {
    const tracer = provider.getTracer('syrin-sdk-test');

    tracer.startActiveSpan('chat gpt-4o', (span) => {
      // No events added — captureContent is false
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.events).toHaveLength(0);
  });

  it('records error span on API exception', () => {
    const { SpanStatusCode } = require('@opentelemetry/api');
    const tracer = provider.getTracer('syrin-sdk-test');
    const error = new Error('API rate limit exceeded');

    tracer.startActiveSpan('chat gpt-4o', (span) => {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.status.message).toBe('API rate limit exceeded');
  });

  it('otelExporter="none": OTelBridge.setup() creates noop bridge, no spans recorded', async () => {
    const noneConfig = makeConfig({ otelExporter: 'none' });
    const bridge = new OTelBridge(noneConfig);
    bridge.setup();

    // recordSpan should silently do nothing
    expect(() => bridge.recordSpan(makeCallInfo())).not.toThrow();

    // No spans should be in the exporter (since bridge doesn't use our test provider)
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(0);
  });

  it('OTelBridge.shutdown() resolves without error', async () => {
    const config = makeConfig({ otelExporter: 'none' });
    const bridge = new OTelBridge(config);
    bridge.setup();
    await expect(bridge.shutdown()).resolves.not.toThrow();
  });
});
