import { Span } from "@opentelemetry/api";
import { Config } from "../../config";
import { NetraLogger } from "../../netraLogger";
import { UsageModel } from "../../types";
import {
  isDict,
  isTraceContentEnabled,
  setRequestAttributes as setBaseRequestAttributes,
  setResponseAttributes as setBaseResponseAttributes,
  TracedMessage,
} from "../utils";
import {
  attributeMaxSize,
  encodeEntryWithin,
  joinJsonArray,
  JSON_ITEM_SEPARATOR,
  sliceText,
  toJson,
} from "../json-budget";

const DECISION_REQUEST_TYPE = "decision";
// Structured conversation attributes: one JSON array of `{"role", "content"}` entries
// each, replacing the per-message indexed `gen_ai.prompt.N.*` / `gen_ai.completion.N.*` keys.
export const INPUT_ATTRIBUTE = "input";
export const OUTPUT_ATTRIBUTE = "output";
// Decision input item types that carry a tool invocation, mapped to the key holding its arguments.
const DECISION_TOOL_CALL_ARGUMENT_KEYS: Record<string, string> = {
  function_call: "arguments",
  custom_tool_call: "input",
};
const DECISION_TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
// A data URL's header (`data:<mime>;base64,`) is short; only this many leading
// characters are scanned for its comma so a large non-data-URL string is not walked.
const MAX_DATA_URL_HEADER_LEN = 256;
// Decisions API (`client.decisions.create`): the questions are recorded as the last
// `input` entry and the answers as the `output` entry, each holding a JSON array.
const DECISION_QUESTIONS_ROLE = "user";
const DECISION_ANSWERS_ROLE = "assistant";
// The questions entry may take at most 1/N of the `input` attribute, leaving the rest for the input items.
const DECISION_QUESTIONS_MAX_SHARE = 2;

/** A decision input entry: tool calls and their outputs also carry the call id. */
export type DecisionInputMessage = TracedMessage & { tool_call_id?: string };

/** A provider-reported cost covers the whole call (prompt, completion, cache read and write). */
const PROVIDER_REPORTED_USAGE_TYPE = "total";
const CUSTOM_USAGE_ATTRIBUTE = `${Config.LIBRARY_NAME}.usage`;

/**
 * OpenAI-specific request attributes.
 * Calls the shared base implementation with "openai" as the system identifier,
 * then adds any OpenAI-only fields.
 */
export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string,
): void {
  if (!span.isRecording()) return;

  if (requestType === DECISION_REQUEST_TYPE) {
    // The shared builder would record a decision `input` as one stringified user
    // message, so it gets the request without `input` and the content is recorded here.
    const { input: _input, questions: _questions, ...params } = kwargs;
    setBaseRequestAttributes(span, params, requestType, "openai");
    setDecisionRequestAttributes(span, kwargs);
    return;
  }

  setBaseRequestAttributes(span, kwargs, requestType, "openai");

  // Embeddings-only: output dimension hint
  if (kwargs.dimensions !== undefined) {
    span.setAttribute("gen_ai.request.dimensions", Number(kwargs.dimensions));
  }
}

/**
 * OpenAI-specific response attributes.
 * Delegates token/content handling to the shared base, then records
 * Decisions API answers and OpenRouter's provider-reported cost when present.
 */
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  if (!span.isRecording()) return;
  setBaseResponseAttributes(span, response);
  setDecisionAnswerAttributes(span, response);

  const usage = (response.usage ?? response.usage_metadata) as
    | Record<string, unknown>
    | undefined;
  if (!usage) return;

  const model = response.model || (response.response_metadata as any)?.model;
  setCustomUsageAttribute(span, usage, String(model ?? ""));
}

/**
 * Return true for a finite, non-negative number.
 * Rejects NaN, Infinity, negative values, booleans, and non-numbers.
 */
function isValidCost(value: unknown): value is number {
  if (typeof value === "boolean" || typeof value !== "number") return false;
  return Number.isFinite(value) && value >= 0;
}

