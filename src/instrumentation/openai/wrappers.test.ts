/**
 * The OpenAI SDK returns an APIPromise and its own Stream class; its helpers
 * (.parse(), .stream(), .withResponse()) depend on their extra methods. These
 * run the real SDK against a local mock server to check that instrumentation
 * hands those objects back intact (audit finding INST-1).
 */
import { SpanStatusCode } from "@opentelemetry/api";
import OpenAI from "openai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureUnhandledRejections,
  MockServer,
  sendJSON,
  sendSSE,
  settle,
  setupTracing,
  startMockServer,
} from "../../__fixtures__/llm-test-utils";
import { NetraOpenAIInstrumentor } from "./index";

const PARAMS = {
  model: "gpt-test",
  messages: [{ role: "user" as const, content: "What is 2+2?" }],
};

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-test",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: '{"answer":"4"}', refusal: null },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
};

function chunk(delta: Record<string, unknown>, finish_reason: string | null = null) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
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

describe("OpenAI instrumentation", () => {
  let tracing: ReturnType<typeof setupTracing>;
  let server: MockServer;
  let client: OpenAI;
  let rejections: ReturnType<typeof captureUnhandledRejections>;
  const instrumentor = new NetraOpenAIInstrumentor();

  beforeAll(async () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    tracing = setupTracing();
    server = await startMockServer();
    await instrumentor.instrument({ tracerProvider: tracing.provider });
    client = new OpenAI({ apiKey: "test", baseURL: `${server.url}/v1`, maxRetries: 0 });
  });

  afterAll(async () => {
    await instrumentor.uninstrument();
    await server.close();
    await tracing.teardown();
    vi.unstubAllEnvs();
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

  describe("non-streaming", () => {
    beforeEach(() => server.handle((_req, res) => sendJSON(res, 200, COMPLETION)));

    it("await create() returns the completion and records a span", async () => {
      const completion = await client.chat.completions.create(PARAMS);

      expect(completion.choices[0].message.content).toBe('{"answer":"4"}');
      const [span] = tracing.spans("openai.chat");
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes["gen_ai.response.model"]).toBe("gpt-test");
    });

    it("create().withResponse() returns the data and the raw response", async () => {
      const { data, response } = await client.chat.completions
        .create(PARAMS)
        .withResponse();

      expect(data.id).toBe("chatcmpl-1");
      expect(response.status).toBe(200);
      expect(tracing.spans("openai.chat")).toHaveLength(1);
    });

    it("create().asResponse() leaves the body unread for the caller", async () => {
      const response = await client.chat.completions.create(PARAMS).asResponse();

      expect((await response.json()).id).toBe("chatcmpl-1");
    });

    it("chat.completions.parse() returns the parsed output", async () => {
      const completion = await client.chat.completions.parse({
        ...PARAMS,
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", schema: { type: "object" } },
        },
      });

      expect(completion.choices[0].message.parsed).toEqual({ answer: "4" });
      expect(tracing.spans("openai.chat")).toHaveLength(1);
    });

    it("records the span even if the app never awaits the call", async () => {
      void client.chat.completions.create(PARAMS);
      await settle(200);

      const [span] = tracing.spans("openai.chat");
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes["gen_ai.response.model"]).toBe("gpt-test");
    });

    it("ends the span when the response arrives, not when the app reads it", async () => {
      const pending = client.chat.completions.create(PARAMS);
      await settle(500);
      await pending;

      const [span] = tracing.spans("openai.chat");
      expect(span.attributes["llm.response.duration"]).toBeLessThan(0.4);
    });

    it("records embedding dimensions for the SDK's default base64 encoding", async () => {
      server.handle((_req, res) =>
        sendJSON(res, 200, {
          object: "list",
          model: "embed-test",
          data: [
            {
              object: "embedding",
              index: 0,
              embedding: Buffer.from(new Float32Array([0.5, 0.25, 1]).buffer).toString("base64"),
            },
          ],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }),
      );

      const result = await client.embeddings.create({ model: "embed-test", input: "hi" });

      expect(result.data[0].embedding).toEqual([0.5, 0.25, 1]);
      const [span] = tracing.spans("openai.embedding");
      expect(span.attributes["llm.response.embedding_dimensions"]).toBe(3);
    });
  });

  describe("streaming", () => {
    beforeEach(() => server.handle((_req, res) => sendSSE(res, CHUNKS)));

    it("yields the SDK's chunks and records the streamed content", async () => {
      const stream = await client.chat.completions.create({ ...PARAMS, stream: true });
      const chunks = await collect(stream);

      expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe("Hello");
      const [span] = tracing.spans("openai.chat");
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(JSON.stringify(span.attributes)).toContain("Hello");
    });

    it("chat.completions.stream().finalChatCompletion() works", async () => {
      const final = await client.chat.completions
        .stream(PARAMS)
        .finalChatCompletion();

      expect(final.choices[0].message.content).toBe("Hello");
      expect(tracing.spans("openai.chat")).toHaveLength(1);
    });

    it("create({ stream: true }).withResponse() works", async () => {
      const { data, response } = await client.chat.completions
        .create({ ...PARAMS, stream: true })
        .withResponse();

      expect(response.status).toBe(200);
      expect(await collect(data)).toHaveLength(3);
      expect(tracing.spans("openai.chat")).toHaveLength(1);
    });

    it("keeps the stream's controller and tee()", async () => {
      const stream = await client.chat.completions.create({ ...PARAMS, stream: true });

      expect(stream.controller).toBeInstanceOf(AbortController);
      const [left, right] = stream.tee();
      expect(await collect(left)).toHaveLength(3);
      expect(await collect(right)).toHaveLength(3);
    });

    it("toReadableStream() works and still ends the span", async () => {
      const stream = await client.chat.completions.create({ ...PARAMS, stream: true });
      const reader = stream.toReadableStream().getReader();
      let text = "";
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        text += new TextDecoder().decode(r.value);
      }

      expect(text.trim().split("\n")).toHaveLength(3);
      const [span] = tracing.spans("openai.chat");
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(JSON.stringify(span.attributes)).toContain("Hello");
    });

    it("breaking out of the stream aborts the request and ends the span", async () => {
      let requestClosed!: Promise<void>;
      server.handle((req, res) => {
        requestClosed = new Promise((resolve) => res.on("close", () => resolve()));
        sendSSE(res, CHUNKS.slice(0, 2), { end: false });
      });

      const stream = await client.chat.completions.create({ ...PARAMS, stream: true });
      for await (const _ of stream) break;

      await requestClosed;
      const [span] = tracing.spans("openai.chat");
      expect(span.status.code).toBe(SpanStatusCode.OK);
    });
  });

  describe("errors", () => {
    beforeEach(() =>
      server.handle((_req, res) =>
        sendJSON(res, 429, { error: { message: "Rate limited", type: "rate_limit" } }),
      ),
    );

    it("reaches the caller unchanged and is recorded on the span", async () => {
      await expect(client.chat.completions.create(PARAMS)).rejects.toBeInstanceOf(
        OpenAI.RateLimitError,
      );

      const [span] = tracing.spans("openai.chat");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.some((e) => e.name === "exception")).toBe(true);
    });

    it.each([
      ["a malformed body", (res: any) => res.end("{not json")],
      ["the connection dropping mid-body", (res: any) => {
        res.write('{"id":"chatcmpl-1","choi');
        setTimeout(() => res.socket?.destroy(), 20);
      }],
    ])("a 200 response with %s still records an error span", async (_name, finish) => {
      server.handle((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        finish(res);
      });

      await expect(client.chat.completions.create(PARAMS)).rejects.toThrow();
      await settle(200);

      const [span] = tracing.spans("openai.chat");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });

    it("is never unhandled when the caller uses withResponse()", async () => {
      await expect(
        client.chat.completions.create(PARAMS).withResponse(),
      ).rejects.toBeInstanceOf(OpenAI.RateLimitError);
      await expect(
        client.chat.completions.create({ ...PARAMS, stream: true }).withResponse(),
      ).rejects.toBeInstanceOf(OpenAI.RateLimitError);

      expect(tracing.spans("openai.chat")).toHaveLength(2);
    });
  });
});
