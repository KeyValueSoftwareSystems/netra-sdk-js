/**
 * JS-SEC-018 / JS-MEM-005 regression tests.
 *
 * - SEC-018: concurrent decorated calls must keep their own workflow, agent
 *   and task names; entity scopes are per call, not a shared global stack.
 * - MEM-005: spans that never end must not stay reachable from module-level
 *   state (span registry, root-span map).
 */
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { agent, task, workflow } from "./decorators";
import { RootSpanProcessor } from "./processors/root-span-processor";
import { SessionSpanProcessor } from "./processors/session-span-processor";
import { runWithEntity, SessionManager } from "./session-manager";

const named = <T extends (...args: any[]) => any>(name: string, fn: T): T =>
  Object.defineProperty(fn, "name", { value: name });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("entity scopes", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SessionSpanProcessor(), new RootSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const spans = (re: RegExp) => exporter.getFinishedSpans().filter((s) => re.test(s.name));

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    trace.disable();
    context.disable();
    await provider.shutdown();
  });

  beforeEach(() => exporter.reset());

  it("SEC-018: concurrent requests keep their own workflow, agent and task names", async () => {
    const handle = (i: number) => {
      const step = task(named(`lookup-${i}`, async () => { await sleep((i * 13) % 25); return i; }));
      const ag = agent(named(`agent-${i}`, async () => { await sleep((i * 7) % 20); return step(); }));
      return workflow(named(`checkout-${i}`, async () => { await sleep((i * 5) % 15); return ag(); }))();
    };
    await Promise.all(Array.from({ length: 12 }, (_, i) => handle(i)));

    const lookups = spans(/^lookup-/);
    expect(lookups).toHaveLength(12);
    for (const s of lookups) {
      const i = s.name.split("-")[1];
      expect(s.attributes["netra.workflow.name"]).toBe(`checkout-${i}`);
      expect(s.attributes["netra.agent.name"]).toBe(`agent-${i}`);
      expect(s.attributes["netra.task.name"]).toBe(`lookup-${i}`);
    }
  });

  it("SEC-018: a decorated span carries its own entity name, and the caller's scope is untouched", async () => {
    await workflow(named("outer", async () => {
      await task(named("inner", async () => "ok"))();
      // After the nested task returns, its name is gone from this scope.
      expect(SessionManager.getCurrentEntityAttributes()["netra.task.name"]).toBeUndefined();
      expect(SessionManager.getCurrentEntityAttributes()["netra.workflow.name"]).toBe("outer");
    }))();
    expect(SessionManager.getCurrentEntityAttributes()).toEqual({});
    expect(spans(/^outer$/)[0].attributes["netra.workflow.name"]).toBe("outer");
    expect(spans(/^inner$/)[0].attributes["netra.workflow.name"]).toBe("outer");
  });

  it("SEC-018: a failing call does not leave its name behind for the next one", async () => {
    const boom = workflow(named("failing", async () => { throw new Error("x"); }));
    await expect(boom()).rejects.toThrow("x");
    await task(named("after-failure", async () => "ok"))();
    expect(spans(/^after-failure$/)[0].attributes["netra.workflow.name"]).toBeUndefined();
  });

  it("MEM-005: spans are only registered inside a scope and the scope keeps its own registry", () => {
    const tracer = provider.getTracer("t");
    const loose = tracer.startSpan("loose");
    SessionManager.registerSpan("loose", loose);
    expect(SessionManager.getSpanByName("loose")).toBeUndefined();
    loose.end();

    runWithEntity("workflow", "w", () => {
      const s = tracer.startSpan("scoped");
      SessionManager.registerSpan("scoped", s);
      expect(SessionManager.getSpanByName("scoped")).toBe(s);
      runWithEntity("task", "t", () => {
        expect(SessionManager.getSpanByName("scoped")).toBe(s);
        const child = tracer.startSpan("child");
        SessionManager.registerSpan("child", child);
        child.end();
      });
      // A nested scope's registrations do not leak into the parent scope.
      expect(SessionManager.getSpanByName("child")).toBeUndefined();
      SessionManager.unregisterSpan("scoped", s);
      expect(SessionManager.getSpanByName("scoped")).toBeUndefined();
      s.end();
    });
  });

  it("MEM-005: roots that never end are capped", () => {
    const rootSpans = (RootSpanProcessor as any)._rootSpans as Map<string, unknown>;
    const tracer = provider.getTracer("t");
    for (let i = 0; i < RootSpanProcessor.MAX_TRACKED_ROOTS + 50; i++) tracer.startSpan(`never-ended-${i}`);
    expect(rootSpans.size).toBeLessThanOrEqual(RootSpanProcessor.MAX_TRACKED_ROOTS);
    rootSpans.clear();
  });
});
