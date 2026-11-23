/**
 * Span attributes for the Gemini Decisions API (`client.decisions.create`, @google/genai >= 3.6).
 *
 * Request:  { model, input, questions: { [id]: { type: "noul" | "choice" | "score", instructions, criteria } }, api_version? }
 * Response: { answers?: { [id]: Answer }, prompt_feedback?: { block_reason }, usage?: { total_input_tokens, ... } }
 *
 * The input, questions and answers are recorded in the same `input` / `output`
 * shape as OpenAI decision spans, through the same size-bounded encoders, so
 * both providers obey the attribute size limit identically.
 */

import { Span } from "@opentelemetry/api";
import { NetraLogger } from "../../netraLogger";
import { SpanAttributes } from "../span-attributes";
import { isDict, isTraceContentEnabled } from "../utils";
import {
  attributeMaxSize,
  encodeEntryWithin,
  joinJsonArray,
  JSON_ITEM_SEPARATOR,
  sliceText,
} from "../json-budget";
import {
  DecisionInputMessage,
  INPUT_ATTRIBUTE,
  OUTPUT_ATTRIBUTE,
  asPromptContent,
  itemsEntry,
} from "../openai/utils";

const DECISION_QUESTIONS_ROLE = "user";
const DECISION_ANSWERS_ROLE = "assistant";
// The questions entry may take at most 1/N of the `input` attribute, leaving the rest for the input.
const DECISION_QUESTIONS_MAX_SHARE = 2;
// The API takes model names as `models/{model}`; pricing and dashboards key off the bare name.
const MODEL_RESOURCE_PREFIX = "models/";

/** The model name without the `models/` resource prefix, or undefined if not a non-empty string. */
function decisionModelName(model: unknown): string | undefined {
  if (typeof model !== "string" || !model) return undefined;
  return model.startsWith(MODEL_RESOURCE_PREFIX) ? model.slice(MODEL_RESOURCE_PREFIX.length) : model;
}

/**
 * Convert one input content block to a `{"role": "user", "content"}` entry, or undefined to skip it.
 *
 * Text blocks are recorded as their text. Media blocks (image, audio, video,
 * document) are recorded as JSON with their inline base64 `data` replaced by a
 * placeholder such as `[image]`; `uri` and `mime_type` are kept.
 */
function decisionInputEntry(block: unknown, maxContentLen: number): DecisionInputMessage | undefined {
  if (typeof block === "string") {
    return block ? { role: "user", content: sliceText(block, maxContentLen) } : undefined;
  }
  if (!isDict(block)) return undefined;

  const blockType = typeof block.type === "string" && block.type ? block.type : "text";
  if (blockType === "text") {
    const text = block.text;
    return typeof text === "string" && text
      ? { role: "user", content: sliceText(text, maxContentLen) }
      : undefined;
  }

  const { data, ...media } = block;
  const recorded: Record<string, unknown> = data !== undefined ? { ...media, data: `[${blockType}]` } : media;
  return { role: "user", content: asPromptContent(recorded, maxContentLen) };
}

/**
 * Build the `input` attribute JSON for a Gemini Decisions API request.
 *
 * `input` is the shared context every question is evaluated against: a string,
 * one content block, or an array of content blocks. Each becomes a `user`
 * entry. `questionsEntry`, the already-encoded questions entry, is appended
 * last so the questions read after the content they are asked about.
 *
 * The result never exceeds the attribute size limit. The questions entry's room
 * is set aside first, so a long input never pushes the questions out; each
 * input entry is then cut to the budget the earlier entries left and later
 * entries are dropped once it is used up, so the attribute stays valid JSON.
 *
 * @returns A JSON array of `{"role", "content"}` entries, or undefined when there is nothing to record.
 */
export function buildGeminiDecisionInput(input: unknown, questionsEntry?: string): string | undefined {
  const blocks: unknown[] = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input];

  const encodedEntries: string[] = [];
  let remaining = attributeMaxSize() - "[]".length;
  if (questionsEntry) remaining -= questionsEntry.length + JSON_ITEM_SEPARATOR.length;
  for (const block of blocks) {
    const budget = remaining - (encodedEntries.length > 0 ? JSON_ITEM_SEPARATOR.length : 0);
    if (budget <= 0) break;
    const entry = decisionInputEntry(block, budget);
    if (!entry) continue;
    const encoded = encodeEntryWithin(entry, budget);
    if (encoded === undefined) break;
    encodedEntries.push(encoded);
    remaining = budget - encoded.length;
  }

  if (questionsEntry) encodedEntries.push(questionsEntry);
  return encodedEntries.length > 0 ? joinJsonArray(encodedEntries) : undefined;
}

/**
 * Flatten a `{id: question-or-answer}` map into `[{"id": id, ...fields}]`, in key order.
 *
 * Questions and answers are keyed by caller-chosen IDs; carrying the ID inside
 * each item keeps answers matchable to their questions once both are arrays.
 * Values that are not objects are recorded under `value`.
 */
