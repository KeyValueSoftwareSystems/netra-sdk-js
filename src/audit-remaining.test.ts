/**
 * Regression tests for the remaining Nov 2026 audit items: SEC-009, SEC-010,
 * SEC-021, SEC-023, SEC-024, MEM-007, MEM-009, PERF-005, PERF-011, PERF-012,
 * PERF-015.
 */
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Config } from "./config";
import { workflow } from "./decorators";
import { sanitizeForLog } from "./exporters/trialAwareOtlpExporter";
import { isValidChoiceIndex, MAX_STREAM_CHOICES, setRequestAttributes } from "./instrumentation/utils";
import { isSensitiveKey, ScrubbingSpanProcessor } from "./processors/scrubbing-span-processor";
import { safeStringify } from "./utils/serialization";
import { Prompts } from "./api/prompts";
import { Dashboard } from "./api/dashboard";

const named = <T extends (...args: any[]) => any>(name: string, fn: T): T =>
  Object.defineProperty(fn, "name", { value: name });

describe("safeStringify (MEM-007, PERF-012)", () => {
  it("summarizes Buffers and typed arrays instead of expanding every byte", () => {
    const buf = Buffer.alloc(1024 * 1024, 7);
    expect(safeStringify(buf)).toBe("[Buffer 1048576 bytes]");
    expect(safeStringify({ file: buf, bytes: new Uint8Array(10) })).toBe(
      JSON.stringify({ file: "[Buffer 1048576 bytes]", bytes: "[Uint8Array 10 bytes]" }),
    );
  });

  it("never expands a nested Buffer through toJSON()", () => {
    const toJSON = vi.spyOn(Buffer.prototype, "toJSON");
    const out = safeStringify([Buffer.alloc(4 * 1024 * 1024), { nested: { file: Buffer.alloc(10) } }]);
    expect(toJSON).not.toHaveBeenCalled();
    toJSON.mockRestore();
    expect(out).toBe(JSON.stringify(["[Buffer 4194304 bytes]", { nested: { file: "[Buffer 10 bytes]" } }]));
  });

  it("stops walking once the budget is used", () => {
    const big = Array.from({ length: 50_000 }, (_, i) => ({ i, text: "x".repeat(50) }));
    const t0 = performance.now();
    const out = safeStringify(big, { maxLength: 2000 });
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("still serializes ordinary values exactly", () => {
    const value = { a: 1, b: "two", c: [true, null], d: { e: 1.5 } };
    expect(safeStringify(value)).toBe(JSON.stringify(value));
    expect(safeStringify(value, { maxLength: 1000 })).toBe(JSON.stringify(value));
  });
});

describe("decorators and thenables (SEC-010)", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(provider);
  });
  afterAll(async () => {
    trace.disable();
    context.disable();
    await provider.shutdown();
  });

  it("returns a lazy query builder untouched and does not run it", async () => {
    let executed = 0;
    const builder = {
      where() { return this; },
      then(resolve: (v: unknown) => void) { executed++; resolve([{ id: 1 }]); },
    };
    const findUsers = workflow(named("find-users", () => builder));
    const result = findUsers();
    expect(result).toBe(builder);
    expect(typeof (result as any).where).toBe("function");
    expect(executed).toBe(0);
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain("find-users");
    // The app decides when it runs.
    await result;
    expect(executed).toBe(1);
  });

  it("still awaits real promises", async () => {
    const add = workflow(named("add", async (a: number, b: number) => a + b));
    await expect(add(1, 2)).resolves.toBe(3);
  });
});

