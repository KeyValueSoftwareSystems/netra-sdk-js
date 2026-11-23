/**
 * Gemini Decisions API (`client.decisions.create`): the getter patch on
 * GoogleGenAI.prototype, the span the wrapper records, and the size-bounded
 * capture of input, questions and answers.
 *
 * @google/genai is not a dev dependency, so the client is modelled on its real
 * shape: `decisions` is a lazy prototype getter returning an instance of a
 * class the package does not export, whose async `create(params, options)`
 * resolves to the parsed JSON response.
 */
import { Span, SpanStatusCode } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setupTracing } from "../../__fixtures__/llm-test-utils";
import { Config } from "../../config";
import { buildGeminiDecisionInput, setDecisionRequestAttributes, setDecisionResponseAttributes } from "./decision-utils";
import { NetraGoogleGenAIInstrumentor } from "./index";

const QUESTIONS = {
  is_refund: { type: "noul", instructions: "Is the user asking for a refund?" },
  route: { type: "choice", instructions: "Which team?", criteria: { billing: "money", tech: "bugs" } },
  tone: { type: "score", instructions: "How upset?", criteria: ["calm", "annoyed", "angry"] },
};

const ANSWERS = {
  is_refund: { type: "noul", noul: 0.93, confidence: 0.93 },
  route: { type: "choice", choice: "billing", confidence: 0.8, probabilities: { billing: 0.8, tech: 0.2 } },
};

const USAGE = {
  total_input_tokens: 120,
  total_output_tokens: 3,
  total_thought_tokens: 2,
  total_tokens: 125,
  total_cached_tokens: 10,
};

const keyed = (map: Record<string, object>) => Object.entries(map).map(([id, value]) => ({ id, ...value }));

function recordingSpan(): { span: Span; attributes: Record<string, unknown> } {
  const attributes: Record<string, unknown> = {};
  const span = {
    isRecording: () => true,
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
      return span;
    },
  } as unknown as Span;
  return { span, attributes };
}

function captureRequest(params: Record<string, unknown>): Record<string, unknown> {
  const { span, attributes } = recordingSpan();
  setDecisionRequestAttributes(span, { model: "gemini-decision-1", questions: QUESTIONS, ...params });
  return attributes;
}

function captureResponse(response: unknown): Record<string, unknown> {
  const { span, attributes } = recordingSpan();
  setDecisionResponseAttributes(span, response);
  return attributes;
}

/** Split a decision `input` attribute into its input entries and the questions its last entry holds. */
function decisionInput(inputJson: unknown): { entries: any[]; questions: any[] } {
  const all = JSON.parse(inputJson as string) as any[];
  const questionsEntry = all[all.length - 1];
  expect(questionsEntry.role).toBe("user");
  return { entries: all.slice(0, -1), questions: JSON.parse(questionsEntry.content) };
}

function setAttributeMaxSize(size: number): void {
  vi.spyOn(Config, "SPAN_ATTRIBUTE_MAX_SIZE", "get").mockReturnValue(size);
}

/** A stand-in for @google/genai's client classes, with the Decisions API shaped like the real one. */
function fakeGenAIModule(handler: (params: any) => Promise<unknown>) {
  class GeminiNextGenDecisions {
    async create(params: any, _options?: unknown) {
      return handler(params);
    }
  }
  class GoogleGenAI {
    private _decisions?: GeminiNextGenDecisions;
    get decisions() {
      return (this._decisions ??= new GeminiNextGenDecisions());
    }
  }
  class Models {}
  return { classes: { Models, GoogleGenAI }, GeminiNextGenDecisions, GoogleGenAI };
}

