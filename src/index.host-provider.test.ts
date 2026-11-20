/**
 * JS-SEC-011: when the app registered its own TracerProvider first, Netra
 * warns and leaves that provider's processors alone.
 */
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it, vi } from "vitest";

import { Netra } from "./index";
import { NetraLogger } from "./netraLogger";

describe("an app-owned TracerProvider", () => {
  afterAll(async () => {
    await Netra.shutdown();
    trace.disable();
    vi.restoreAllMocks();
  }, 30_000);

  it("is not modified by Netra.init()", { timeout: 60_000 }, async () => {
    const notice = vi.spyOn(NetraLogger, "notice").mockImplementation(() => {});
    const exporter = new InMemorySpanExporter();
    const hostProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(hostProvider);
    const before = [...(hostProvider as any)._activeSpanProcessor._spanProcessors];

    await Netra.init({ appName: "host", disableBatch: true, registerShutdownHooks: false });

    expect((hostProvider as any)._activeSpanProcessor._spanProcessors).toEqual(before);
    expect(notice.mock.calls.some(([, m]) => String(m).includes("Another OpenTelemetry TracerProvider"))).toBe(true);

    // The app's own spans keep their attributes untouched.
    const span = trace.getTracer("app").startSpan("app-span");
    span.end();
    expect(Object.keys(exporter.getFinishedSpans()[0].attributes)).not.toContain("netra.span.type");
  });
});
