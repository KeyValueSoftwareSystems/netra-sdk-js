/**
 * Shared helpers for instrumentation tests: a local mock HTTP server that
 * stands in for an LLM provider, and an in-memory tracer to read spans from.
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo, Socket } from "node:net";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export type MockHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: any,
) => void;

export interface MockServer {
  url: string;
  handle(handler: MockHandler): void;
  close(): Promise<void>;
}

export async function startMockServer(): Promise<MockServer> {
  let handler: MockHandler = (_req, res) => {
    res.writeHead(500).end();
  };
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => handler(req, res, raw ? JSON.parse(raw) : undefined));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    handle(next) {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Write server-sent events. With `end: false` the connection is left open. */
export function sendSSE(
  res: ServerResponse,
  events: Array<{ event?: string; data: unknown }>,
  { end = true } = {},
): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const { event, data } of events) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  }
  if (end) res.end();
}

export function setupTracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  return {
    exporter,
    provider,
    spans: (name?: string) =>
      exporter.getFinishedSpans().filter((s) => !name || s.name === name),
    async teardown() {
      context.disable();
      await provider.shutdown();
    },
  };
}

/** Records unhandled rejections; Node would crash the process on each one. */
export function captureUnhandledRejections() {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", listener);
  return { seen, stop: () => process.off("unhandledRejection", listener) };
}

/** Let pending promise rejections and socket events surface. */
export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
