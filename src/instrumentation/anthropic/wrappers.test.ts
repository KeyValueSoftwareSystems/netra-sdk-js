/**
 * Runs the real Anthropic SDK against a local mock server. The main case is
 * audit finding INST-3: an API error that the app catches through
 * `.withResponse()` used to surface as an unhandled rejection, which crashes
 * the process.
 */
import { SpanStatusCode, trace } from "@opentelemetry/api";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  captureUnhandledRejections,
  MockServer,
  sendJSON,
  sendSSE,
  settle,
  setupTracing,
  startMockServer,
} from "../../__fixtures__/llm-test-utils";
import { NetraAnthropicInstrumentor } from "./index";

const PARAMS = {
  model: "claude-test",
  max_tokens: 64,
  messages: [{ role: "user" as const, content: "What is 2+2?" }],
};

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: "4" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 1 },
};

const EVENTS = [
  {
    type: "message_start",
    message: { ...MESSAGE, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
].map((data) => ({ event: data.type, data }));

const RATE_LIMITED = {
  type: "error",
  error: { type: "rate_limit_error", message: "Rate limited" },
};

async function collect(iterable: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("Anthropic instrumentation", () => {
  let tracing: ReturnType<typeof setupTracing>;
  let server: MockServer;
  let client: Anthropic;
  let rejections: ReturnType<typeof captureUnhandledRejections>;
  const instrumentor = new NetraAnthropicInstrumentor();

  beforeAll(async () => {
    tracing = setupTracing();
    // Netra.init() registers a global provider, which turns on the Anthropic
    // SDK's own tracing; it wraps streams too, so test with it on.
    trace.setGlobalTracerProvider(tracing.provider);
    server = await startMockServer();
    await instrumentor.instrument({ tracerProvider: tracing.provider });
    client = new Anthropic({ apiKey: "test", baseURL: server.url, maxRetries: 0 });
  });

  afterAll(async () => {
    instrumentor.uninstrument();
    await server.close();
    await tracing.teardown();
    trace.disable();
  });

  beforeEach(() => {
    tracing.exporter.reset();
    rejections = captureUnhandledRejections();
  });

  afterEach(async () => {
    await settle();
    rejections.stop();
    expect(rejections.seen).toEqual([]);
  });

  describe("errors", () => {
    beforeEach(() => server.handle((_req, res) => sendJSON(res, 429, RATE_LIMITED)));

    it("an error the app catches through withResponse() is never unhandled", async () => {
      let caught: unknown;
      try {
        await client.messages.create(PARAMS).withResponse();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Anthropic.RateLimitError);
      const [span] = tracing.spans("anthropic.chat");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });

    it("reaches an awaiting caller unchanged and is recorded on the span", async () => {
      await expect(client.messages.create(PARAMS)).rejects.toBeInstanceOf(
        Anthropic.RateLimitError,
      );

      const [span] = tracing.spans("anthropic.chat");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.some((e) => e.name === "exception")).toBe(true);
    });
  });

  describe("non-streaming", () => {
    beforeEach(() => server.handle((_req, res) => sendJSON(res, 200, MESSAGE)));

    it("withResponse() returns the data and the raw response", async () => {
      const { data, response } = await client.messages.create(PARAMS).withResponse();

      expect(data.id).toBe("msg_1");
      expect(response.status).toBe(200);
      const [span] = tracing.spans("anthropic.chat");
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes["gen_ai.response.model"]).toBe("claude-test");
    });
  });

  describe("streaming", () => {
    beforeEach(() => server.handle((_req, res) => sendSSE(res, EVENTS)));

    it("create({ stream: true }) yields the SDK's events and ends the span", async () => {
      const stream = await client.messages.create({ ...PARAMS, stream: true });

      expect(stream.controller).toBeInstanceOf(AbortController);
      expect(await collect(stream)).toHaveLength(EVENTS.length);
      const [span] = tracing.spans("anthropic.chat");
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });

    it("works alongside the SDK's own tracing when the app breaks out early", async () => {
      const stream = await client.messages.create({ ...PARAMS, stream: true });
      for await (const _ of stream) break;

      expect(tracing.spans("anthropic.chat")).toHaveLength(1);
      expect(tracing.spans("anthropic.messages.create")).toHaveLength(1);
    });

    it("create({ stream: true }).withResponse() returns the stream", async () => {
      const { data, response } = await client.messages
        .create({ ...PARAMS, stream: true })
        .withResponse();

      expect(response.status).toBe(200);
      expect(await collect(data)).toHaveLength(EVENTS.length);
    });

    it("toReadableStream() works and still ends the span", async () => {
      const stream = await client.messages.create({ ...PARAMS, stream: true });
      const reader = stream.toReadableStream().getReader();
      let lines = 0;
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        lines += new TextDecoder().decode(r.value).trim().split("\n").length;
      }

      expect(lines).toBe(EVENTS.length);
      expect(tracing.spans("anthropic.chat")).toHaveLength(1);
    });

    it("messages.stream().finalMessage() still works", async () => {
      const message = await client.messages.stream(PARAMS).finalMessage();

      expect(message.content[0]).toMatchObject({ type: "text", text: "Hello" });
      expect(tracing.spans("anthropic.stream")).toHaveLength(1);
    });
  });
});
