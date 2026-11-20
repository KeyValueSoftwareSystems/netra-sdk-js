/**
 * JS-MEM-002 / JS-PERF-003 / JS-PERF-006 / JS-MEM-004 regression tests for
 * the OTLP exporter: bounded time per batch, retries for transient failures,
 * bounded concurrency, and quota detection that ignores plain rate limits.
 */
import * as http from "node:http";
import { AddressInfo, Socket } from "node:net";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NetraLogger } from "../netraLogger";
import { isQuotaExceededResponse, TrialAwareOTLPExporter } from "./trialAwareOtlpExporter";
import {
  addBlockedTraceId,
  blockedTraceIdCount,
  clearBlockedTraceIds,
  isTraceIdBlocked,
  isTrialBlocked,
  setTrialBlocked,
} from "./utils";

const NO_SPANS: ReadableSpan[] = [];
const exportOnce = (e: TrialAwareOTLPExporter) =>
  new Promise<ExportResult>((resolve) => e.export(NO_SPANS, resolve));

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void;

async function startServer(handler: Handler) {
  let n = 0;
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => handler(req, res, ++n));
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
    requests: () => n,
    openSockets: () => sockets.size,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

describe("TrialAwareOTLPExporter", () => {
  beforeEach(() => {
    vi.spyOn(NetraLogger, "notice").mockImplementation(() => {});
    setTrialBlocked(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setTrialBlocked(false);
    clearBlockedTraceIds();
  });

  it("PERF-003/MEM-002: a hung endpoint fails the batch at the deadline and leaves no open socket", async () => {
    const server = await startServer(() => { /* never answers */ });
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 400 });
    const t0 = Date.now();
    const result = await exportOnce(exporter);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(Date.now() - t0).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.openSockets()).toBe(0);
    await server.close();
  });

  it("PERF-006: retries 503 and succeeds", async () => {
    const server = await startServer((_q, res, n) => (n < 3 ? json(res, 503, { error: { message: "busy" } }, { "retry-after": "0" }) : json(res, 200, {})));
    vi.spyOn(Math, "random").mockReturnValue(0); // shortest backoff
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 8000 });
    const result = await exportOnce(exporter);
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(server.requests()).toBe(3);
    await server.close();
  }, 10_000);

  it("PERF-006: retries a reset connection", async () => {
    const server = await startServer((req, res, n) => (n === 1 ? req.socket.destroy() : json(res, 200, {})));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 5000 });
    expect((await exportOnce(exporter)).code).toBe(ExportResultCode.SUCCESS);
    expect(server.requests()).toBe(2);
    await server.close();
  });

  it("does not retry a rejected batch (4xx other than 408/429)", async () => {
    const server = await startServer((_q, res) => json(res, 401, { error: { message: "bad key" } }));
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 5000 });
    expect((await exportOnce(exporter)).code).toBe(ExportResultCode.FAILED);
    expect(server.requests()).toBe(1);
    await server.close();
  });

  it("gives up when Retry-After is past the deadline", async () => {
    const server = await startServer((_q, res) => json(res, 503, {}, { "retry-after": "120" }));
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 2000 });
    const t0 = Date.now();
    expect((await exportOnce(exporter)).code).toBe(ExportResultCode.FAILED);
    expect(server.requests()).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1500);
    await server.close();
  });

  it("MEM-004: a plain 429 rate limit is retried and does not start a quota block", async () => {
    const server = await startServer((_q, res, n) => (n === 1 ? json(res, 429, { error: { code: 429, message: "Too Many Requests" } }, { "retry-after": "0" }) : json(res, 200, {})));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 5000 });
    expect((await exportOnce(exporter)).code).toBe(ExportResultCode.SUCCESS);
    expect(isTrialBlocked()).toBe(false);
    await server.close();
  });

  it("MEM-004: the backend's QUOTA_EXCEEDED response starts a block and is not retried", async () => {
    const body = { error: { code: 429, error: "QuotaExceededException", message: "TRACE usage quota exceeded for your current plan.", errorCode: "QUOTA_EXCEEDED" } };
    const server = await startServer((_q, res) => json(res, 429, body));
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 5000 });
    expect((await exportOnce(exporter)).code).toBe(ExportResultCode.FAILED);
    expect(server.requests()).toBe(1);
    expect(isTrialBlocked()).toBe(true);
    await server.close();
  });

  it("recognises every quota response shape", () => {
    expect(isQuotaExceededResponse(JSON.stringify({ error: { errorCode: "QUOTA_EXCEEDED" } }))).toBe(true);
    expect(isQuotaExceededResponse(JSON.stringify({ error: { error: { code: "QUOTA_EXCEEDED" } } }))).toBe(true);
    expect(isQuotaExceededResponse(JSON.stringify({ error: { message: "usage quota exceeded" } }))).toBe(true);
    expect(isQuotaExceededResponse(JSON.stringify({ error: { code: 429, message: "slow down" } }))).toBe(false);
    expect(isQuotaExceededResponse("not json")).toBe(false);
  });

  it("MEM-002: queues a burst beyond the concurrency limit instead of dropping it", async () => {
    let active = 0;
    let peak = 0;
    const server = await startServer((_q, res) => {
      active++; peak = Math.max(peak, active);
      setTimeout(() => { active--; json(res, 200, {}); }, 30);
    });
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 5000, maxConcurrentExports: 4 });
    const results = await Promise.all(Array.from({ length: 25 }, () => exportOnce(exporter)));
    expect(results.every((r) => r.code === ExportResultCode.SUCCESS)).toBe(true);
    expect(peak).toBeLessThanOrEqual(4);
    await server.close();
  });

  it("MEM-002: drops batches only when the bounded queue is full", async () => {
    const server = await startServer(() => { /* never answers */ });
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 600, maxConcurrentExports: 1, maxQueuedExports: 2 });
    const accepted = [exportOnce(exporter), exportOnce(exporter), exportOnce(exporter)];
    const overflow = await exportOnce(exporter);
    expect(overflow.code).toBe(ExportResultCode.FAILED);
    expect(overflow.error?.message).toMatch(/in flight/);
    const t0 = Date.now();
    await Promise.all(accepted);
    // Queued batches share the deadline set when they were accepted.
    expect(Date.now() - t0).toBeLessThan(1500);
    await server.close();
  });

  it("MEM-002: reads at most 64 KiB of an error body", async () => {
    const huge = "x".repeat(2 * 1024 * 1024);
    const server = await startServer((_q, res) => { res.writeHead(400); res.end(huge); });
    const notice = vi.mocked(NetraLogger.notice);
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 3000 });
    expect((await exportOnce(exporter)).code).toBe(ExportResultCode.FAILED);
    expect(String(notice.mock.calls[notice.mock.calls.length - 1]?.[1]).length).toBeLessThan(1000);
    await server.close();
  });

  it("settles when the response is cut off mid-body", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { "Content-Length": "1000" });
      res.write("partial");
      setTimeout(() => req.socket.destroy(), 20);
    });
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 800 });
    const result = await exportOnce(exporter);
    expect(result.code).toBe(ExportResultCode.FAILED);
    await server.close();
  });

  it("PERF-003: shutdown() aborts an in-flight export to a hung endpoint", async () => {
    const server = await startServer(() => { /* never answers */ });
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 30_000 });
    const pending = exportOnce(exporter);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await exporter.shutdown();
    expect((await pending).code).toBe(ExportResultCode.FAILED);
    expect(Date.now() - t0).toBeLessThan(1000);
    await server.close();
  });

  it("PERF-003: abortPending() aborts in-flight exports and keeps the exporter usable", async () => {
    let hang = true;
    const server = await startServer((_q, res) => { if (!hang) json(res, 200, {}); });
    const exporter = new TrialAwareOTLPExporter({ url: server.url, timeoutMillis: 30_000 });
    const pending = exportOnce(exporter);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    exporter.abortPending();
    expect((await pending).code).toBe(ExportResultCode.FAILED);
    expect(Date.now() - t0).toBeLessThan(500);
    hang = false;
    expect((await exportOnce(exporter)).code).toBe(ExportResultCode.SUCCESS);
    await server.close();
  });

  it("does not keep a reference to the caller's headers object", () => {
    const headers: Record<string, string> = { "x-api-key": "k" };
    const exporter = new TrialAwareOTLPExporter({ url: "http://127.0.0.1:1/v1/traces", headers });
    headers["x-api-key"] = "changed";
    expect((exporter as any)._headers["x-api-key"]).toBe("k");
  });
});

describe("blocked trace ids (MEM-004)", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearBlockedTraceIds();
  });

  it("expire after their TTL", () => {
    vi.useFakeTimers();
    addBlockedTraceId("t1");
    expect(isTraceIdBlocked("t1")).toBe(true);
    vi.advanceTimersByTime(2 * 900 * 1000 + 1);
    expect(isTraceIdBlocked("t1")).toBe(false);
  });

  it("are capped", () => {
    for (let i = 0; i < 10_050; i++) addBlockedTraceId(`t${i}`);
    expect(blockedTraceIdCount()).toBeLessThanOrEqual(10_000);
    expect(isTraceIdBlocked("t0")).toBe(false);
    expect(isTraceIdBlocked("t10049")).toBe(true);
  });
});
