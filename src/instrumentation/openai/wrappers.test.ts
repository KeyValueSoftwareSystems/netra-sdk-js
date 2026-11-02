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
<<<<<<< HEAD
import { NetraLogger } from "../../netraLogger";
=======
>>>>>>> 166f73f ([#1964] fix: Keep provider SDK return objects intact in instrumentation (#153))
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

<<<<<<< HEAD
/**
 * The Decisions API ships in openai >= 7.30.0 and the dev dependency is 6.x, so
 * this mirrors v7's `Decisions` resource: a `create` that POSTs to /decisions
 * through the real client and returns its APIPromise.
 */
class StubDecisions {
  constructor(private readonly _client: OpenAI) {}

  create(body: Record<string, unknown>, options?: Record<string, unknown>) {
    return (this._client as any).post("/decisions", { body, ...options });
  }
}

type DecisionsClient = OpenAI & { decisions: StubDecisions };

const QUESTIONS = [
  { type: "predicate", name: "is_complaint", instructions: "The customer is complaining." },
  {
    type: "choice",
    name: "team",
    instructions: "Which team should handle this ticket?",
    choices: [{ value: "billing" }, { value: "technical" }],
  },
];

const DECISION = {
  model: "gpt-decision-test",
  answers: [
    { type: "predicate", name: "is_complaint", probability: 0.97 },
    {
      type: "choice",
      name: "team",
      choice: "billing",
      confidence: 0.9,
      probabilities: [
        { value: "billing", probability: 0.9 },
        { value: "technical", probability: 0.1 },
      ],
    },
  ],
  usage: {
    input_tokens: 40,
    input_tokens_details: { cached_tokens: 8, cache_write_tokens: 0 },
    output_tokens: 6,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 46,
  },
};

const DECISION_PARAMS = {
  model: "gpt-decision-test",
  input: "I was charged twice this month. Fix this today!",
  questions: QUESTIONS,
};

/** Split a decision `input` attribute into its input entries and the questions its last entry holds. */
function decisionInput(inputJson: unknown): { entries: any[]; questions: unknown } {
  const all = JSON.parse(inputJson as string) as any[];
  const questionsEntry = all[all.length - 1];
  expect(questionsEntry.role).toBe("user");
  return { entries: all.slice(0, -1), questions: JSON.parse(questionsEntry.content) };
}

=======
>>>>>>> 166f73f ([#1964] fix: Keep provider SDK return objects intact in instrumentation (#153))
async function collect(iterable: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("OpenAI instrumentation", () => {
  let tracing: ReturnType<typeof setupTracing>;
  let server: MockServer;
<<<<<<< HEAD
  let client: DecisionsClient;
=======
  let client: OpenAI;
>>>>>>> 166f73f ([#1964] fix: Keep provider SDK return objects intact in instrumentation (#153))
  let rejections: ReturnType<typeof captureUnhandledRejections>;
  const instrumentor = new NetraOpenAIInstrumentor();

  beforeAll(async () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    tracing = setupTracing();
    server = await startMockServer();
<<<<<<< HEAD
    (OpenAI as any).Decisions = StubDecisions;
    await instrumentor.instrument({ tracerProvider: tracing.provider });
    client = new OpenAI({ apiKey: "test", baseURL: `${server.url}/v1`, maxRetries: 0 }) as DecisionsClient;
    client.decisions = new StubDecisions(client);
=======
    await instrumentor.instrument({ tracerProvider: tracing.provider });
    client = new OpenAI({ apiKey: "test", baseURL: `${server.url}/v1`, maxRetries: 0 });
>>>>>>> 166f73f ([#1964] fix: Keep provider SDK return objects intact in instrumentation (#153))
  });

  afterAll(async () => {
    await instrumentor.uninstrument();
<<<<<<< HEAD
    delete (OpenAI as any).Decisions;
=======
>>>>>>> 166f73f ([#1964] fix: Keep provider SDK return objects intact in instrumentation (#153))
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
<<<<<<< HEAD

  describe("decisions", () => {
    let requestPath: string | undefined;

    beforeEach(() => {
      requestPath = undefined;
      server.handle((req, res) => {
        requestPath = req.url;
        sendJSON(res, 200, DECISION);
      });
    });

    it("records a decision span with input, questions, answers and usage", async () => {
      const decision = await client.decisions.create(DECISION_PARAMS);

      expect(decision.answers[1].choice).toBe("billing");
      expect(requestPath).toBe("/v1/decisions");

      const [span] = tracing.spans("openai.decision");
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes["llm.request.type"]).toBe("decision");
      expect(span.attributes["gen_ai.system"]).toBe("openai");
      expect(span.attributes["gen_ai.request.model"]).toBe("gpt-decision-test");
      expect(span.attributes["gen_ai.response.model"]).toBe("gpt-decision-test");
      expect(span.attributes["gen_ai.usage.prompt_tokens"]).toBe(40);
      expect(span.attributes["gen_ai.usage.completion_tokens"]).toBe(6);
      expect(typeof span.attributes["llm.response.duration"]).toBe("number");

      // The questions are the last `input` entry, after the input they are asked about.
      const { entries, questions } = decisionInput(span.attributes["input"]);
      expect(entries).toEqual([{ role: "user", content: DECISION_PARAMS.input }]);
      expect(questions).toEqual(QUESTIONS);
      expect(span.attributes["gen_ai.decision.questions"]).toBeUndefined();

      const output = JSON.parse(span.attributes["output"] as string);
      expect(output).toHaveLength(1);
      expect(output[0].role).toBe("assistant");
      expect(JSON.parse(output[0].content)).toEqual(DECISION.answers);

      // Input and answers live only in `input` / `output`, not in per-message indexed keys.
      const keys = Object.keys(span.attributes);
      expect(keys.filter((k) => k.startsWith("gen_ai.prompt."))).toEqual([]);
      expect(keys.filter((k) => k.startsWith("gen_ai.completion."))).toEqual([]);
      expect(span.attributes["gen_ai.decision.answers"]).toBeUndefined();
    });

    it("records mixed input items, eliding inline image data", async () => {
      await client.decisions.create({
        ...DECISION_PARAMS,
        input: [
          { role: "developer", content: "Classify support tickets." },
          {
            role: "user",
            content: [
              { type: "input_text", text: "See attached." },
              { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
            ],
          },
          { type: "function_call", call_id: "call_1", name: "lookup_order", arguments: '{"id":7}' },
          { type: "function_call_output", call_id: "call_1", output: "order 7: paid twice" },
          { type: "custom_tool_call", call_id: "call_2", name: "grep", input: "refund" },
          { type: "custom_tool_call_output", call_id: "call_2", output: "" },
          { role: "user", content: "" },
        ],
      });

      const [span] = tracing.spans("openai.decision");
      const { entries, questions } = decisionInput(span.attributes["input"]);
      expect(questions).toEqual(QUESTIONS);
      expect(entries).toEqual([
        { role: "developer", content: "Classify support tickets." },
        {
          role: "user",
          content: JSON.stringify([
            { type: "input_text", text: "See attached." },
            { type: "input_image", image_url: "[image]" },
          ]),
        },
        {
          role: "assistant",
          content: JSON.stringify({ name: "lookup_order", arguments: '{"id":7}' }),
          tool_call_id: "call_1",
        },
        { role: "tool", content: "order 7: paid twice", tool_call_id: "call_1" },
        {
          role: "assistant",
          content: JSON.stringify({ name: "grep", arguments: "refund" }),
          tool_call_id: "call_2",
        },
      ]);
    });

    it("create().withResponse() returns the decision and the raw response", async () => {
      const { data, response } = await client.decisions
        .create(DECISION_PARAMS)
        .withResponse();

      expect(data.model).toBe("gpt-decision-test");
      expect(response.status).toBe(200);
      expect(tracing.spans("openai.decision")).toHaveLength(1);
    });

    it("records no content when content tracing is off", async () => {
      vi.stubEnv("TRACELOOP_TRACE_CONTENT", "false");
      try {
        await client.decisions.create(DECISION_PARAMS);
      } finally {
        vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
      }

      const [span] = tracing.spans("openai.decision");
      expect(span.attributes["gen_ai.request.model"]).toBe("gpt-decision-test");
      expect(span.attributes["gen_ai.usage.prompt_tokens"]).toBe(40);
      for (const key of [
        "input",
        "output",
        "gen_ai.decision.questions",
      ]) {
        expect(span.attributes[key]).toBeUndefined();
      }
    });

    it("reaches the caller unchanged on error and is recorded on the span", async () => {
      server.handle((_req, res) =>
        sendJSON(res, 429, { error: { message: "Rate limited", type: "rate_limit" } }),
      );

      await expect(client.decisions.create(DECISION_PARAMS)).rejects.toBeInstanceOf(
        OpenAI.RateLimitError,
      );

      const [span] = tracing.spans("openai.decision");
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.events.some((e) => e.name === "exception")).toBe(true);
    });
  });
});

describe("OpenAI instrumentation without the Decisions API", () => {
  it("skips decisions.create quietly on openai versions that lack it", async () => {
    const errorSpy = vi.spyOn(NetraLogger, "error");
    const tracing = setupTracing();
    const instrumentor = new NetraOpenAIInstrumentor();
    try {
      expect((OpenAI as any).Decisions).toBeUndefined();
      await instrumentor.instrument({ tracerProvider: tracing.provider });

      expect(instrumentor.isInstrumented()).toBe(true);
      const decisionErrors = errorSpy.mock.calls.filter((call) =>
        String(call[0]).includes("decisions"),
      );
      expect(decisionErrors).toEqual([]);
    } finally {
      await instrumentor.uninstrument();
      await tracing.teardown();
      errorSpy.mockRestore();
    }
  });
=======
>>>>>>> 166f73f ([#1964] fix: Keep provider SDK return objects intact in instrumentation (#153))
});