describe("Gemini Decisions API capture", () => {
  beforeEach(() => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    setAttributeMaxSize(30000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("request", () => {
    it("records the model without its models/ prefix, also as the response model", () => {
      const attrs = captureRequest({ model: "models/gemini-decision-1", input: "hi" });

      expect(attrs["gen_ai.request.model"]).toBe("gemini-decision-1");
      expect(attrs["gen_ai.response.model"]).toBe("gemini-decision-1");
      expect(attrs["llm.request.type"]).toBe("decision");
      expect(attrs["gen_ai.system"]).toBe("google_genai");
    });

    it("records a string input as one user entry followed by the questions, keyed by id", () => {
      const { entries, questions } = decisionInput(captureRequest({ input: "Refund me!" }).input);

      expect(entries).toEqual([{ role: "user", content: "Refund me!" }]);
      expect(questions).toEqual(keyed(QUESTIONS));
    });

    it("records text blocks as text and elides inline media data", () => {
      const input = [
        { type: "text", text: "Look at this receipt" },
        { type: "image", mime_type: "image/png", data: "aGVsbG8=".repeat(1000) },
        { type: "document", uri: "gs://bucket/receipt.pdf", mime_type: "application/pdf" },
      ];

      const attrs = captureRequest({ input });
      const { entries } = decisionInput(attrs.input);

      expect(entries[0]).toEqual({ role: "user", content: "Look at this receipt" });
      expect(JSON.parse(entries[1].content)).toEqual({ type: "image", mime_type: "image/png", data: "[image]" });
      expect(JSON.parse(entries[2].content).uri).toBe("gs://bucket/receipt.pdf");
      expect(attrs.input as string).not.toContain("aGVsbG8");
    });

    it("records a single content block input", () => {
      const { entries } = decisionInput(captureRequest({ input: { type: "text", text: "solo" } }).input);

      expect(entries).toEqual([{ role: "user", content: "solo" }]);
    });

    it("records no content when content tracing is off, but still the model", () => {
      vi.stubEnv("TRACELOOP_TRACE_CONTENT", "false");

      const attrs = captureRequest({ input: "secret" });

      expect(attrs.input).toBeUndefined();
      expect(attrs["gen_ai.request.model"]).toBe("gemini-decision-1");
    });

    it("never lets a long input push out the questions", () => {
      setAttributeMaxSize(1000);

      const attrs = captureRequest({ input: "x".repeat(50_000) });
      const { entries, questions } = decisionInput(attrs.input);

      expect((attrs.input as string).length).toBeLessThanOrEqual(1000);
      expect(questions).toEqual(keyed(QUESTIONS));
      expect(entries[0].content.startsWith("xxx")).toBe(true);
    });

    it("drops whole questions past half the attribute size", () => {
      setAttributeMaxSize(600);
      const many = Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`q${i}`, { type: "noul", instructions: `Question ${i}?` }]),
      );

      const attrs = captureRequest({ input: "hi", questions: many });
      const { questions } = decisionInput(attrs.input);

      expect((attrs.input as string).length).toBeLessThanOrEqual(600);
      expect(questions.length).toBeGreaterThan(0);
      expect(questions.length).toBeLessThan(50);
      expect(questions).toEqual(keyed(many).slice(0, questions.length));
    });

    it("returns undefined when there is nothing to record", () => {
      expect(buildGeminiDecisionInput(undefined)).toBeUndefined();
      expect(buildGeminiDecisionInput("")).toBeUndefined();
    });
  });

  describe("response", () => {
    it("records the answers as output, keyed by question id", () => {
      const attrs = captureResponse({ answers: ANSWERS, usage: USAGE });

      const [output] = JSON.parse(attrs.output as string);
      expect(output.role).toBe("assistant");
      expect(JSON.parse(output.content)).toEqual(keyed(ANSWERS));
    });

    it("records token usage", () => {
      const attrs = captureResponse({ answers: ANSWERS, usage: USAGE });

      expect(attrs["gen_ai.usage.prompt_tokens"]).toBe(120);
      expect(attrs["gen_ai.usage.completion_tokens"]).toBe(5);
      expect(attrs["llm.usage.total_tokens"]).toBe(125);
      expect(attrs["gen_ai.usage.cache_read_input_tokens"]).toBe(10);
    });

    it("records the block reason as the finish reason", () => {
      const attrs = captureResponse({ prompt_feedback: { block_reason: "safety" }, usage: { total_input_tokens: 5 } });

      expect(attrs["llm.response.finish_reason"]).toBe("safety");
      expect(attrs.output).toBeUndefined();
    });

    it("records usage but not answers when content tracing is off", () => {
      vi.stubEnv("TRACELOOP_TRACE_CONTENT", "false");

      const attrs = captureResponse({ answers: ANSWERS, usage: USAGE });

      expect(attrs.output).toBeUndefined();
      expect(attrs["gen_ai.usage.prompt_tokens"]).toBe(120);
    });

    it("drops whole answers past the attribute size", () => {
      setAttributeMaxSize(600);
      const many = Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`q${i}`, { type: "noul", noul: 0.5, confidence: 0.5 }]),
      );

      const attrs = captureResponse({ answers: many });
      const [output] = JSON.parse(attrs.output as string);
      const recorded = JSON.parse(output.content);

      expect((attrs.output as string).length).toBeLessThanOrEqual(600);
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.length).toBeLessThan(50);
      expect(recorded).toEqual(keyed(many).slice(0, recorded.length));
    });

    it("ignores a non-object response", () => {
      expect(captureResponse(undefined)).toEqual({});
    });
  });
});