/**
 * Resolve the USD cost a provider reported in `usage.cost` (e.g. OpenRouter).
 *
 * OpenRouter reports `cost` in credits, where one credit is one US dollar.
 * For BYOK calls (`is_byok` is true) `cost` is only OpenRouter's fee, so
 * `cost_details.upstream_inference_cost` is added to give the real spend.
 * For non-BYOK calls the upstream cost equals `cost` and is not added.
 *
 * @returns The cost in USD, or undefined when `cost` is absent or invalid,
 *          or when a BYOK call lacks a valid upstream cost. undefined means
 *          the backend should price the span from its token counts instead.
 */
function resolveProviderReportedCost(
  usage: Record<string, unknown>,
): number | undefined {
  const cost = usage.cost;
  if (!isValidCost(cost)) return undefined;

  if (usage.is_byok !== true) return cost;

  const costDetails = usage.cost_details;
  const upstreamCost =
    typeof costDetails === "object" && costDetails !== null
      ? (costDetails as Record<string, unknown>).upstream_inference_cost
      : undefined;

  if (!isValidCost(upstreamCost)) {
    NetraLogger.debug(
      "BYOK usage has no valid upstream_inference_cost; skipping provider-reported cost",
    );
    return undefined;
  }

  return cost + upstreamCost;
}

/**
 * Record a provider-reported cost as a single "total" Netra custom usage entry.
 *
 * Token counts are not repeated here (`units_used` is omitted from the JSON)
 * because they are already recorded as `gen_ai.usage.*` attributes.
 */
function setCustomUsageAttribute(
  span: Span,
  usage: Record<string, unknown>,
  model: string,
): void {
  const costInUsd = resolveProviderReportedCost(usage);
  if (costInUsd === undefined) return;

  const entry: Omit<UsageModel, "units_used"> = {
    model,
    usage_type: PROVIDER_REPORTED_USAGE_TYPE,
    cost_in_usd: costInUsd,
  };
  span.setAttribute(CUSTOM_USAGE_ATTRIBUTE, JSON.stringify([entry]));
}

/**
 * Record a Decisions API request's input and questions as `input`, without ever failing the call.
 *
 * Both are caller content, so nothing is recorded when content tracing is off.
 * This runs before the OpenAI call, so any failure is logged instead of
 * aborting the user's request; questions that cannot be serialised leave the
 * input items still recorded.
 */
function setDecisionRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
): void {
  if (!isTraceContentEnabled()) return;

  let questionsEntry: string | undefined;
  try {
    questionsEntry = decisionQuestionsEntry(kwargs.questions);
  } catch (error) {
    NetraLogger.warn("Failed to record OpenAI decision questions:", error);
  }

  try {
    const inputJson = buildDecisionInput(kwargs.input, questionsEntry);
    if (inputJson !== undefined) span.setAttribute(INPUT_ATTRIBUTE, inputJson);
  } catch (error) {
    NetraLogger.warn("Failed to record OpenAI decision input:", error);
  }
}

/**
 * Build the `input` attribute JSON for a Decisions API request.
 *
 * `input` is either a string (recorded as one user message) or a list of
 * messages, function / custom tool calls and their outputs. Tool calls are
 * recorded as assistant entries holding `{"name", "arguments"}` and tool
 * outputs as `tool` entries; both carry their `call_id` as `tool_call_id`.
 * `questionsEntry`, the already-encoded questions entry, is appended last so
 * the questions read after the content they are asked about.
 *
 * The result never exceeds the attribute size limit. The questions entry's
 * room is set aside first, so a long input never pushes the questions out;
 * each input entry's content is then cut to the budget the earlier entries
 * left over and later entries are dropped once it is used up, so the
 * attribute stays valid JSON and a multi-megabyte input is never encoded in full.
 *
 * @returns A JSON array of `{"role", "content"[, "tool_call_id"]}` entries,
 *          or undefined when there is nothing to record.
 */
