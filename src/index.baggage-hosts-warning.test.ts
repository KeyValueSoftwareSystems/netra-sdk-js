import { afterEach, describe, expect, it, vi } from "vitest";

const httpInstrumented = vi.hoisted(() => ({ value: false }));

vi.mock("./instrumentation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./instrumentation")>();
  return {
    ...actual,
    initInstrumentations: vi.fn(() => undefined),
    isOutboundHttpInstrumented: () => httpInstrumented.value,
  };
});

import { Config } from "./config";
import { Netra } from "./index";

function hostsWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter((args: unknown[]) =>
    args.some((a) => typeof a === "string" && a.includes("NETRA_PROPAGATE_BAGGAGE_HOSTS")),
  );
}

describe("NETRA_PROPAGATE_BAGGAGE_HOSTS", () => {
  afterEach(async () => {
    await Netra.shutdown();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("parses hosts: trims, lowercases, strips dots and drops empty entries", () => {
    vi.stubEnv("NETRA_PROPAGATE_BAGGAGE_HOSTS", " Orders.Internal , .corp.net., ,API.example.com.");
    expect(new Config().propagateBaggageHosts).toEqual([
      "orders.internal",
      "corp.net",
      "api.example.com",
    ]);
  });

  it("is empty when unset", () => {
    vi.stubEnv("NETRA_PROPAGATE_BAGGAGE_HOSTS", "");
    expect(new Config().propagateBaggageHosts).toEqual([]);
  });

  it("warns at init when HTTP tracing is off", async () => {
    vi.stubEnv("NETRA_PROPAGATE_BAGGAGE_HOSTS", "corp.net");
    httpInstrumented.value = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await Netra.init({ appName: "test" });
    expect(hostsWarnings(warn)).toHaveLength(1);
  });

  it("does not warn when HTTP tracing is on", async () => {
    vi.stubEnv("NETRA_PROPAGATE_BAGGAGE_HOSTS", "corp.net");
    httpInstrumented.value = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await Netra.init({ appName: "test" });
    expect(hostsWarnings(warn)).toHaveLength(0);
  });
});
