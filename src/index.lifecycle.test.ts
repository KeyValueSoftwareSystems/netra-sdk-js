/**
 * JS-SEC-011 / JS-MEM-008: importing the SDK registers nothing global, and a
 * re-init replaces Netra's span processors instead of adding another set.
 */
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { propagation, trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Netra } from "./index";
import { NetraLogger } from "./netraLogger";

const processors = () =>
  ((trace.getTracerProvider() as any).getDelegate()._activeSpanProcessor._spanProcessors as any[]);
const netraCount = () =>
  processors().filter((p) => /SpanIOProcessor|SessionSpanProcessor|LocalFilteringSpanProcessor|RootSpanProcessor/.test(p.constructor.name)).length;

describe("SDK lifecycle", () => {
  let server: http.Server;
  beforeAll(async () => {
    vi.spyOn(NetraLogger, "notice").mockImplementation(() => {});
    server = http.createServer((req, res) => { req.resume(); req.on("end", () => res.end("{}")); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.NETRA_OTLP_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.NETRA_API_KEY = "k";
  });
  afterAll(async () => {
    await Netra.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    vi.restoreAllMocks();
  }, 30_000);

  it("SEC-011: importing the SDK does not register a global propagator", () => {
    expect(propagation.fields()).toEqual([]);
  });

  it("registers Netra's propagator at init", { timeout: 60_000 }, async () => {
    await Netra.init({ appName: "lifecycle", disableBatch: true, registerShutdownHooks: false });
    expect(propagation.fields()).toEqual(expect.arrayContaining(["traceparent", "baggage"]));
  });

  it("MEM-008: re-initializing does not add another set of processors", { timeout: 60_000 }, async () => {
    const first = netraCount();
    const total = processors().length;
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      await Netra.shutdown();
      await Netra.init({ appName: "lifecycle", disableBatch: true, registerShutdownHooks: false });
    }
    expect(netraCount()).toBe(first);
    expect(processors().length).toBe(total);
  });
});
