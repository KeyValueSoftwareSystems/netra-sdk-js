/**
 * JS-PERF-002 / JS-MEM-006: a long chat history must not be rebuilt once per
 * message, and stored message fields are capped at the attribute size limit.
 */
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { writePromptAttributes } from "../instrumentation/utils";
import { SerializationSpanProcessor } from "./serialization-span-processor";
import { SpanIOProcessor } from "./span-io-processor";

describe("SpanIOProcessor with long histories", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SerializationSpanProcessor(), new SpanIOProcessor(true), new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("t");
  afterAll(() => provider.shutdown());
  beforeEach(() => exporter.reset());

  const history = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i} `.repeat(20) }));

  it("PERF-002: records a 1,000-message prompt without rebuilding it per message", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const span = tracer.startSpan("llm");
    const t0 = performance.now();
    writePromptAttributes(span, history(1000));
    span.end();
    const elapsed = performance.now() - t0;
    const calls = stringify.mock.calls.length;
    stringify.mockRestore();

    // One stringify by writePromptAttributes plus a handful in serialization,
    // not one rebuild of the whole history per message.
    expect(calls).toBeLessThan(50);
    expect(elapsed).toBeLessThan(1500);
    expect(String(exporter.getFinishedSpans()[0].attributes.input)).toContain("message 0");
  });

  it("builds input from prompt keys alone, even when the span ends synchronously", () => {
    const span = tracer.startSpan("traceloop-style");
    span.setAttribute("gen_ai.prompt.0.role", "user");
    span.setAttribute("gen_ai.prompt.0.content", "hello");
    span.setAttribute("gen_ai.completion.0.role", "assistant");
    span.setAttribute("gen_ai.completion.0.content", "hi");
    span.end();
    const attrs = exporter.getFinishedSpans()[0].attributes;
    expect(JSON.parse(String(attrs.input))).toEqual([{ role: "user", content: "hello" }]);
    expect(JSON.parse(String(attrs.output))).toEqual([{ role: "assistant", content: "hi" }]);
  });

  it("builds input from prompt keys on the next microtask for long-lived spans", async () => {
    const span = tracer.startSpan("async");
    span.setAttribute("gen_ai.prompt.0.role", "user");
    span.setAttribute("gen_ai.prompt.0.content", "later");
    await Promise.resolve();
    expect(String((span as any).attributes.input)).toContain("later");
    span.end();
  });

  it("MEM-006: an oversized message is cut to the attribute limit", () => {
    const span = tracer.startSpan("big");
    span.setAttribute("gen_ai.prompt.0.role", "user");
    span.setAttribute("gen_ai.prompt.0.content", "x".repeat(200_000));
    span.end();
    expect(String(exporter.getFinishedSpans()[0].attributes.input).length).toBeLessThanOrEqual(30_100);
  });
});
