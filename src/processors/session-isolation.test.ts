/**
 * JS-SEC-001 / JS-SEC-002 / JS-SEC-003 / JS-MEM-001 regression tests.
 *
 * - SEC-001: inbound W3C baggage must not set the user, session or tenant a
 *   span is recorded under, nor block spans via `netra.local_blocked_spans`.
 * - SEC-002: identifiers set by the app must not be injected into outbound
 *   request headers.
 * - SEC-003: identifiers set in one request must not apply to a later,
 *   unrelated request that sets none.
 * - MEM-001: traces whose local root has a remote parent must be marked and
 *   must not leave per-trace state behind.
 */
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NetraLogger } from "../netraLogger";

import { getCurrentSessionId } from "../api/evaluation/utils";
import {
  configureBaggagePolicy,
  NetraBaggagePropagator,
} from "../utils/netra-baggage-propagator";
import { LlmTraceIdentifierSpanProcessor } from "./llm-trace-identifier-span-processor";
import {
  LocalFilteringSpanProcessor,
  withBlockedSpansLocal,
} from "./localfiltering-span-processor";
import { RootSpanProcessor } from "./root-span-processor";
import {
  clearSessionValues,
  contextWithSessionValues,
  SessionSpanProcessor,
  setSessionValue,
} from "./session-span-processor";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const FORGED_BAGGAGE =
  "user_id=ceo%40victim.com,tenant_id=victim-corp,session_id=forged," +
  `netra.local_blocked_spans=${encodeURIComponent('["*"]')},app.flag=keep`;

function Netra_withUser<T>(userId: string, fn: () => T): T {
  return context.with(contextWithSessionValues(context.active(), { user_id: userId }), fn);
}

function randomTraceparent(): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => "0123456789abcdef"[(Math.random() * 16) | 0]).join("");
  return `00-${hex(32)}-${hex(16)}-01`;
}