export function buildDecisionInput(
  input: unknown,
  questionsEntry?: string,
): string | undefined {
  let items: unknown[] = [];
  if (typeof input === "string") {
    if (input.length > 0) items = [{ role: "user", content: input }];
  } else if (Array.isArray(input)) {
    items = input;
  }

  const encodedEntries: string[] = [];
  let remaining = attributeMaxSize() - "[]".length;
  if (questionsEntry) remaining -= questionsEntry.length + JSON_ITEM_SEPARATOR.length;
  for (const item of items) {
    const budget = remaining - (encodedEntries.length > 0 ? JSON_ITEM_SEPARATOR.length : 0);
    if (budget <= 0) break;
    if (!isDict(item)) continue;
    const entry = decisionInputEntry(item, budget);
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
 * Convert one Decisions API input item to a message, or undefined to skip it.
 * The message's `content` is at most `maxContentLen` characters long.
 */
function decisionInputEntry(
  item: Record<string, unknown>,
  maxContentLen: number,
): DecisionInputMessage | undefined {
  const itemType = typeof item.type === "string" && item.type ? item.type : "message";
  let entry: DecisionInputMessage;

  if (itemType in DECISION_TOOL_CALL_ARGUMENT_KEYS) {
    let args = item[DECISION_TOOL_CALL_ARGUMENT_KEYS[itemType]] ?? "";
    if (typeof args === "string") args = sliceText(args, maxContentLen);
    const call = toJson({ name: item.name ?? "", arguments: args });
    entry = { role: "assistant", content: sliceText(call, maxContentLen) };
  } else if (DECISION_TOOL_OUTPUT_TYPES.has(itemType)) {
    if (!item.output) return undefined;
    entry = { role: "tool", content: asPromptContent(item.output, maxContentLen) };
  } else {
    if (!item.content) return undefined;
    entry = {
      role: typeof item.role === "string" && item.role ? item.role : "user",
      content: asPromptContent(item.content, maxContentLen),
    };
  }

  if (itemType !== "message" && typeof item.call_id === "string" && item.call_id) {
    entry.tool_call_id = item.call_id;
  }
  return entry;
}

/**
 * Render message content as a string of at most `maxLen` characters.
 *
 * Text is kept as-is and content parts become JSON, with inline data elided
 * and at most `maxLen` characters of text across all parts kept before
 * anything is encoded.
 */
export function asPromptContent(content: unknown, maxLen: number): string {
  const elided = withoutInlineData(content, new CharBudget(maxLen));
  const rendered = typeof elided === "string" ? elided : toJson(elided);
  return sliceText(rendered, maxLen);
}

/**
 * How many leading items fit in a JSON array of at most `maxLen` characters.
 * `itemLengths` are the encoded length of each item; the array adds its
 * brackets and a separator between items.
 */
function fittingPrefixLen(itemLengths: number[], maxLen: number): number {
  let used = "[]".length;
  for (let count = 0; count < itemLengths.length; count++) {
    used += itemLengths[count] + (count > 0 ? JSON_ITEM_SEPARATOR.length : 0);
    if (used > maxLen) return count;
  }
  return itemLengths.length;
}

/**
 * JSON-encode `items` in order, stopping once they no longer fit a `maxLen` array.
 *
 * Inline data is elided first, and each item's text is copied only up to the
 * room left in the array, so no item costs more to encode than the attribute
 * could still hold. Items are kept whole: an item whose text alone uses up
 * that room cannot fit once encoded, so it and everything after it is left out.
 */
function encodeItemsWithin(items: unknown[], maxLen: number): string[] {
  const encoded: string[] = [];
  let used = "[]".length;
  for (const item of items) {
    const separatorLen = encoded.length > 0 ? JSON_ITEM_SEPARATOR.length : 0;
    const budget = new CharBudget(maxLen - used - separatorLen);
    const copy = withoutInlineData(item, budget);
    if (budget.remaining <= 0) break;
    const value = toJson(copy);
    used += value.length + separatorLen;
    if (used > maxLen) break;
    encoded.push(value);
  }
  return encoded;
}

/**
 * Encode `{"role": role, "content": "<JSON array of items>"}` in at most `maxLen` characters.
 *
 * The items' JSON is escaped again inside `content`, so each item is sized as
 * such and only the leading items that fit are kept, whole, so `content` stays
 * valid JSON.
 *
 * @returns The encoded entry, or undefined when `items` is non-empty and not
 *          even the first item fits.
 */
export function itemsEntry(items: unknown[], role: string, maxLen: number): string | undefined {
  const encoded = encodeItemsWithin(items, maxLen);
  const envelopeLen = JSON.stringify({ role, content: "" }).length;
  const escapedLengths = encoded.map((value) => JSON.stringify(value).length - '""'.length);
  const kept = encoded.slice(0, fittingPrefixLen(escapedLengths, maxLen - envelopeLen));
  if (items.length > 0 && kept.length === 0) return undefined;
  return JSON.stringify({ role, content: joinJsonArray(kept) });
}

/**
 * Encode the Decisions API `questions` as the `user` entry that ends the `input` attribute.
 *
 * Its `content` is the questions as a JSON array, recorded as given (`type`,
 * `instructions`, `name` and the `choices` / `levels` they offer) with inline
 * images in their instructions replaced by a placeholder. The entry may use at
 * most half the attribute size, so however many questions are asked the input
 * they are about still has room; whole questions are dropped from the end past that.
 *
 * @returns The encoded entry, or undefined when there are no questions to record.
 */
export function decisionQuestionsEntry(questions: unknown): string | undefined {
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const maxLen = Math.floor(attributeMaxSize() / DECISION_QUESTIONS_MAX_SHARE) - "[]".length;
  return itemsEntry(questions, DECISION_QUESTIONS_ROLE, maxLen);
}

/** Characters of string content one copy may still keep, shared across the whole walk. */
class CharBudget {
  constructor(public remaining: number) {}

  /** Return as much of `text` as the budget still allows, and charge it. */
  take(text: string): string {
    const kept = sliceText(text, this.remaining);
    this.remaining -= kept.length;
    return kept;
  }
}

/**
 * Return a short placeholder if `value` is a base64 data URL, else undefined.
 * `data:image/png;base64,...` becomes `[image]`; any other media type becomes `[file]`.
 */
function dataUrlPlaceholder(value: string): string | undefined {
  if (!value.startsWith("data:")) return undefined;
  const headerEnd = value.slice(0, MAX_DATA_URL_HEADER_LEN).indexOf(",");
  if (headerEnd === -1 || !value.slice(0, headerEnd).endsWith(";base64")) {
    return undefined;
  }
  return value.startsWith("data:image/") ? "[image]" : "[file]";
}

/**
 * Copy `value` with every base64 data URL replaced by a short placeholder.
 *
 * Image parts usually carry their bytes as base64 data URLs; serialising those
 * in full only for the attribute length limit to cut them leaves unreadable
 * base64 on the span. When a `budget` is given, all the strings in the copy
 * together keep at most that many characters, and array items past the point
 * it runs out are left out, so serialising the copy never encodes more text
 * than the attribute could hold, however the content is split into parts.
 * The caller's objects are never mutated.
 */
function withoutInlineData(
  value: unknown,
  budget?: CharBudget,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    const placeholder = dataUrlPlaceholder(value);
    if (placeholder !== undefined) {
      if (budget) budget.remaining -= placeholder.length;
      return placeholder;
    }
    return budget ? budget.take(value) : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  let copy: unknown = value;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      if (budget && budget.remaining <= 0) break;
      items.push(withoutInlineData(item, budget, seen));
    }
    copy = items;
  } else if (isPlainObject(value)) {
    copy = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withoutInlineData(item, budget, seen)]),
    );
  }
  seen.delete(value);
  return copy;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Record a Decisions API response's `answers`, in question order, as the span's `output`.
 *
 * `output` holds a single assistant entry whose `content` is the answers as a
 * JSON array; each answer is a predicate, choice, score or refusal object, as
 * returned. Only as many whole answers as fit the attribute size are kept
 * (counting the escaping the nested JSON needs), so the attribute stays valid
 * JSON. Nothing is recorded when not even one answer fits. Responses without
 * an `answers` list (every other OpenAI API) are ignored.
 */
function setDecisionAnswerAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  const answers = response.answers;
  if (!Array.isArray(answers) || !isTraceContentEnabled()) return;

  try {
    const entry = itemsEntry(answers, DECISION_ANSWERS_ROLE, attributeMaxSize() - "[]".length);
    if (entry !== undefined) span.setAttribute(OUTPUT_ATTRIBUTE, joinJsonArray([entry]));
  } catch (error) {
    // Runs after the call succeeded; never cost the user their response.
    NetraLogger.warn("Failed to record OpenAI decision answers:", error);
  }
}