describe("Gemini Decisions API instrumentation", () => {
  let tracing: ReturnType<typeof setupTracing>;

  beforeAll(() => {
    tracing = setupTracing();
  });

  afterAll(async () => {
    await tracing.teardown();
  });

  beforeEach(() => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    tracing.exporter.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function instrument(handler: (params: any) => Promise<unknown>) {
    const mod = fakeGenAIModule(handler);
    const instrumentor = new NetraGoogleGenAIInstrumentor() as any;
    const tracer = tracing.provider.getTracer("test");
    const patched = instrumentor.applyPatches(mod.classes, tracer);
    return { ...mod, instrumentor, patched };
  }

  it("records one decision span per create call and returns the response untouched", async () => {
    const response = { answers: ANSWERS, usage: USAGE };
    const { GoogleGenAI, patched } = instrument(async () => response);

    const result = await new GoogleGenAI().decisions.create({
      model: "gemini-decision-1",
      input: "Refund me!",
      questions: QUESTIONS,
      api_version: "v1beta",
    });

    expect(patched).toBe(true);
    expect(result).toBe(response);
    const [span] = tracing.spans("google_genai.decision");
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes["llm.request.type"]).toBe("decision");
    expect(span.attributes["gen_ai.request.model"]).toBe("gemini-decision-1");
    expect(span.attributes["gen_ai.usage.prompt_tokens"]).toBe(120);
    expect(JSON.parse(span.attributes.input as string)).toHaveLength(2);
    expect(span.attributes.output).toBeDefined();
  });

  it("wraps the shared resource prototype once, covering every client", async () => {
    const { GoogleGenAI, GeminiNextGenDecisions } = instrument(async () => ({ answers: ANSWERS }));

    await new GoogleGenAI().decisions.create({ model: "m", input: "a", questions: QUESTIONS });
    const wrappedCreate = GeminiNextGenDecisions.prototype.create;
    await new GoogleGenAI().decisions.create({ model: "m", input: "b", questions: QUESTIONS });

    expect(GeminiNextGenDecisions.prototype.create).toBe(wrappedCreate);
    expect((wrappedCreate as any).__wrapped).toBe(true);
    expect(tracing.spans("google_genai.decision")).toHaveLength(2);
  });

  it("records an API error on the span and re-throws it", async () => {
    const { GoogleGenAI } = instrument(async () => {
      throw new Error("bad question");
    });

    await expect(
      new GoogleGenAI().decisions.create({ model: "m", input: "x", questions: QUESTIONS }),
    ).rejects.toThrow("bad question");

    const [span] = tracing.spans("google_genai.decision");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("bad question");
  });

  it("restores the getter and unwraps create on uninstrument", async () => {
    const { GoogleGenAI, GeminiNextGenDecisions, classes, instrumentor } = instrument(async () => ({}));
    const client = new GoogleGenAI();
    await client.decisions.create({ model: "m", input: "x", questions: QUESTIONS });

    instrumentor.removePatches(classes);
    tracing.exporter.reset();
    await client.decisions.create({ model: "m", input: "x", questions: QUESTIONS });

    expect((GeminiNextGenDecisions.prototype.create as any).__wrapped).toBeUndefined();
    expect(tracing.spans("google_genai.decision")).toHaveLength(0);
  });

  it("does not patch the same client class twice", () => {
    const { classes, instrumentor } = instrument(async () => ({}));
    const getter = Object.getOwnPropertyDescriptor(classes.GoogleGenAI.prototype, "decisions");

    instrumentor.applyPatches(classes, tracing.provider.getTracer("test"));

    expect(Object.getOwnPropertyDescriptor(classes.GoogleGenAI.prototype, "decisions")).toEqual(getter);
  });

  it("skips quietly on @google/genai releases without the Decisions API", () => {
    class GoogleGenAI {}
    class Models {}
    const instrumentor = new NetraGoogleGenAIInstrumentor() as any;

    expect(() =>
      instrumentor.applyPatches({ Models, GoogleGenAI }, tracing.provider.getTracer("test")),
    ).not.toThrow();
    expect(Object.getOwnPropertyDescriptor(GoogleGenAI.prototype, "decisions")).toBeUndefined();
  });
});
