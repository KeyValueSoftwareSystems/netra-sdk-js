/**
 * groq-sdk is Stainless-generated like OpenAI's, so it shares the APIPromise
 * and Stream objects that instrumentation must hand back intact (audit
 * finding INST-1). Runs the real SDK against a local mock server.
 */
import { SpanStatusCode } from "@opentelemetry/api";
import Groq from "groq-sdk";
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
import { NetraGroqInstrumentor } from "./index";

const PARAMS = {
  model: "llama-test",
  messages: [{ role: "user" as const, content: "What is 2+2?" }],
};

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "llama-test",
  choices: [
    { index: 0, message: { role: "assistant", content: "4" }, finish_reason: "stop", logprobs: null },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
};

function chunk(delta: Record<string, unknown>, finish_reason: string | null = null) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "llama-test",
    choices: [{ index: 0, delta, finish_reason, logprobs: null }],
  };
}

const CHUNKS = [
  { data: chunk({ role: "assistant", content: "Hel" }) },
  { data: chunk({ content: "lo" }) },
  { data: chunk({}, "stop") },
  { data: "[DONE]" },
];

async function collect(iterable: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("Groq instrumentation", () => {
  let tracing: ReturnType<typeof setupTracing>;
  let server: MockServer;
  let client: Groq;
  let rejections: ReturnType<typeof captureUnhandledRejections>;
  const instrumentor = new NetraGroqInstrumentor();

  beforeAll(async () => {
    tracing = setupTracing();
    server = await startMockServer();
    await instrumentor.instrumentAsync({ tracerProvider: tracing.provider });
    client = new Groq({ apiKey: "test", baseURL: server.url, maxRetries: 0 });
  });

  afterAll(async () => {
    instrumentor.uninstrument();
    await server.close();
    await tracing.teardown();
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

  it("create().withResponse() returns the data and the raw response", async () => {
    server.handle((_req, res) => sendJSON(res, 200, COMPLETION));

    const { data, response } = await client.chat.completions.create(PARAMS).withResponse();

    expect(data.id).toBe("chatcmpl-1");
    expect(response.status).toBe(200);
    const [span] = tracing.spans("groq.chat");
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes["gen_ai.response.model"]).toBe("llama-test");
  });

  it("streams keep controller and tee(), and yield the SDK's chunks", async () => {
    server.handle((_req, res) => sendSSE(res, CHUNKS));

    const stream = await client.chat.completions.create({ ...PARAMS, stream: true });
    expect(stream.controller).toBeInstanceOf(AbortController);
    const [left, right] = stream.tee();
    expect(await collect(left)).toHaveLength(3);
    expect(await collect(right)).toHaveLength(3);

    const again = await client.chat.completions.create({ ...PARAMS, stream: true });
    const chunks = await collect(again);
    expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe("Hello");
    const spans = tracing.spans("groq.chat");
    expect(spans[spans.length - 1].status.code).toBe(SpanStatusCode.OK);
  });

  it("toReadableStream() works and still ends the span", async () => {
    server.handle((_req, res) => sendSSE(res, CHUNKS));

    const stream = await client.chat.completions.create({ ...PARAMS, stream: true });
    const reader = stream.toReadableStream().getReader();
    while (!(await reader.read()).done);

    const [span] = tracing.spans("groq.chat");
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("breaking out of the stream aborts the request and ends the span", async () => {
    let requestClosed!: Promise<void>;
    server.handle((_req, res) => {
      requestClosed = new Promise((resolve) => res.on("close", () => resolve()));
      sendSSE(res, CHUNKS.slice(0, 2), { end: false });
    });

    const stream = await client.chat.completions.create({ ...PARAMS, stream: true });
    for await (const _ of stream) break;

    await requestClosed;
    expect(tracing.spans("groq.chat")).toHaveLength(1);
  });

  it("an API error reaches the caller and is recorded on the span", async () => {
    server.handle((_req, res) =>
      sendJSON(res, 429, { error: { message: "Rate limited", type: "rate_limit" } }),
    );

    await expect(client.chat.completions.create(PARAMS).withResponse()).rejects.toBeInstanceOf(
      Groq.RateLimitError,
    );

    const [span] = tracing.spans("groq.chat");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});
