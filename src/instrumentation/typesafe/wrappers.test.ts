/**
 * Runs the real TypeSafe SDK (`@typesafe-ai/sdk`) with a fake `fetch` to check
 * the `typesafe.system_one` span, its content attributes, and that the SDK's
 * own `APIPromise` (`.asResponse()`, `.withResponse()`, `.map()`) is handed
 * back intact.
 */
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  APIError,
  choice,
  image,
  noul,
  score,
  TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { captureUnhandledRejections, settle, setupTracing } from "../../__fixtures__/llm-test-utils";
import { Config, DEFAULT_INSTRUMENTS, DEFAULT_INSTRUMENTS_FOR_ROOT, NetraInstruments } from "../../config";
import { NetraLogger } from "../../netraLogger";
import { createSuppressedContext } from "../utils";
import { context } from "@opentelemetry/api";
import { NetraTypeSafeInstrumentor } from "./index";
import { SYSTEM_ONE_SPAN_NAME } from "./wrappers";
import { buildOutput } from "./utils";

const QUESTIONS = {
  category: choice("What is this ticket about?", { billing: null, technical: null, other: null }),
  urgent: noul("Is this urgent?"),
};

const RESPONSE = {
  model: "jev-1",
  answers: {
    category: {
      type: "choice",
      choice: "billing",
      confidence: 0.9,
      probabilities: { billing: 0.9, technical: 0.05, other: 0.05 },
    },
    urgent: { type: "noul", noul: 0.8 },
  },
  usage: { input_tokens: 12, output_tokens: 3 },
};

type FakeReply = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A `fetch` that answers every request with `reply` and records what was sent. */
function fakeFetch(reply: FakeReply | (() => FakeReply)) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body = RESPONSE, headers = {} } =
      typeof reply === "function" ? reply() : reply;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-typesafe-request-id": "req-1", ...headers },
    });
  };
  return { fetch, calls };
}

function makeClient(reply: FakeReply | (() => FakeReply) = {}, defaultModel = "jev-latest") {
  const { fetch, calls } = fakeFetch(reply);
  const client = new TypeSafeClient({
    apiKey: "test-key",
    defaultModel,
    fetch,
    compression: false,
    logLevel: "off",
    retry: { maxRetries: 0 },
  });
  return { client, calls };
}

const tracing = setupTracing();
const instrumentor = new NetraTypeSafeInstrumentor();

beforeAll(async () => {
  await instrumentor.instrument({ tracerProvider: tracing.provider });
});

afterAll(async () => {
  await instrumentor.uninstrument();
  await tracing.teardown();
});

beforeEach(() => {
  vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
});

