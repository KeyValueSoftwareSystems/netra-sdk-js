/**
 * Decisions API capture: questions recorded as the last `input` entry, answers
 * as `output`, and every attribute kept within the attribute size limit as
 * valid JSON without encoding more than the attribute can hold.
 */
import { Span } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Config } from "../../config";
import { setRequestAttributes, setResponseAttributes } from "./utils";

const QUESTIONS = [
  { type: "predicate", name: "is_spam", instructions: "Is this message spam?" },
  {
    type: "choice",
    name: "category",
    instructions: "Which team should handle this?",
    choices: [{ value: "billing" }, { value: "tech", description: "Technical issues" }],
  },
  {
    type: "score",
    name: "urgency",
    instructions: "How urgent is this?",
    levels: [{ label: "low" }, { label: "medium" }, { label: "high" }],
  },
];

const ANSWERS = [
  { type: "predicate", name: "is_spam", probability: 0.08 },
  { type: "choice", name: "category", choice: "billing", confidence: 0.91, probabilities: [] },
];

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

function captureRequest(kwargs: Record<string, unknown>): Record<string, unknown> {
  const { span, attributes } = recordingSpan();
  setRequestAttributes(span, { model: "gpt-6-luna", ...kwargs }, "decision");
  return attributes;
}

function captureResponse(response: Record<string, unknown>): Record<string, unknown> {
  const { span, attributes } = recordingSpan();
  setResponseAttributes(span, { model: "gpt-6-luna", ...response });
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

describe("OpenAI Decisions API capture", () => {
  beforeEach(() => {
    vi.stubEnv("TRACELOOP_TRACE_CONTENT", "true");
    setAttributeMaxSize(30000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("questions in input", () => {
    it("records the questions as the last input entry", () => {
      const attrs = captureRequest({ input: "hi", questions: QUESTIONS });

      const { entries, questions } = decisionInput(attrs["input"]);
      expect(entries).toEqual([{ role: "user", content: "hi" }]);
      expect(questions).toEqual(QUESTIONS);
      expect(attrs["gen_ai.decision.questions"]).toBeUndefined();
    });

    it("records the questions even without recordable input", () => {
      const attrs = captureRequest({ input: "", questions: QUESTIONS });

      const { entries, questions } = decisionInput(attrs["input"]);
      expect(entries).toEqual([]);
      expect(questions).toEqual(QUESTIONS);
    });

    it("never lets a long input push out the questions", () => {
      setAttributeMaxSize(1000);

      const attrs = captureRequest({ input: "x".repeat(5000), questions: QUESTIONS.slice(0, 1) });

      expect((attrs["input"] as string).length).toBeLessThanOrEqual(1000);
      const { entries, questions } = decisionInput(attrs["input"]);
      expect(questions).toEqual(QUESTIONS.slice(0, 1));
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toMatch(/^x+$/);
    });

    it("replaces data-URL images in question instructions with a placeholder", () => {
      const imageUrl = "data:image/png;base64," + "A".repeat(100_000);
      const instructions = [
        { type: "input_text", text: "Does this photo show damage?" },
        { type: "input_image", image_url: imageUrl },
      ];

      const attrs = captureRequest({
        input: "hi",
        questions: [{ type: "predicate", name: "damaged", instructions }],
      });

      expect(decisionInput(attrs["input"]).questions).toEqual([
        {
          type: "predicate",
          name: "damaged",
          instructions: [
            { type: "input_text", text: "Does this photo show damage?" },
            { type: "input_image", image_url: "[image]" },
          ],
        },
      ]);
      expect(instructions[1].image_url).toBe(imageUrl);
    });

    it("drops whole questions past half the attribute size, keeping the input", () => {
      setAttributeMaxSize(400);
      const questions = Array.from({ length: 20 }, (_, i) => ({
        type: "predicate",
        name: `q${i}`,
        instructions: "x".repeat(50),
      }));

      const attrs = captureRequest({ input: "hi", questions });

      const inputJson = attrs["input"] as string;
      expect(inputJson.length).toBeLessThanOrEqual(400);
      const all = JSON.parse(inputJson);
      expect(JSON.stringify(all[all.length - 1]).length).toBeLessThanOrEqual(200);
      const { entries, questions: recorded } = decisionInput(inputJson);
      expect(entries).toEqual([{ role: "user", content: "hi" }]);
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.length).toBeLessThan(questions.length);
      expect(recorded).toEqual(questions.slice(0, recorded.length));
    });

    it("ends the recorded questions at one too large to fit", () => {
      const choices = Array.from({ length: 100 }, (_, i) => ({
        value: `c${i}`,
        description: "d".repeat(40_000),
      }));
      const questions = [
        QUESTIONS[0],
        { type: "choice", name: "huge", instructions: "Pick one", choices },
        QUESTIONS[2],
      ];

      const attrs = captureRequest({ input: "hi", questions });

      expect(decisionInput(attrs["input"]).questions).toEqual([QUESTIONS[0]]);
    });

    it("records circular references in questions as a marker", () => {
      const question: Record<string, unknown> = { type: "predicate", instructions: "x" };
      question.self = question;

      const attrs = captureRequest({ input: "hi", questions: [question] });

      expect(decisionInput(attrs["input"]).questions).toEqual([
        { type: "predicate", instructions: "x", self: "[Circular]" },
      ]);
    });

    it("does not read questions or input given as one-shot iterables", () => {
      const input = (function* () {
        yield { role: "user", content: "hi" };
      })();
      const questions = (function* () {
        yield QUESTIONS[0];
      })();

      const attrs = captureRequest({ input, questions });

      expect([...input]).toHaveLength(1);
      expect([...questions]).toHaveLength(1);
      expect(attrs["input"]).toBeUndefined();
    });
  });

  describe("input size limit", () => {
    it("cuts a large input to the attribute size as valid JSON", () => {
      const document = "x".repeat(4_000_000);

      const attrs = captureRequest({
        input: [
          { role: "user", content: document },
          { type: "function_call_output", call_id: "c1", output: document },
          { role: "assistant", content: "never reached" },
        ],
        questions: QUESTIONS,
      });

      expect((attrs["input"] as string).length).toBeLessThanOrEqual(30000);
      const { entries, questions } = decisionInput(attrs["input"]);
      expect(questions).toEqual(QUESTIONS);
      expect(entries).toHaveLength(1);
      expect(document.startsWith(entries[0].content)).toBe(true);
      expect(entries[0].content.length).toBeGreaterThan(29_000);
    });

    it.each([
      ["message", (parts: unknown[]) => ({ role: "user", content: parts })],
      ["tool output", (parts: unknown[]) => ({ type: "function_call_output", call_id: "c1", output: parts })],
    ])("cuts a document split into many parts (%s) before encoding it", (_name, makeItem) => {
      const parts = Array.from({ length: 100 }, (_, i) => ({
        type: "input_text",
        text: String(i).padStart(3, "0") + "x".repeat(39_997),
      }));

      const attrs = captureRequest({ input: [makeItem(parts)], questions: QUESTIONS });

      expect((attrs["input"] as string).length).toBeLessThanOrEqual(30000);
      const { entries } = decisionInput(attrs["input"]);
      expect(entries).toHaveLength(1);
      expect(entries[0].content.startsWith('[{"type":"input_text","text":"000xxx')).toBe(true);
      expect(entries[0].content).not.toContain('"text":"001');
      // The caller's parts are left untouched.
      expect(parts.every((part) => part.text.length === 40_000)).toBe(true);
    });

    it("gives later entries only the budget earlier ones left", () => {
      setAttributeMaxSize(300);

      const attrs = captureRequest({
        input: [
          { role: "system", content: "Be brief." },
          { type: "function_call", call_id: "c1", name: "lookup", arguments: '{"q": "' + "y".repeat(1000) + '"}' },
          { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "z".repeat(1000) }] },
        ],
        questions: [],
      });

      const inputJson = attrs["input"] as string;
      expect(inputJson.length).toBeLessThanOrEqual(300);
      const entries = JSON.parse(inputJson);
      expect(entries[0]).toEqual({ role: "system", content: "Be brief." });
      expect(entries[1].role).toBe("assistant");
      expect(entries[1].tool_call_id).toBe("c1");
      expect(entries[1].content).toContain('"y');
      expect(entries).toHaveLength(2);
    });

    it.each([
      ["quotes and newlines", '"quoted"\n'.repeat(1000)],
      ["control characters", "\u0000".repeat(1000)],
      ["non-ASCII", "é中".repeat(1000)],
      ["emoji", "😀".repeat(1000)],
    ])("keeps %s within the attribute size without splitting characters", (_name, text) => {
      setAttributeMaxSize(500);

      const attrs = captureRequest({ input: text, questions: [] });

      const inputJson = attrs["input"] as string;
      expect(inputJson.length).toBeLessThanOrEqual(500);
      const [entry] = JSON.parse(inputJson);
      expect(entry.role).toBe("user");
      expect(entry.content.length).toBeGreaterThan(0);
      expect(text.startsWith(entry.content)).toBe(true);
      expect(/[\uD800-\uDBFF]$/.test(entry.content)).toBe(false);
    });
  });

  describe("answers", () => {
    it("records answers only as the output entry", () => {
      const attrs = captureResponse({ answers: ANSWERS });

      const [output] = JSON.parse(attrs["output"] as string);
      expect(output.role).toBe("assistant");
      expect(JSON.parse(output.content)).toEqual(ANSWERS);
      expect(attrs["gen_ai.decision.answers"]).toBeUndefined();
    });

    it("drops whole answers past the attribute size", () => {
      setAttributeMaxSize(600);
      const answers = Array.from({ length: 50 }, (_, i) => ({
        type: "predicate",
        probability: 0.5,
        explanation: `"${i}" `.repeat(10),
      }));

      const attrs = captureResponse({ answers });

      const outputJson = attrs["output"] as string;
      expect(outputJson.length).toBeLessThanOrEqual(600);
      const [output] = JSON.parse(outputJson);
      const recorded = JSON.parse(output.content);
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.length).toBeLessThan(answers.length);
      expect(recorded).toEqual(answers.slice(0, recorded.length));
    });

    it("records no output when not even one answer fits", () => {
      setAttributeMaxSize(100);

      const attrs = captureResponse({ answers: [{ type: "predicate", explanation: "x".repeat(500) }] });

      expect(attrs["output"]).toBeUndefined();
    });

    it("records empty answers as an empty array", () => {
      const attrs = captureResponse({ answers: [] });

      const [output] = JSON.parse(attrs["output"] as string);
      expect(JSON.parse(output.content)).toEqual([]);
    });
  });
});
