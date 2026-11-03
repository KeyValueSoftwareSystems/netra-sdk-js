import * as http from "http";
import { AddressInfo } from "net";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrialAwareOTLPExporter } from "./exporters/trialAwareOtlpExporter";
import { setTrialBlocked } from "./exporters/utils";
import { NetraLogger } from "./netraLogger";

vi.mock("./instrumentation", () => ({
  initInstrumentations: vi.fn(() => ({})),
  instrumentationsReady: Promise.resolve(),
  uninstrumentAll: vi.fn(() => Promise.resolve()),
}));

import { Netra } from "./index";

type ConsoleMethod = "debug" | "info" | "warn" | "error" | "log";
const CONSOLE_METHODS: ConsoleMethod[] = ["debug", "info", "warn", "error", "log"];

// ProtobufTraceSerializer accepts an empty batch; spans' content is irrelevant to these tests.
const NO_SPANS: ReadableSpan[] = [];

function exportOnce(exporter: TrialAwareOTLPExporter): Promise<ExportResult> {
  return new Promise((resolve) => exporter.export(NO_SPANS, resolve));
}

/** Local HTTP server answering each request with the next [status, body] pair. */
async function startServer(replies: Array<[number, string]>): Promise<{ url: string; close: () => Promise<void> }> {
  const pending = [...replies];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const [status, body] = pending.shift() ?? [500, "no reply configured"];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/telemetry/v1/traces`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("NetraLogger", () => {
  let spies: Record<ConsoleMethod, ReturnType<typeof vi.spyOn>>;

  /** Every console line written, as "<method>: <joined args>". */
  function written(): string[] {
    return CONSOLE_METHODS.flatMap((method) =>
      spies[method].mock.calls.map((args: unknown[]) => `${method}: ${args.map(String).join(" ")}`),
    );
  }

  beforeEach(() => {
    vi.stubEnv("NETRA_DEBUG", "");
    NetraLogger.setDebugMode(false);
    spies = Object.fromEntries(
      CONSOLE_METHODS.map((method) => [method, vi.spyOn(console, method).mockImplementation(() => undefined)]),
    ) as Record<ConsoleMethod, ReturnType<typeof vi.spyOn>>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    NetraLogger.setDebugMode(false);
    setTrialBlocked(false);
  });

  describe("level methods", () => {
    function logOneOfEach(): void {
      NetraLogger.debug("debug line");
      NetraLogger.info("info line");
      NetraLogger.warn("warn line");
      NetraLogger.error("error line");
      NetraLogger.log("log line");
    }

    it("are all silent with debug mode off, error included", () => {
      logOneOfEach();

      expect(written()).toEqual([]);
    });

    it("all print with debug mode on, each through its own console method", () => {
      NetraLogger.setDebugMode(true);

      logOneOfEach();

      expect(written()).toEqual([
        "debug: [Netra] debug line",
        "info: [Netra] info line",
        "warn: [Netra] warn line",
        "error: [Netra] error line",
        "log: [Netra] log line",
      ]);
    });

    it.each(["1", "true", "TRUE"])("all print when NETRA_DEBUG=%s even if debug mode was not set", (value) => {
      vi.stubEnv("NETRA_DEBUG", value);

      NetraLogger.error("error line");

      expect(written()).toEqual(["error: [Netra] error line"]);
      expect(NetraLogger.isDebugMode()).toBe(true);
    });

    it.each(["0", "false", "yes"])("stay silent when NETRA_DEBUG=%s", (value) => {
      vi.stubEnv("NETRA_DEBUG", value);

      NetraLogger.error("error line");

      expect(written()).toEqual([]);
      expect(NetraLogger.isDebugMode()).toBe(false);
    });
  });

  describe("notice", () => {
    it("prints warn-level notices through console.warn with debug mode off", () => {
      NetraLogger.notice("warn", "something to fix", 42);

      expect(written()).toEqual(["warn: [Netra] something to fix 42"]);
    });

    it("prints error-level notices through console.error with debug mode off", () => {
      NetraLogger.notice("error", "call failed:", "401");

      expect(written()).toEqual(["error: [Netra] call failed: 401"]);
    });

    it("prints with debug mode on too", () => {
      NetraLogger.setDebugMode(true);

      NetraLogger.notice("warn", "something to fix");

      expect(written()).toEqual(["warn: [Netra] something to fix"]);
    });

    it("prints every repeat", () => {
      for (let i = 0; i < 3; i++) NetraLogger.notice("warn", "same problem");

      expect(written()).toEqual(Array(3).fill("warn: [Netra] same problem"));
    });

    it("passes non-string arguments through untouched", () => {
      const cause = new Error("boom");

      NetraLogger.notice("error", "failed:", cause);

      expect(spies.error.mock.calls).toEqual([["[Netra]", "failed:", cause]]);
    });
  });

  describe("span export failures with debug mode off", () => {
    it("every rejected batch is printed", async () => {
      const badKey = JSON.stringify({ error: { message: "Invalid API key" } });
      const server = await startServer([
        [401, badKey],
        [401, badKey],
        [413, JSON.stringify({ error: { message: "Request body too large" } })],
      ]);
      const exporter = new TrialAwareOTLPExporter({ url: server.url });

      try {
        const results = [await exportOnce(exporter), await exportOnce(exporter), await exportOnce(exporter)];
        expect(results.map((r) => r.code)).toEqual([
          ExportResultCode.FAILED,
          ExportResultCode.FAILED,
          ExportResultCode.FAILED,
        ]);
      } finally {
        await server.close();
      }

      const lines = written();
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^warn: \[Netra\] Span export failed with HTTP 401 Unauthorized: "Invalid API key"\. Dropped a batch of 0 spans/);
      expect(lines[1]).toBe(lines[0]);
      expect(lines[2]).toMatch(/^warn: \[Netra\] Span export failed with HTTP 413 Payload Too Large: "Request body too large"\./);
      expect(lines[2]).toContain("Lower OTEL_BSP_MAX_EXPORT_BATCH_SIZE");
    });

    it("every export to an unreachable endpoint is printed", async () => {
      const server = await startServer([]);
      const closedUrl = server.url;
      await server.close(); // nothing listens on this port any more: ECONNREFUSED
      const exporter = new TrialAwareOTLPExporter({ url: closedUrl });

      await exportOnce(exporter);
      await exportOnce(exporter);

      const lines = written();
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).toMatch(/^warn: \[Netra\] Span export failed: connect ECONNREFUSED .*Dropped a batch of 0 spans/);
      }
    });
  });

  describe("public API misuse with debug mode off", () => {
    it.each([
      ["setSessionId('')", () => Netra.setSessionId(""), "warn", "setSessionId: Session ID must be provided"],
      ["setUserId('')", () => Netra.setUserId(""), "warn", "setUserId: User ID must be provided"],
      ["setTenantId('')", () => Netra.setTenantId(""), "warn", "setTenantId: Tenant ID must be provided"],
      [
        "setSessionId(123)",
        () => Netra.setSessionId(123 as unknown as string),
        "error",
        "setSessionId: sessionId must be a string, got number",
      ],
      [
        "setCustomAttributes('', undefined)",
        () => Netra.setCustomAttributes("", undefined),
        "warn",
        "Both key and value must be provided",
      ],
    ])("%s is printed", (_name, call, method, expectedText) => {
      call();

      const lines = written();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${method}: [Netra] `);
      expect(lines[0]).toContain(expectedText);
    });
  });
});
