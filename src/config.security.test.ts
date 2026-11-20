/**
 * JS-SEC-006 / JS-SEC-007 / JS-SEC-022 / JS-PERF-008 regression tests for
 * Config: where the API key is sent, what is written to the environment, and
 * startup with unusual OTEL_RESOURCE_ATTRIBUTES.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Config, isNetraHost } from "./config";
import { isTraceContentEnabled, setTraceContentEnabled } from "./instrumentation/utils";
import { NetraLogger } from "./netraLogger";

const KEY = "netra-key-TEST";
const ENV_KEYS = [
  "NETRA_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT", "NETRA_API_KEY", "NETRA_HEADERS",
  "TRACELOOP_API_KEY", "TRACELOOP_HEADERS", "TRACELOOP_BASE_URL", "TRACELOOP_TRACE_CONTENT",
  "OTEL_RESOURCE_ATTRIBUTES", "NETRA_TRACE_CONTENT",
];

describe("Config security", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    vi.spyOn(NetraLogger, "notice").mockImplementation(() => {});
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setTraceContentEnabled(undefined);
    vi.restoreAllMocks();
  });

  describe("SEC-006: the key only goes to Netra", () => {
    it("is not attached for a non-Netra OTEL_EXPORTER_OTLP_ENDPOINT", () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel-collector.vendor.example";
      process.env.NETRA_API_KEY = KEY;
      const cfg = new Config();
      expect(cfg.apiKey).toBeUndefined();
      expect(JSON.stringify(cfg.headers)).not.toContain(KEY);
      expect(vi.mocked(NetraLogger.notice).mock.calls.some(([, m]) => String(m).includes("NETRA_API_KEY is not sent"))).toBe(true);
    });

    it("is not attached when only the URL path contains 'getnetra'", () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://collector.example/getnetra/v1";
      process.env.NETRA_API_KEY = KEY;
      expect(JSON.stringify(new Config().headers)).not.toContain(KEY);
    });

    it("is attached as x-api-key for a Netra host, from either variable", () => {
      process.env.NETRA_API_KEY = KEY;
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://api.eu.getnetra.ai/telemetry";
      expect(new Config().headers["x-api-key"]).toBe(KEY);
      process.env.NETRA_OTLP_ENDPOINT = "https://api.getnetra.ai/telemetry";
      expect(new Config().headers["x-api-key"]).toBe(KEY);
    });

    it("keeps working for an explicit self-hosted NETRA_OTLP_ENDPOINT", () => {
      process.env.NETRA_OTLP_ENDPOINT = "https://netra.internal.example/telemetry";
      process.env.NETRA_API_KEY = KEY;
      const cfg = new Config();
      expect(cfg.apiKey).toBe(KEY);
      expect(cfg.headers.Authorization).toBe(`Bearer ${KEY}`);
    });

    it.each([
      ["https://api.getnetra.ai/telemetry", true],
      ["https://getnetra.ai", true],
      ["https://api.demo.getnetra.ai", true],
      ["https://getnetra.ai.evil.example", false],
      ["https://evilgetnetra.ai", false],
      ["https://collector.example/getnetra", false],
      ["not a url", false],
    ])("isNetraHost(%s) = %s", (url, expected) => {
      expect(isNetraHost(url)).toBe(expected);
    });
  });

  it("SEC-022: the app's headers object is not modified", () => {
    process.env.NETRA_OTLP_ENDPOINT = "https://api.getnetra.ai/telemetry";
    process.env.NETRA_API_KEY = KEY;
    const headers = { "x-team": "payments" };
    const cfg = new Config({ headers });
    expect(headers).toEqual({ "x-team": "payments" });
    expect(cfg.headers["x-api-key"]).toBe(KEY);
  });

  describe("SEC-007: nothing secret or shared is left in process.env", () => {
    it("does not copy the key, headers or endpoint into TRACELOOP_* variables", () => {
      process.env.NETRA_OTLP_ENDPOINT = "https://api.getnetra.ai/telemetry";
      process.env.NETRA_API_KEY = KEY;
      const restore = new Config({ headers: { Authorization: "Bearer app-token" } }).setTraceloopEnv();
      restore();
      for (const k of ["TRACELOOP_API_KEY", "TRACELOOP_HEADERS", "TRACELOOP_BASE_URL"]) {
        expect(process.env[k]).toBeUndefined();
      }
    });

    it("does not overwrite TRACELOOP_TRACE_CONTENT, and traceContent still applies in-process", () => {
      process.env.TRACELOOP_TRACE_CONTENT = "false";
      new Config({ traceContent: true });
      expect(process.env.TRACELOOP_TRACE_CONTENT).toBe("false");
      expect(isTraceContentEnabled()).toBe(true);
      new Config({ traceContent: false });
      expect(isTraceContentEnabled()).toBe(false);
    });

    it("sets OTEL_RESOURCE_ATTRIBUTES only until restored", () => {
      process.env.OTEL_RESOURCE_ATTRIBUTES = "team=payments";
      const restore = new Config({ appName: "svc", environment: "prod" }).setTraceloopEnv();
      expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toContain("service.name=svc");
      expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toContain("deployment.environment=prod");
      expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toContain("team=payments");
      restore();
      expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe("team=payments");

      delete process.env.OTEL_RESOURCE_ATTRIBUTES;
      new Config().setTraceloopEnv()();
      expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
    });
  });

  it("PERF-008: a % in OTEL_RESOURCE_ATTRIBUTES does not throw", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "team=R%D,note=50%,ok=a%20b";
    const restore = new Config().setTraceloopEnv();
    const value = process.env.OTEL_RESOURCE_ATTRIBUTES ?? "";
    expect(value).toContain(`team=${encodeURIComponent("R%D")}`);
    expect(value).toContain(`ok=${encodeURIComponent("a b")}`);
    restore();
  });
});