function keyedItems(map: Record<string, unknown>): Record<string, unknown>[] {
  return Object.entries(map).map(([id, value]) => (isDict(value) ? { id, ...value } : { id, value }));
}

/**
 * Encode the Decisions API `questions` as the `user` entry that ends the `input` attribute.
 *
 * Its `content` is a JSON array with one `{"id", "type", "instructions",
 * "criteria"}` object per question. The entry may use at most half the
 * attribute size, so the input the questions are about still has room; whole
 * questions are dropped from the end past that.
 *
 * @returns The encoded entry, or undefined when there are no questions to record.
 */
export function geminiDecisionQuestionsEntry(questions: unknown): string | undefined {
  if (!isDict(questions) || Object.keys(questions).length === 0) return undefined;
  const maxLen = Math.floor(attributeMaxSize() / DECISION_QUESTIONS_MAX_SHARE) - "[]".length;
  return itemsEntry(keyedItems(questions), DECISION_QUESTIONS_ROLE, maxLen);
}

/**
 * Record a Gemini Decisions API request on `span`, without ever failing the call.
 *
 * The model is always recorded (also as the response model, since the response
 * carries none and the span must be priceable). The input and questions are
 * caller content, so they are recorded as `input` only when content tracing is on.
 */
export function setDecisionRequestAttributes(span: Span, params: Record<string, unknown>): void {
  if (!span.isRecording()) return;

  span.setAttribute(SpanAttributes.LLM_REQUEST_TYPE, "decision");
  span.setAttribute(SpanAttributes.LLM_SYSTEM, "google_genai");
  const model = decisionModelName(params.model);
  if (model) {
    span.setAttribute(SpanAttributes.LLM_REQUEST_MODEL, model);
    span.setAttribute(SpanAttributes.LLM_RESPONSE_MODEL, model);
  }

  if (!isTraceContentEnabled()) return;

  let questionsEntry: string | undefined;
  try {
    questionsEntry = geminiDecisionQuestionsEntry(params.questions);
  } catch (error) {
    NetraLogger.warn("Failed to record Gemini decision questions:", error);
  }

  try {
    const inputJson = buildGeminiDecisionInput(params.input, questionsEntry);
    if (inputJson !== undefined) span.setAttribute(INPUT_ATTRIBUTE, inputJson);
  } catch (error) {
    NetraLogger.warn("Failed to record Gemini decision input:", error);
  }
}

function tokenCount(usage: Record<string, unknown>, key: string): number | undefined {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Record a Gemini Decisions API response on `span`, without ever failing the call.
 *
 * Token usage and, when the input was blocked, the block reason (as the finish
 * reason) are always recorded. The answers are recorded as `output` only when
 * content tracing is on: one assistant entry whose `content` is a JSON array of
 * `{"id", "type", ...}` answers, keeping only as many whole answers as fit.
 */
export function setDecisionResponseAttributes(span: Span, response: unknown): void {
  if (!span.isRecording() || !isDict(response)) return;

  try {
    const usage = response.usage;
    if (isDict(usage)) {
      const prompt = tokenCount(usage, "total_input_tokens");
      if (prompt !== undefined) span.setAttribute(SpanAttributes.LLM_USAGE_PROMPT_TOKENS, prompt);
      const output = [tokenCount(usage, "total_output_tokens"), tokenCount(usage, "total_thought_tokens")].filter(
        (n): n is number => n !== undefined,
      );
      if (output.length > 0) {
        span.setAttribute(SpanAttributes.LLM_USAGE_COMPLETION_TOKENS, output.reduce((a, b) => a + b, 0));
      }
      const total = tokenCount(usage, "total_tokens");
      if (total !== undefined) span.setAttribute(SpanAttributes.LLM_USAGE_TOTAL_TOKENS, total);
      const cached = tokenCount(usage, "total_cached_tokens");
      if (cached !== undefined) span.setAttribute(SpanAttributes.LLM_USAGE_CACHE_READ_INPUT_TOKENS, cached);
    }

    const feedback = response.prompt_feedback;
    if (isDict(feedback) && feedback.block_reason) {
      span.setAttribute(SpanAttributes.LLM_RESPONSE_FINISH_REASON, String(feedback.block_reason));
    }
  } catch (error) {
    NetraLogger.warn("Failed to record Gemini decision usage:", error);
  }

  const answers = response.answers;
  if (!isDict(answers) || Object.keys(answers).length === 0 || !isTraceContentEnabled()) return;
  try {
    const entry = itemsEntry(keyedItems(answers), DECISION_ANSWERS_ROLE, attributeMaxSize() - "[]".length);
    if (entry !== undefined) span.setAttribute(OUTPUT_ATTRIBUTE, joinJsonArray([entry]));
  } catch (error) {
    // Runs after the call succeeded; never cost the user their response.
    NetraLogger.warn("Failed to record Gemini decision answers:", error);
  }
}