afterEach(() => {
  tracing.exporter.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function onlySpan() {
  const spans = tracing.spans(SYSTEM_ONE_SPAN_NAME);
  expect(spans).toHaveLength(1);
  return spans[0];
}

function parsedInput(span = onlySpan()) {
  return JSON.parse(span.attributes["input"] as string) as Array<{ role: string; content: string }>;
}

function parsedOutput(span = onlySpan()) {
  return JSON.parse(span.attributes["output"] as string) as Array<{ role: string; content: string }>;
}

describe("TypeSafe systemOne instrumentation", () => {
  it("records a generation span with model and usage", async () => {
    const { client } = makeClient();
    const result = await client.systemOne({ state: "I was charged twice.", questions: QUESTIONS });

    expect(result.answers.category.choice).toBe("billing");
    const span = onlySpan();
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.instrumentationScope.name).toBe("netra.instrumentation.typesafe");
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      "gen_ai.system": "TypeSafe",
      "llm.request.type": "decision",
      "netra.span.type": "GENERATION",
      "gen_ai.request.model": "jev-latest",
      "gen_ai.response.model": "jev-1",
      "gen_ai.usage.prompt_tokens": 12,
      "gen_ai.usage.completion_tokens": 3,
      "llm.usage.total_tokens": 15,
    });
    expect(typeof span.attributes["llm.response.duration"]).toBe("number");
  });

  it("records content only as input and output", async () => {
    const { client } = makeClient();
    await client.systemOne({ state: "I was charged twice.", questions: QUESTIONS });

    const span = onlySpan();
    expect(Object.keys(span.attributes).filter((k) => /^gen_ai\.(prompt|completion)/.test(k))).toEqual([]);
    const input = parsedInput(span);
    expect(input).toEqual([
      { role: "user", content: "I was charged twice." },
      { role: "user", content: JSON.stringify(QUESTIONS) },
    ]);
    expect(parsedOutput(span)).toEqual([
      { role: "assistant", content: JSON.stringify(RESPONSE.answers) },
    ]);
  });

  it("uses the per-call model over the client default", async () => {
    const { client, calls } = makeClient({}, "jev-default");
    await client.systemOne({ state: "x", questions: QUESTIONS, model: "jev-preview" });

    expect(JSON.parse(String(calls[0].init?.body)).model).toBe("jev-preview");
    expect(onlySpan().attributes["gen_ai.request.model"]).toBe("jev-preview");
  });

  it("records structured state as JSON and plain-object questions as sent", async () => {
    const { client } = makeClient();
    const questions = {
      severity: score("How severe?", ["low", "high"]),
      raw: { type: "noul" as const, instructions: "Is it raw?" },
    };
    await client.systemOne({ state: { document: "hello", n: 1 }, questions });

    const input = parsedInput();
    expect(input[0]).toEqual({ role: "user", content: '{"document":"hello","n":1}' });
    expect(JSON.parse(input[1].content)).toEqual(JSON.parse(JSON.stringify(questions)));
  });

  it("records an image asset by its reference only", async () => {
    const { client } = makeClient();
    const bytes = new Uint8Array(4096).fill(0xab);
    const photo = image(bytes);
    await client.systemOne({ state: { claim: "chipped", photo }, questions: { damaged: noul("Damaged?") } });

    const input = parsedInput();
    expect(JSON.parse(input[0].content)).toEqual({ claim: "chipped", photo: String(photo) });
    const raw = onlySpan().attributes["input"] as string;
    expect(raw.length).toBeLessThan(1000);
  });

  it("records nothing as input or output when content tracing is off", async () => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "false");
    const { client } = makeClient();
    await client.systemOne({ state: "secret", questions: QUESTIONS });

    const span = onlySpan();
    expect(span.attributes["input"]).toBeUndefined();
    expect(span.attributes["output"]).toBeUndefined();
    expect(span.attributes["gen_ai.response.model"]).toBe("jev-1");
  });

  it("cuts a long state but keeps the questions and valid JSON", async () => {
    vi.spyOn(Config, "SPAN_ATTRIBUTE_MAX_SIZE", "get").mockReturnValue(2000);
    const { client } = makeClient();
    await client.systemOne({ state: 'quote" and \\ '.repeat(10_000), questions: QUESTIONS });

    const raw = onlySpan().attributes["input"] as string;
    expect(raw.length).toBeLessThanOrEqual(2000);
    const input = JSON.parse(raw);
    expect(input).toHaveLength(2);
    expect(input[0].content.length).toBeGreaterThan(100);
    expect(input[1]).toEqual({ role: "user", content: JSON.stringify(QUESTIONS) });
  });

  it("drops answers that do not fit, whole", async () => {
    vi.spyOn(Config, "SPAN_ATTRIBUTE_MAX_SIZE", "get").mockReturnValue(200);
    const answers = {
      first: { type: "noul", noul: 0.1 },
      second: { type: "noul", noul: 0.2, padding: "x".repeat(500) },
    };
    const { client } = makeClient({ body: { ...RESPONSE, answers } });
    await client.systemOne({ state: "s", questions: { first: noul("a?"), second: noul("b?") } });

    const raw = onlySpan().attributes["output"] as string;
    expect(raw.length).toBeLessThanOrEqual(200);
    expect(JSON.parse(parsedOutput()[0].content)).toEqual({ first: answers.first });
  });

  it("keeps non-ASCII content unescaped and within the limit", async () => {
    vi.spyOn(Config, "SPAN_ATTRIBUTE_MAX_SIZE", "get").mockReturnValue(1000);
    const { client } = makeClient();
    await client.systemOne({ state: "é😀".repeat(5000), questions: QUESTIONS });

    const raw = onlySpan().attributes["input"] as string;
    expect(raw.length).toBeLessThanOrEqual(1000);
    expect(raw).toContain("é😀");
    expect(parsedInput()[0].content).toMatch(/^(é😀)+é?$/);
  });

  it("records an API error and rejects the caller with it", async () => {
    const { client } = makeClient({ status: 429, body: { error: "slow down" } });

    await expect(client.systemOne({ state: "x", questions: QUESTIONS })).rejects.toBeInstanceOf(APIError);
    await settle(0);
    const span = onlySpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["error.type"]).toBe("RateLimitError");
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("records a validation error raised before the request is sent", async () => {
    const { client, calls } = makeClient();
    const rejections = captureUnhandledRejections();
    try {
      await expect(client.systemOne({ state: "x", questions: {} })).rejects.toBeInstanceOf(TypeSafeError);
      await settle();
      expect(calls).toHaveLength(0);
      expect(onlySpan().status.code).toBe(SpanStatusCode.ERROR);
      expect(rejections.seen).toEqual([]);
    } finally {
      rejections.stop();
    }
  });

  it("hands back the SDK's APIPromise with withResponse and asResponse intact", async () => {
    const { client } = makeClient();

    const withResponse = await client.systemOne({ state: "x", questions: QUESTIONS }).withResponse();
    expect(withResponse.requestId).toBe("req-1");
    expect(withResponse.data.answers.urgent.noul).toBe(0.8);

    const raw = await client.systemOne({ state: "y", questions: QUESTIONS }).asResponse();
    expect(await raw.json()).toEqual(RESPONSE);

    const mapped = await client
      .systemOne({ state: "z", questions: QUESTIONS })
      .map((r) => r.answers.category.choice);
    expect(mapped).toBe("billing");

    await settle(0);
    const spans = tracing.spans(SYSTEM_ONE_SPAN_NAME);
    expect(spans).toHaveLength(3);
    // The asResponse() call never parses the body itself; the span still gets the answers.
    for (const span of spans) {
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes["gen_ai.response.model"]).toBe("jev-1");
    }
  });

  it("ends the span when the result is never awaited", async () => {
    const { client } = makeClient();
    void client.systemOne({ state: "x", questions: QUESTIONS });
    await settle();
    expect(onlySpan().attributes["output"]).toBeDefined();
  });

  it("creates no span when instrumentation is suppressed", async () => {
    const { client } = makeClient();
    const result = await context.with(createSuppressedContext(), () =>
      client.systemOne({ state: "x", questions: QUESTIONS }),
    );
    expect(result.model).toBe("jev-1");
    expect(tracing.spans(SYSTEM_ONE_SPAN_NAME)).toHaveLength(0);
  });

  it("never fails the call when content capture throws", async () => {
    const warn = vi.spyOn(NetraLogger, "warn").mockImplementation(() => {});
    vi.spyOn(Config, "SPAN_ATTRIBUTE_MAX_SIZE", "get").mockImplementation(() => {
      throw new Error("capture failed");
    });
    const { client } = makeClient();

    const result = await client.systemOne({ state: "x", questions: QUESTIONS });

    expect(result.answers.urgent.noul).toBe(0.8);
    const span = onlySpan();
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes["input"]).toBeUndefined();
    expect(span.attributes["gen_ai.response.model"]).toBe("jev-1");
    expect(warn).toHaveBeenCalledWith("Failed to record TypeSafe input:", expect.any(Error));
    expect(warn).toHaveBeenCalledWith("Failed to record TypeSafe output:", expect.any(Error));
  });
});

describe("buildOutput", () => {
  it("records the body without model and usage when there is no answers object", () => {
    const output = buildOutput({ model: "m", usage: {}, verdict: "yes" });
    expect(JSON.parse(JSON.parse(output!)[0].content)).toEqual({ verdict: "yes" });
  });
});

describe("TypeSafe instrumentor lifecycle", () => {
  it("is enabled by default and allowed to create root spans", () => {
    expect(DEFAULT_INSTRUMENTS.has(NetraInstruments.TYPESAFE)).toBe(true);
    expect(DEFAULT_INSTRUMENTS_FOR_ROOT.has(NetraInstruments.TYPESAFE)).toBe(true);
  });

  it("restores the original method on uninstrument", async () => {
    const before = TypeSafeClient.prototype.systemOne;
    await instrumentor.uninstrument();
    try {
      expect(TypeSafeClient.prototype.systemOne).not.toBe(before);
      const { client } = makeClient();
      await client.systemOne({ state: "x", questions: QUESTIONS });
      expect(tracing.spans(SYSTEM_ONE_SPAN_NAME)).toHaveLength(0);
    } finally {
      await instrumentor.instrument({ tracerProvider: tracing.provider });
    }
  });
});
