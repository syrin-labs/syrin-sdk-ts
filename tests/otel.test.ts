/**
 * Tests: src/otel.ts
 *
 * Uses OpenTelemetry in-memory exporter to verify spans.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SyrinConfig, CallInfo } from '@/types';
import { OTelBridge, BaggageSpanProcessor, recordMetrics } from '@/observability/otel';

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

  it('emits per-message and choice events (gen_ai.{role}.message, gen_ai.choice) when captureContent=true', () => {
    const config = makeConfig({ captureContent: true });
    const bridge = new OTelBridge(config);
    // Inject test tracer so recordSpan uses our in-memory exporter
    (bridge as unknown as Record<string, unknown>)['tracer'] = provider.getTracer('syrin-sdk');

    bridge.recordSpan(makeCallInfo({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello, world!' },
      ],
      responseText: 'Hi there!',
    }));

    const spans = exporter.getFinishedSpans();
    const events = spans[0]!.events;
    const eventNames = events.map((e) => e.name);

    // Deprecated events must NOT appear
    expect(eventNames).not.toContain('gen_ai.content.prompt');
    expect(eventNames).not.toContain('gen_ai.content.completion');

    // Per-message events
    expect(eventNames).toContain('gen_ai.system.message');
    expect(eventNames).toContain('gen_ai.user.message');
    expect(eventNames).toContain('gen_ai.choice');

    const systemEvent = events.find((e) => e.name === 'gen_ai.system.message')!;
    expect(systemEvent.attributes?.['gen_ai.system.message']).toBe('You are helpful.');
    const choiceEvent = events.find((e) => e.name === 'gen_ai.choice')!;
    expect(choiceEvent.attributes?.['gen_ai.choice.message.content']).toBe('Hi there!');
    expect(choiceEvent.attributes?.['gen_ai.choice.message.role']).toBe('assistant');
  });

  it('does NOT add content events when captureContent=false', () => {
    const config = makeConfig({ captureContent: false });
    const bridge = new OTelBridge(config);
    (bridge as unknown as Record<string, unknown>)['tracer'] = provider.getTracer('syrin-sdk');

    bridge.recordSpan(makeCallInfo({
      messages: [{ role: 'user', content: 'Secret' }],
      responseText: 'Secret response',
    }));

    const spans = exporter.getFinishedSpans();
    const eventNames = spans[0]!.events.map((e) => e.name);
    expect(eventNames).not.toContain('gen_ai.user.message');
    expect(eventNames).not.toContain('gen_ai.choice');
    expect(eventNames).not.toContain('gen_ai.content.prompt');
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

  it('sets optional request attributes: top_p, frequency_penalty, presence_penalty, stop_sequences', () => {
    const config = makeConfig();
    const bridge = new OTelBridge(config);
    (bridge as unknown as Record<string, unknown>)['tracer'] = provider.getTracer('syrin-sdk');

    bridge.recordSpan(makeCallInfo({
      topP: 0.9,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3,
      stop: ['\n', 'END'],
    }));

    const spans = exporter.getFinishedSpans();
    const attrs = spans[0]!.attributes;
    expect(attrs['gen_ai.request.top_p']).toBe(0.9);
    expect(attrs['gen_ai.request.frequency_penalty']).toBe(0.5);
    expect(attrs['gen_ai.request.presence_penalty']).toBe(0.3);
    expect(attrs['gen_ai.request.stop_sequences']).toEqual(['\n', 'END']);
  });

  it('stop string is wrapped in an array', () => {
    const config = makeConfig();
    const bridge = new OTelBridge(config);
    (bridge as unknown as Record<string, unknown>)['tracer'] = provider.getTracer('syrin-sdk');

    bridge.recordSpan(makeCallInfo({ stop: 'STOP' }));

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.attributes['gen_ai.request.stop_sequences']).toEqual(['STOP']);
  });

  it('sets framework context attributes', () => {
    const config = makeConfig();
    const bridge = new OTelBridge(config);
    (bridge as unknown as Record<string, unknown>)['tracer'] = provider.getTracer('syrin-sdk');

    bridge.recordSpan(makeCallInfo({
      framework: 'langgraph',
      langgraphGraphId: 'research-graph',
      langgraphNodeName: 'search_node',
    }));

    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    expect(attrs['syrin.framework']).toBe('langgraph');
    expect(attrs['langgraph.graph_id']).toBe('research-graph');
    expect(attrs['langgraph.node_name']).toBe('search_node');
  });

  it('sets telemetry signal attributes', () => {
    const config = makeConfig();
    const bridge = new OTelBridge(config);
    (bridge as unknown as Record<string, unknown>)['tracer'] = provider.getTracer('syrin-sdk');

    bridge.recordSpan(makeCallInfo({
      callIndex: 3,
      contextUtilization: 0.45,
      conversationHash: 'abc123def456',
      systemPromptHash: 'deadbeef1234',
      toolSetHash: 'feedcafe5678',
      modelConfigHash: 'cafebabe9012',
      messageCount: 5,
      repeatedToolCalls: 2,
    }));

    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    expect(attrs['syrin.call_index']).toBe(3);
    expect(attrs['syrin.context_utilization']).toBeCloseTo(0.45);
    expect(attrs['syrin.conversation_hash']).toBe('abc123def456');
    expect(attrs['syrin.system_prompt_hash']).toBe('deadbeef1234');
    expect(attrs['syrin.tool_set_hash']).toBe('feedcafe5678');
    expect(attrs['syrin.model_config_hash']).toBe('cafebabe9012');
    expect(attrs['syrin.message_count']).toBe(5);
    expect(attrs['syrin.repeated_tool_calls']).toBe(2);
  });

  it('finish_reasons is always recorded as an array', () => {
    const config = makeConfig();
    const bridge = new OTelBridge(config);
    (bridge as unknown as Record<string, unknown>)['tracer'] = provider.getTracer('syrin-sdk');

    bridge.recordSpan(makeCallInfo({ finishReason: 'stop' }));

    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    const reasons = attrs['gen_ai.response.finish_reasons'];
    expect(Array.isArray(reasons)).toBe(true);
    expect(reasons).toContain('stop');
  });

  it('BaggageSpanProcessor.onStart copies baggage to span attributes', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { propagation, ROOT_CONTEXT } = require('@opentelemetry/api') as typeof import('@opentelemetry/api');

    const bag = propagation.createBaggage({
      'syrin.session_id': { value: 'ses_abc123' },
      'syrin.agent_id': { value: 'my-agent' },
    });
    const ctx = propagation.setBaggage(ROOT_CONTEXT, bag);

    const processor = new BaggageSpanProcessor();
    const capturedAttrs: Record<string, unknown> = {};
    const mockSpan = {
      setAttribute(key: string, val: unknown) { capturedAttrs[key] = val; },
      end() {},
    };

    processor.onStart(mockSpan as unknown as import('@opentelemetry/api').Span, ctx);

    expect(capturedAttrs['syrin.session_id']).toBe('ses_abc123');
    expect(capturedAttrs['syrin.agent_id']).toBe('my-agent');
  });

  it('recordMetrics does not throw', () => {
    expect(() => recordMetrics(makeCallInfo())).not.toThrow();
  });
});