describe("scrubbing (SEC-009, SEC-021)", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new ScrubbingSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("t");
  afterAll(() => provider.shutdown());
  beforeEach(() => exporter.reset());

  it("SEC-009: a crafted message does not freeze the app", () => {
    const span = tracer.startSpan("redos");
    const t0 = performance.now();
    span.setAttribute("input", "a.".repeat(20_000) + "1-".repeat(20_000));
    span.end();
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("SEC-009: still scrubs emails", () => {
    const span = tracer.startSpan("email");
    span.setAttribute("input", "contact first.last+x@sub.example.co.uk today");
    span.end();
    expect(exporter.getFinishedSpans()[0].attributes.input).toBe("contact [SCRUBBED] today");
  });

  it("SEC-021: scrubs start attributes, events, exceptions, status and name", () => {
    const span = tracer.startSpan("charge sk-ABCDEFGHIJKLMNOPQRST", {
      attributes: { note: "card 4111111111111111", password: "hunter2" },
    });
    span.addEvent("retry", { detail: "mail alice@example.com" });
    span.recordException(new Error("token: SECRETVALUE leaked"));
    span.setStatus({ code: 2, message: "user bob@example.com failed" });
    span.end();
    const finished = exporter.getFinishedSpans()[0];
    const all = JSON.stringify({ name: finished.name, attributes: finished.attributes, events: finished.events, status: finished.status });
    expect(all).not.toMatch(/4111111111111111|hunter2|alice@example\.com|SECRETVALUE|bob@example\.com|sk-ABCDEFGHIJ/);
  });

  it("SEC-021: matches sensitive key names by whole parts", () => {
    for (const key of ["password", "db.password", "x-api-key", "api_key", "http.request.header.authorization", "access_token", "set-cookie"]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ["netra.span.type", "gen_ai.request.max_tokens", "monkey", "keyword", "author"]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe("export log hygiene (SEC-024)", () => {
  it("escapes control characters and caps length", () => {
    const out = sanitizeForLog("ok\n[Netra] forged\u001b[31m" + "x".repeat(500));
    expect(out).not.toMatch(/[\n\u001b]/);
    expect(out.length).toBeLessThan(260);
  });
});

describe("streamed choice indexes (MEM-009)", () => {
  it("rejects huge or invalid indexes", () => {
    expect(isValidChoiceIndex(0)).toBe(true);
    expect(isValidChoiceIndex(MAX_STREAM_CHOICES - 1)).toBe(true);
    expect(isValidChoiceIndex(1e9)).toBe(false);
    expect(isValidChoiceIndex(-1)).toBe(false);
    expect(isValidChoiceIndex(Number.NaN)).toBe(false);
  });
});

describe("request attributes never throw (PERF-005)", () => {
  it("survives unserializable reasoning config", () => {
    const circular: any = { effort: "high" };
    circular.self = circular;
    const span: any = { isRecording: () => true, setAttribute: vi.fn() };
    expect(() => setRequestAttributes(span, { model: "m", reasoning: circular, tools: [circular] }, "chat", "groq")).not.toThrow();
  });
});

describe("prompt cache (SEC-023, PERF-015)", () => {
  function promptsWithFakeClient(fetcher: (name: string, label: string) => Promise<any>) {
    const prompts = new Prompts(new Config());
    (prompts as any).client = { getPromptVersion: fetcher };
    return prompts;
  }

  it("SEC-023: names and labels containing ':' do not collide", async () => {
    const prompts = promptsWithFakeClient(async (name, label) => ({ data: { name, label } }));
    const a = await prompts.getPrompt({ name: "a:b", label: "c", useCache: true });
    const b = await prompts.getPrompt({ name: "a", label: "b:c", useCache: true });
    expect(a).toMatchObject({ name: "a:b", label: "c" });
    expect(b).toMatchObject({ name: "a", label: "b:c" });
  });

  it("PERF-015: concurrent cache misses share one request and get separate copies", async () => {
    let calls = 0;
    const prompts = promptsWithFakeClient(async (name) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { data: { name, messages: [] as string[] } };
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => prompts.getPrompt({ name: "p", useCache: true })));
    expect(calls).toBe(1);
    (results[0] as any).messages.push("mutated");
    expect((results[1] as any).messages).toEqual([]);
  });
});

describe("session stats paging (PERF-011)", () => {
  it("stops when a page claims more without a new cursor", async () => {
    const dashboard = new Dashboard(new Config());
    let pages = 0;
    (dashboard as any).getSessionStats = async () => {
      pages++;
      if (pages > 5) throw new Error("looped");
      return { data: [{ id: pages }], hasNextPage: true, nextCursor: undefined };
    };
    const seen: unknown[] = [];
    for await (const s of dashboard.iterSessionStats("2026-01-01", "2026-01-02")) seen.push(s);
    expect(pages).toBe(1);
    expect(seen).toHaveLength(1);
  });
});