describe("session identity and baggage", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new LocalFilteringSpanProcessor(),
      new SessionSpanProcessor(),
      new LlmTraceIdentifierSpanProcessor(),
      new RootSpanProcessor(),
      new SimpleSpanProcessor(exporter),
    ],
  });
  const tracer = provider.getTracer("test");
  const spans = (name: string) => exporter.getFinishedSpans().filter((s) => s.name === name);

  /** Mirrors what HttpInstrumentation does for an inbound request. */
  function extractInbound(headers: Record<string, string>) {
    return propagation.extract(ROOT_CONTEXT, headers, defaultTextMapGetter);
  }

  function injectOutbound(): Record<string, string> {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier, defaultTextMapSetter);
    return carrier;
  }

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new NetraBaggagePropagator()],
      }),
    );
  });

  afterAll(async () => {
    propagation.disable();
    context.disable();
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
  });

  afterEach(() => {
    configureBaggagePolicy({});
  });

  it("SEC-001: ignores user, session and tenant sent in inbound baggage", () => {
    const inbound = extractInbound({ traceparent: TRACEPARENT, baggage: FORGED_BAGGAGE });
    context.with(inbound, () => tracer.startSpan("server").end());

    const [span] = spans("server");
    expect(span.attributes["netra.user_id"]).toBeUndefined();
    expect(span.attributes["netra.tenant_id"]).toBeUndefined();
    expect(span.attributes["netra.session_id"]).toBeUndefined();
  });

  it("SEC-001: a caller cannot block spans through netra.local_blocked_spans", () => {
    const inbound = extractInbound({ baggage: FORGED_BAGGAGE });
    expect(propagation.getBaggage(inbound)?.getEntry("netra.local_blocked_spans")).toBeUndefined();
    // Non-Netra baggage still passes through.
    expect(propagation.getBaggage(inbound)?.getEntry("app.flag")?.value).toBe("keep");

    // Even if the entry reached the context, the processor no longer reads baggage.
    const forced = propagation.setBaggage(
      ROOT_CONTEXT,
      propagation.createBaggage({ "netra.local_blocked_spans": { value: '["*"]' } }),
    );
    context.with(forced, () => tracer.startSpan("server").end());
    expect(spans("server")[0].attributes["netra.local_blocked"]).toBeUndefined();
  });

  it("withBlockedSpansLocal still blocks locally and is not sent downstream", () => {
    withBlockedSpansLocal(["blocked.*"], () => {
      tracer.startSpan("blocked.call").end();
      expect(injectOutbound().baggage).toBeUndefined();
    });
    expect(spans("blocked.call")[0].attributes["netra.local_blocked"]).toBe(true);
  });

  it("SEC-002: app-set identifiers are not injected into outbound headers", async () => {
    await context.with(ROOT_CONTEXT, async () => {
      expect(setSessionValue("user_id", "alice@example.com")).toBe(true);
      setSessionValue("tenant_id", "acme");
      await Promise.resolve();
      const headers = injectOutbound();
      expect(headers.baggage ?? "").not.toContain("alice");
      expect(headers.baggage ?? "").not.toContain("acme");
    });
  });

  it("SEC-002: inbound non-Netra baggage is still forwarded, Netra keys are not", () => {
    const inbound = extractInbound({ baggage: FORGED_BAGGAGE });
    const carrier: Record<string, string> = {};
    propagation.inject(inbound, carrier, defaultTextMapSetter);
    expect(carrier.baggage).toContain("app.flag=keep");
    expect(carrier.baggage).not.toContain("netra.");
  });

  it("SEC-003: identity set in one request does not reach a later unrelated request", async () => {
    const request = (fn: () => Promise<void>) => context.with(ROOT_CONTEXT, fn);

    await request(async () => {
      setSessionValue("user_id", "alice@example.com");
      await Promise.resolve();
      tracer.startSpan("login").end();
    });
    await request(async () => {
      tracer.startSpan("anonymous").end();
    });

    expect(spans("login")[0].attributes["netra.user_id"]).toBe("alice@example.com");
    expect(spans("anonymous")[0].attributes["netra.user_id"]).toBeUndefined();
  });

  it("SEC-003: concurrent requests keep their own identity", async () => {
    const request = (user: string) =>
      context.with(ROOT_CONTEXT, async () => {
        setSessionValue("user_id", user);
        await new Promise((r) => setTimeout(r, 5));
        tracer.startSpan(`req-${user}`).end();
      });
    await Promise.all([request("a"), request("b"), request("c")]);
    for (const user of ["a", "b", "c"]) {
      expect(spans(`req-${user}`)[0].attributes["netra.user_id"]).toBe(user);
    }
  });

  it("contextWithSessionValues scopes values and clearSessionValues removes them", async () => {
    const ctx = contextWithSessionValues(ROOT_CONTEXT, { user_id: "scoped", session_id: "s1" });
    context.with(ctx, () => tracer.startSpan("inside").end());
    tracer.startSpan("outside").end();
    expect(spans("inside")[0].attributes["netra.user_id"]).toBe("scoped");
    expect(spans("inside")[0].attributes["netra.session_id"]).toBe("s1");
    expect(spans("outside")[0].attributes["netra.user_id"]).toBeUndefined();

    await context.with(ROOT_CONTEXT, async () => {
      setSessionValue("user_id", "temp");
      clearSessionValues();
      tracer.startSpan("cleared").end();
    });
    expect(spans("cleared")[0].attributes["netra.user_id"]).toBeUndefined();
  });

  it("MEM-001: marks the local root of a remote-parented trace and leaves no state", () => {
    const rootSpans = (RootSpanProcessor as any)._rootSpans as Map<string, unknown>;
    const before = rootSpans.size;

    for (let i = 0; i < 200; i++) {
      const inbound = extractInbound({ traceparent: randomTraceparent() });
      const server = tracer.startSpan("server", {}, inbound);
      context.with(trace.setSpan(inbound, server), () => {
        const llm = tracer.startSpan("llm");
        llm.setAttribute("gen_ai.request.model", "gpt-x");
        llm.end();
      });
      server.end();
    }

    expect(rootSpans.size).toBe(before);
    const servers = spans("server");
    expect(servers).toHaveLength(200);
    expect(servers.every((s) => s.attributes["netra.trace.llm.call"] === true)).toBe(true);
  });

  it("MEM-001: an LLM span ending after its root does not leave state behind", () => {
    const rootSpans = (RootSpanProcessor as any)._rootSpans as Map<string, unknown>;
    const before = rootSpans.size;

    const root = tracer.startSpan("root");
    const llm = tracer.startSpan("late-llm", {}, trace.setSpan(ROOT_CONTEXT, root));
    root.end();
    llm.setAttribute("gen_ai.request.model", "gpt-x");
    llm.end();

    expect(rootSpans.size).toBe(before);
  });

  it("evaluation test runs link the session the app set, not one a caller sent", async () => {
    await context.with(ROOT_CONTEXT, async () => {
      setSessionValue("session_id", "s-1");
      await Promise.resolve();
      expect(getCurrentSessionId()).toBe("s-1");
    });
    const inbound = extractInbound({ baggage: "session_id=forged" });
    context.with(inbound, () => expect(getCurrentSessionId()).toBeUndefined());
  });

  it("two requests on the same upstream trace keep their own root span", async () => {
    const request = (name: string) => {
      const inbound = extractInbound({ traceparent: TRACEPARENT });
      const server = tracer.startSpan(`server-${name}`, {}, inbound);
      return context.with(trace.setSpan(inbound, server), async () => {
        await new Promise((r) => setTimeout(r, name === "a" ? 10 : 1));
        const child = tracer.startSpan(`child-${name}`);
        context.with(trace.setSpan(context.active(), child), () => {
          RootSpanProcessor.setAttributeOnRootSpan("netra.root.input", `input-${name}`);
          if (name === "b") {
            const llm = tracer.startSpan("llm-b");
            llm.setAttribute("gen_ai.request.model", "gpt-x");
            llm.end();
          }
        });
        child.end();
        server.end();
      });
    };
    await Promise.all([request("a"), request("b")]);

    const a = spans("server-a")[0];
    const b = spans("server-b")[0];
    expect(a.spanContext().traceId).toBe(b.spanContext().traceId);
    expect(a.attributes["netra.root.input"]).toBe("input-a");
    expect(b.attributes["netra.root.input"]).toBe("input-b");
    expect(b.attributes["netra.trace.llm.call"]).toBe(true);
    expect(a.attributes["netra.trace.llm.call"]).toBeUndefined();
    expect((RootSpanProcessor as any)._rootSpans.has(a.spanContext().traceId)).toBe(false);
  });

  it("setters outside a request scope reach the next job; withSession keeps jobs apart", async () => {
    const handle = async (job: { id: string; user?: string }) => {
      if (job.user) setSessionValue("user_id", job.user);
      await new Promise((r) => setTimeout(r, 1));
      tracer.startSpan(`job-${job.id}`).end();
    };
    const jobs = [{ id: "1", user: "alice" }, { id: "2" }];

    await context.with(ROOT_CONTEXT, () => Promise.all(jobs.map(handle)));
    expect(spans("job-1")[0].attributes["netra.user_id"]).toBe("alice");
    expect(spans("job-2")[0].attributes["netra.user_id"]).toBe("alice");

    exporter.reset();
    await context.with(ROOT_CONTEXT, () =>
      Promise.all(jobs.map((job) => context.with(contextWithSessionValues(context.active(), {}), () => handle(job)))),
    );
    expect(spans("job-1")[0].attributes["netra.user_id"]).toBe("alice");
    expect(spans("job-2")[0].attributes["netra.user_id"]).toBeUndefined();
  });

  describe("cross-service baggage policy", () => {
    const UPSTREAM_BAGGAGE =
      "session_id=s-up,user_id=u-up,tenant_id=t-up," +
      `netra.local_blocked_spans=${encodeURIComponent('["*"]')}`;

    function injectTo(url: string): Record<string, string> {
      const client = tracer.startSpan("GET", { attributes: { "url.full": url } });
      const carrier: Record<string, string> = {};
      propagation.inject(trace.setSpan(context.active(), client), carrier, defaultTextMapSetter);
      client.end();
      return carrier;
    }

    it("accepts a caller's session only with NETRA_TRUST_INBOUND_BAGGAGE", () => {
      context.with(extractInbound({ traceparent: TRACEPARENT, baggage: UPSTREAM_BAGGAGE }), () =>
        tracer.startSpan("untrusted").end(),
      );
      const untrusted = spans("untrusted")[0];
      expect(untrusted.attributes["netra.session_id"]).toBeUndefined();

      configureBaggagePolicy({ trustInbound: true });
      const inbound = extractInbound({ traceparent: TRACEPARENT, baggage: UPSTREAM_BAGGAGE });
      context.with(inbound, () => tracer.startSpan("trusted").end());
      const trusted = spans("trusted")[0];
      expect(trusted.attributes["netra.session_id"]).toBe("s-up");
      expect(trusted.attributes["netra.user_id"]).toBe("u-up");
      expect(trusted.attributes["netra.tenant_id"]).toBe("t-up");
      expect(trusted.attributes["netra.local_blocked"]).toBeUndefined();
      expect(propagation.getBaggage(inbound)?.getEntry("netra.local_blocked_spans")).toBeUndefined();
      context.with(inbound, () => {
        Netra_withUser("override", () => tracer.startSpan("override").end());
      });
      expect(spans("override")[0].attributes["netra.user_id"]).toBe("override");
    });

    it("does not forward a caller's session to other hosts", () => {
      const inbound = extractInbound({ baggage: `${UPSTREAM_BAGGAGE},app.flag=keep` });
      context.with(inbound, () => {
        expect(injectTo("https://api.openai.com/v1/chat").baggage).toBe("app.flag=keep");
      });
    });

    it("leaves the app's own baggage, including custom.* keys, untouched", () => {
      const inbound = extractInbound({ baggage: "custom_keys=plan,custom.plan=pro,app.flag=keep" });
      expect(propagation.getBaggage(inbound)?.getEntry("custom.plan")?.value).toBe("pro");
      context.with(inbound, () => {
        const headers = injectTo("https://api.openai.com/v1/chat");
        expect(headers.baggage).toContain("custom_keys=plan");
        expect(headers.baggage).toContain("custom.plan=pro");
        expect(headers.baggage).toContain("app.flag=keep");
      });
    });

    it("explains once why a caller's session was not used", () => {
      configureBaggagePolicy({});
      const notice = vi.spyOn(NetraLogger, "notice").mockImplementation(() => {});
      try {
        for (let i = 0; i < 5; i++) extractInbound({ baggage: UPSTREAM_BAGGAGE });
        extractInbound({ baggage: "app.flag=keep" });
        expect(notice).toHaveBeenCalledTimes(1);
        expect(String(notice.mock.calls[0][1])).toContain("NETRA_TRUST_INBOUND_BAGGAGE=true");
      } finally {
        notice.mockRestore();
      }
    });

    it("sends the session only to hosts in NETRA_PROPAGATE_BAGGAGE_HOSTS", async () => {
      configureBaggagePolicy({ propagateHosts: ["corp.net"] });
      await context.with(ROOT_CONTEXT, async () => {
        setSessionValue("session_id", "s-1");
        setSessionValue("user_id", "alice");
        await Promise.resolve();
        withBlockedSpansLocal(["x.*"], () => {
          const internal = injectTo("https://orders.corp.net/api");
          expect(internal.baggage).toContain("session_id=s-1");
          expect(internal.baggage).toContain("user_id=alice");
          expect(internal.baggage).not.toContain("netra.");
          expect(injectTo("https://corp.net./x").baggage).toContain("session_id=s-1");
          expect(injectTo("https://notcorp.net/x").baggage).toBeUndefined();
          expect(injectTo("https://api.openai.com/v1").baggage).toBeUndefined();
          expect(injectOutbound().baggage).toBeUndefined();
        });
      });
    });

    it("passes a trusted caller's session on to the next allowlisted service", () => {
      configureBaggagePolicy({ trustInbound: true, propagateHosts: ["corp.net"] });
      const inbound = extractInbound({ baggage: UPSTREAM_BAGGAGE });
      context.with(inbound, () => {
        const next = injectTo("https://billing.corp.net/");
        expect(next.baggage).toContain("session_id=s-up");
        expect(next.baggage).not.toContain("netra.");
        expect(injectTo("https://api.openai.com/").baggage).toBeUndefined();
      });
    });
  });

  describe("root span lookup when the parent is rebuilt from its IDs", () => {
    function childOfRebuiltParent(server: ReturnType<typeof tracer.startSpan>, name: string) {
      const rebuilt = trace.setSpanContext(ROOT_CONTEXT, server.spanContext());
      const child = tracer.startSpan(name, {}, rebuilt);
      context.with(trace.setSpan(rebuilt, child), () =>
        RootSpanProcessor.setAttributeOnRootSpan("netra.root.input", name),
      );
      child.end();
    }

    it("uses the trace's root when only one request is open on it", () => {
      const inbound = extractInbound({ traceparent: randomTraceparent() });
      const server = tracer.startSpan("solo-server", {}, inbound);
      childOfRebuiltParent(server, "solo-child");
      server.end();
      expect(spans("solo-server")[0].attributes["netra.root.input"]).toBe("solo-child");
    });

    it("finds no root when two requests are open on the same trace", () => {
      const traceparent = randomTraceparent();
      const a = tracer.startSpan("pair-a", {}, extractInbound({ traceparent }));
      const b = tracer.startSpan("pair-b", {}, extractInbound({ traceparent }));
      childOfRebuiltParent(a, "pair-child");
      a.end();
      b.end();
      expect(spans("pair-a")[0].attributes["netra.root.input"]).toBeUndefined();
      expect(spans("pair-b")[0].attributes["netra.root.input"]).toBeUndefined();
    });
  });
});
