/**
 * Attribute extraction for TypeSafe `systemOne` calls.
 *
 * `systemOne` does not take chat messages: it evaluates a `state` (text, an
 * asset, or JSON) against a mapping of named `questions` and returns one answer
 * per question. Like the OpenAI Decisions API instrumentation, the call's
 * content is recorded only as the span's `input` and `output` attributes:
 *
 * - `input`: a JSON array of `{"role", "content"}` entries -- the state as a
 *   `user` entry, then a `user` entry whose `content` is the `questions`
 *   object exactly as sent, keyed by question name.
 * - `output`: a JSON array holding one `assistant` entry whose `content` is
 *   the `answers` object exactly as returned, keyed by question name.
 *
 * Neither is recorded when content tracing is off, and both are kept within
 * the configured attribute length while staying valid JSON. Image assets are
 * written as the opaque reference the SDK sends them under (their `toJSON`),
 * so image bytes never reach the span.
 */
import { Span } from "@opentelemetry/api";
import { Config } from "../../config";
import { NetraLogger } from "../../netraLogger";
import { SpanType } from "../../types";
import {
  attributeMaxSize,
  encodeEntryWithin,
  joinJsonArray,
  JSON_ITEM_SEPARATOR,
  toJson,
} from "../json-budget";
import { SpanAttributes } from "../span-attributes";
import { isDict, isTraceContentEnabled, modelAsDict } from "../utils";

export const GEN_AI_SYSTEM_TYPESAFE = "TypeSafe";
// "decision", as for the OpenAI Decisions API: systemOne answers questions
// about an input rather than generating text.
export const TYPESAFE_REQUEST_TYPE = "decision";
export const NETRA_SPAN_TYPE_ATTR = `${Config.LIBRARY_NAME}.span.type`;
export const ERROR_TYPE_ATTR = "error.type";
const INPUT_ATTRIBUTE = "input";
const OUTPUT_ATTRIBUTE = "output";

const STATE_ROLE = "user";
const QUESTIONS_ROLE = "user";
const ANSWERS_ROLE = "assistant";
// The questions entry may use at most 1/N of the attribute, so the state they
// are asked about always keeps room however many questions there are.
const QUESTIONS_MAX_SHARE = 2;

// --------------------------------------------------------------------------------------
// JSON encoding within a length budget
// --------------------------------------------------------------------------------------

/**
 * Encode `{"role": role, "content": "<JSON object of mapping>"}` in at most `maxLen` characters.
 *
 * The object's JSON is escaped again inside `content`, so each member is sized
 * as such. Only the leading members that fit are kept, whole, so `content`
 * stays valid JSON.
 *
 * @returns The encoded entry, or undefined when the mapping is empty or not even its first member fits.
 */
export function mappingEntryWithin(
  role: string,
  mapping: Record<string, unknown>,
  maxLen: number,
): string | undefined {
  let available = maxLen - JSON.stringify({ role, content: "{}" }).length;
  const kept: string[] = [];
  for (const [key, value] of Object.entries(mapping)) {
    const encoded = JSON.stringify(key) + ":" + toJson(value);
    const escapedLen = JSON.stringify(encoded).length - '""'.length;
    const cost = escapedLen + (kept.length > 0 ? JSON_ITEM_SEPARATOR.length : 0);
    if (cost > available) break;
    kept.push(encoded);
    available -= cost;
  }
  if (kept.length === 0) return undefined;
  return JSON.stringify({ role, content: "{" + kept.join(JSON_ITEM_SEPARATOR) + "}" });
}

/**
 * Render the state as text: strings as-is, values that serialise to a string
 * (an `Image`, or `withAssets` text) as that string, anything else as JSON.
 */
function stateAsText(state: unknown): string {
  if (typeof state === "string") return state;
  const toJSON = (state as { toJSON?: unknown } | null)?.toJSON;
  if (typeof toJSON === "function") {
    const serialised = toJSON.call(state);
    if (typeof serialised === "string") return serialised;
  }
  return toJson(state);
}

// --------------------------------------------------------------------------------------
// Request
// --------------------------------------------------------------------------------------

/** The `systemOne` request: `state`, `questions`, an optional `model` and `assets`. */
export function extractRequest(args: unknown[]): Record<string, unknown> {
  const request = args[0];
  return isDict(request) ? request : {};
}

/** Return the model the call will use: the per-call override, else the client default. */
export function resolveRequestModel(
  instance: unknown,
  request: Record<string, unknown>,
): string | undefined {
  if (request.model) return String(request.model);
  const defaultModel = (instance as { defaultModel?: unknown } | null)?.defaultModel;
  return defaultModel ? String(defaultModel) : undefined;
}

