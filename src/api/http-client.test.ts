/**
 * JS-PERF-009 / JS-SEC-017 regression tests for the REST client: a deadline
 * that covers the body, no timer left behind, bounded bodies, GET retries,
 * and redirects that never take x-api-key to another origin.
 */
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Config } from "../config";
import { NetraLogger } from "../netraLogger";
import { NetraHttpClient } from "./http-client";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
async function serve(handler: Handler) {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => { seen.push(req.headers); handler(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

function clientFor(base: string, timeoutSeconds = 3): NetraHttpClient {
  process.env.NETRA_OTLP_ENDPOINT = `${base}/telemetry`;
  process.env.NETRA_API_KEY = "netra-key-TEST";
  return new NetraHttpClient(new Config(), "NETRA_TEST_TIMEOUT", timeoutSeconds);
}

const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

describe("NetraHttpClient", () => {
  const saved = { endpoint: process.env.NETRA_OTLP_ENDPOINT, key: process.env.NETRA_API_KEY };
  beforeEach(() => vi.spyOn(NetraLogger, "notice").mockImplementation(() => {}));
  afterEach(() => {
    vi.restoreAllMocks();
    process.env.NETRA_OTLP_ENDPOINT = saved.endpoint;
    process.env.NETRA_API_KEY = saved.key;
    if (saved.endpoint === undefined) delete process.env.NETRA_OTLP_ENDPOINT;
    if (saved.key === undefined) delete process.env.NETRA_API_KEY;
  });

  it("PERF-009: a failed request leaves no timer behind", async () => {
    const s = await serve(() => {});
    const url = s.url;
    await s.close(); // nothing listens: ECONNREFUSED
    const client = clientFor(url, 30);
    const before = timers();
    const res = await client.post("/x", { a: 1 });
    expect(res.ok).toBe(false);
    expect(timers()).toBeLessThanOrEqual(before);
  });

  it("PERF-009: the deadline covers a body that never finishes", async () => {
    const s = await serve((_q, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); });
    const client = clientFor(s.url, 1);
    const t0 = Date.now();
    const res = await client.post("/slow-body", {});
    expect(res.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500);
    await s.close();
  });

  it("PERF-009: GET retries 503 and succeeds; POST does not retry", async () => {
    let gets = 0;
    let posts = 0;
    const s = await serve((req, res) => {
      if (req.method === "GET") gets++; else posts++;
      const n = req.method === "GET" ? gets : posts;
      res.writeHead(n < 2 ? 503 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { n } }));
    });
    const client = clientFor(s.url, 5);
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect((await client.get("/g")).ok).toBe(true);
    expect(gets).toBe(2);
    expect((await client.post("/p", {})).status).toBe(503);
    expect(posts).toBe(1);
    await s.close();
  });

  it("PERF-009: rejects a response larger than the limit", async () => {
    const s = await serve((_q, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(11 * 1024 * 1024) });
      res.end();
    });
    const client = clientFor(s.url, 3);
    expect((await client.get("/huge")).ok).toBe(false);
    await s.close();
  });

  it("SEC-017: follows same-origin redirects", async () => {
    const s = await serve((req, res) => {
      if (req.url === "/old") { res.writeHead(302, { Location: "/new" }); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: "moved" }));
    });
    const client = clientFor(s.url);
    const res = await client.get("/old");
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ data: "moved" });
    await s.close();
  });

  it("SEC-017: refuses a cross-origin redirect, so the key never reaches the other host", async () => {
    const other = await serve((_q, res) => { res.writeHead(200); res.end("{}"); });
    const api = await serve((_q, res) => { res.writeHead(302, { Location: `${other.url}/steal` }); res.end(); });
    const client = clientFor(api.url);
    expect((await client.get("/redirect")).ok).toBe(false);
    expect(other.seen).toHaveLength(0);
    await other.close();
    await api.close();
  });
});
