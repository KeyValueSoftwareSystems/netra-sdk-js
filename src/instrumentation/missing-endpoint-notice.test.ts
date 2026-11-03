import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENDPOINT_ENV_VARS = ["NETRA_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT", "NETRA_API_KEY", "NETRA_DEBUG"];
// Nothing is exported in these tests, so this endpoint is never dialled.
const UNUSED_LOCAL_ENDPOINT = "http://127.0.0.1:9/telemetry";

/** Run the real initInstrumentations once, in a fresh module graph, with debug mode off. */
async function initWithEnv(env: Record<string, string>): Promise<{ lines: string[]; notice: string }> {
  for (const name of ENDPOINT_ENV_VARS) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  const { Config } = await import("../config");
  const { initInstrumentations, MISSING_ENDPOINT_NOTICE } = await import("./index");
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  initInstrumentations(new Config({ appName: "notice-test", debugMode: false }));

  const lines = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((args) => args.map(String).join(" "));
  return { lines, notice: MISSING_ENDPOINT_NOTICE };
}

describe("missing endpoint notice", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("is printed with debug mode off when no endpoint is configured", async () => {
    const { lines, notice } = await initWithEnv({});

    expect(lines.filter((line) => line === `[Netra] ${notice}`)).toHaveLength(1);
  });

  it("is not printed when NETRA_OTLP_ENDPOINT is set", async () => {
    const { lines } = await initWithEnv({ NETRA_OTLP_ENDPOINT: UNUSED_LOCAL_ENDPOINT, NETRA_API_KEY: "test-key" });

    expect(lines.filter((line) => line.includes("NETRA_OTLP_ENDPOINT is not set"))).toEqual([]);
  });
});
