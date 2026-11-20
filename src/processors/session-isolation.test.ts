/**
 * JS-SEC-001 / JS-SEC-002 / JS-SEC-003 regression tests.
 *
 * - SEC-001: inbound W3C baggage must not set the user, session or tenant a
 *   span is recorded under, nor block spans via `netra.local_blocked_spans`.
 * - SEC-002: identifiers set by the app must not be injected into outbound
 *   request headers.
 * - SEC-003: identifiers set in one request must not apply to a later,
 *   unrelated request that sets none.
 */
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NetraBaggagePropagator } from "../utils/netra-baggage-propagator";
import {
  LocalFilteringSpanProcessor,
  withBlockedSpansLocal,
} from "./localfiltering-span-processor";
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

describe("session identity and baggage", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new LocalFilteringSpanProcessor(),
      new SessionSpanProcessor(),
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
});