/**
 * Build the `input` attribute: the state entry, then the questions entry.
 *
 * The questions entry's room is set aside first (at most half the attribute),
 * so a long state never pushes the questions out; the state is then cut to
 * what is left.
 *
 * @returns A JSON array of `{"role", "content"}` entries, or undefined when there is nothing to record.
 */
export function buildInput(state: unknown, questions: unknown): string | undefined {
  const maxLen = attributeMaxSize();
  let remaining = maxLen - "[]".length;

  let questionsEntry: string | undefined;
  if (isDict(questions) && Object.keys(questions).length > 0) {
    questionsEntry = mappingEntryWithin(
      QUESTIONS_ROLE,
      questions,
      Math.floor(maxLen / QUESTIONS_MAX_SHARE) - "[]".length,
    );
    if (questionsEntry) remaining -= questionsEntry.length + JSON_ITEM_SEPARATOR.length;
  }

  const entries: string[] = [];
  if (state != null && state !== "") {
    // The state is first cut to the room left, which its encoding can never be
    // shorter than, so a multi-megabyte state is never encoded in full.
    const text = stateAsText(state).slice(0, Math.max(remaining, 0));
    const stateEntry = encodeEntryWithin({ role: STATE_ROLE, content: text }, remaining);
    if (stateEntry) entries.push(stateEntry);
  }
  if (questionsEntry) entries.push(questionsEntry);
  return entries.length > 0 ? joinJsonArray(entries) : undefined;
}

/**
 * Record the span type, the requested model, and the state and questions as `input`.
 *
 * Runs before the call and serialises caller content, so any failure is logged
 * rather than allowed to abort the user's request.
 */
export function setRequestAttributes(
  span: Span,
  instance: unknown,
  args: unknown[],
): void {
  if (!span.isRecording()) return;
  const request = extractRequest(args);
  try {
    span.setAttribute(NETRA_SPAN_TYPE_ATTR, SpanType.GENERATION);
    const model = resolveRequestModel(instance, request);
    if (model) span.setAttribute(SpanAttributes.LLM_REQUEST_MODEL, model);
  } catch (error) {
    NetraLogger.debug("Failed to set request attributes for TypeSafe span:", error);
  }

  if (!isTraceContentEnabled()) return;
  try {
    const inputJson = buildInput(request.state, request.questions);
    if (inputJson !== undefined) span.setAttribute(INPUT_ATTRIBUTE, inputJson);
  } catch (error) {
    NetraLogger.warn("Failed to record TypeSafe input:", error);
  }
}

// --------------------------------------------------------------------------------------
// Response
// --------------------------------------------------------------------------------------

/**
 * Build the `output` attribute: one assistant entry holding the `answers` object as returned.
 *
 * A response without an `answers` object has its body, minus the model and
 * usage already recorded elsewhere, recorded instead.
 *
 * @returns A JSON array with one `{"role", "content"}` entry, or undefined when nothing fits.
 */
export function buildOutput(response: Record<string, unknown>): string | undefined {
  let answers = response.answers;
  if (!isDict(answers)) {
    const { model: _model, usage: _usage, ...rest } = response;
    answers = rest;
  }
  const entry = mappingEntryWithin(
    ANSWERS_ROLE,
    answers as Record<string, unknown>,
    attributeMaxSize() - "[]".length,
  );
  return entry ? joinJsonArray([entry]) : undefined;
}

/** Record the response model, token usage, and the answers as `output`. */
export function setResponseAttributes(span: Span, response: unknown): void {
  if (!span.isRecording()) return;
  try {
    const responseDict = modelAsDict(response);

    if (responseDict.model) {
      span.setAttribute(SpanAttributes.LLM_RESPONSE_MODEL, String(responseDict.model));
    }

    const usage = responseDict.usage;
    if (isDict(usage)) {
      const inputTokens = usage.input_tokens;
      const outputTokens = usage.output_tokens;
      if (Number.isInteger(inputTokens)) {
        span.setAttribute(SpanAttributes.LLM_USAGE_PROMPT_TOKENS, inputTokens);
      }
      if (Number.isInteger(outputTokens)) {
        span.setAttribute(SpanAttributes.LLM_USAGE_COMPLETION_TOKENS, outputTokens);
      }
      if (Number.isInteger(inputTokens) && Number.isInteger(outputTokens)) {
        span.setAttribute(SpanAttributes.LLM_USAGE_TOTAL_TOKENS, inputTokens + outputTokens);
      }
    }

    if (isTraceContentEnabled()) {
      const outputJson = buildOutput(responseDict);
      if (outputJson !== undefined) span.setAttribute(OUTPUT_ATTRIBUTE, outputJson);
    }
  } catch (error) {
    // Runs after the call succeeded: never cost the user their response.
    NetraLogger.warn("Failed to record TypeSafe output:", error);
  }
}
