import { Span } from "@opentelemetry/api";
import { Config } from "../../config";
import { NetraLogger } from "../../netraLogger";
import { UsageModel } from "../../types";
import { safeStringify } from "../../utils/serialization";
import {
  isDict,
  isTraceContentEnabled,
  setRequestAttributes as setBaseRequestAttributes,
  setResponseAttributes as setBaseResponseAttributes,
  TracedMessage,
} from "../utils";

/** A provider-reported cost covers the whole call (prompt, completion, cache read and write). */
const PROVIDER_REPORTED_USAGE_TYPE = "total";
const CUSTOM_USAGE_ATTRIBUTE = `${Config.LIBRARY_NAME}.usage`;

const DECISION_REQUEST_TYPE = "decision";
// Decisions API (`client.decisions.create`): the questions asked about the input,
// recorded as one JSON array. The answers are recorded as the span's `output`.
export const GEN_AI_DECISION_QUESTIONS = "gen_ai.decision.questions";
// Structured conversation attributes: one JSON array of `{"role", "content"}` entries
// each, replacing the per-message indexed `gen_ai.prompt.N.*` / `gen_ai.completion.N.*` keys.
const INPUT_ATTRIBUTE = "input";
const OUTPUT_ATTRIBUTE = "output";
// Decision input item types that carry a tool invocation, mapped to the key holding its arguments.
const DECISION_TOOL_CALL_ARGUMENT_KEYS: Record<string, string> = {
  function_call: "arguments",
  custom_tool_call: "input",
};
const DECISION_TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
// A data URL's header (`data:<mime>;base64,`) is short; only this many leading
// characters are scanned for its comma so a large non-data-URL string is not walked.
const MAX_DATA_URL_HEADER_LEN = 256;

/** A decision input entry: tool calls and their outputs also carry the call id. */
type DecisionInputMessage = TracedMessage & { tool_call_id?: string };

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
 * Record a Decisions API request's input and questions without ever failing the call.
 *
 * Both are caller content, so nothing is recorded when content tracing is off.
 * This runs before the OpenAI call, so any failure is logged and the remaining
 * attributes are left unset instead of aborting the user's request.
 */
function setDecisionRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
): void {
  if (!isTraceContentEnabled()) return;

  try {
    const messages = buildDecisionInput(kwargs.input);
    if (messages.length > 0) {
      span.setAttribute(INPUT_ATTRIBUTE, safeStringify(messages));
    }
  } catch (error) {
    NetraLogger.warn("Failed to record OpenAI decision input:", error);
  }

  try {
    const questions = kwargs.questions;
    if (Array.isArray(questions) && questions.length > 0) {
      span.setAttribute(
        GEN_AI_DECISION_QUESTIONS,
        safeStringify(withoutInlineData(questions)),
      );
    }
  } catch (error) {
    NetraLogger.warn("Failed to record OpenAI decision questions:", error);
  }
}

/**
 * Build the input messages for a Decisions API request.
 *
 * `input` is either a string (recorded as one user message) or a list of
 * messages, function / custom tool calls and their outputs. Tool calls are
 * recorded as assistant entries holding `{"name", "arguments"}` and tool
 * outputs as `tool` entries; both carry their `call_id` as `tool_call_id`.
 */
export function buildDecisionInput(input: unknown): DecisionInputMessage[] {
  if (typeof input === "string") {
    return input.length > 0 ? [{ role: "user", content: input }] : [];
  }
  if (!Array.isArray(input)) return [];

  const messages: DecisionInputMessage[] = [];
  for (const item of input) {
    if (!isDict(item)) continue;
    const entry = decisionInputEntry(item);
    if (entry) messages.push(entry);
  }
  return messages;
}

/** Convert one Decisions API input item to a message, or undefined to skip it. */
function decisionInputEntry(
  item: Record<string, unknown>,
): DecisionInputMessage | undefined {
  const itemType = typeof item.type === "string" && item.type ? item.type : "message";
  let entry: DecisionInputMessage;

  if (itemType in DECISION_TOOL_CALL_ARGUMENT_KEYS) {
    const args = item[DECISION_TOOL_CALL_ARGUMENT_KEYS[itemType]] ?? "";
    entry = {
      role: "assistant",
      content: JSON.stringify({ name: item.name ?? "", arguments: args }),
    };
  } else if (DECISION_TOOL_OUTPUT_TYPES.has(itemType)) {
    if (!item.output) return undefined;
    entry = { role: "tool", content: asPromptContent(item.output) };
  } else {
    if (!item.content) return undefined;
    entry = {
      role: typeof item.role === "string" && item.role ? item.role : "user",
      content: asPromptContent(item.content),
    };
  }

  if (itemType !== "message" && typeof item.call_id === "string" && item.call_id) {
    entry.tool_call_id = item.call_id;
  }
  return entry;
}

/** Render message content as a string: text as-is, content parts as JSON with inline data elided. */
function asPromptContent(content: unknown): string {
  const elided = withoutInlineData(content);
  return typeof elided === "string" ? elided : safeStringify(elided);
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
 * base64 on the span. The caller's objects are never mutated.
 */
function withoutInlineData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return dataUrlPlaceholder(value) ?? value;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  let copy: unknown = value;
  if (Array.isArray(value)) {
    copy = value.map((item) => withoutInlineData(item, seen));
  } else if (isPlainObject(value)) {
    copy = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withoutInlineData(item, seen)]),
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
 * returned. Responses without an `answers` list (every other OpenAI API) are ignored.
 */
function setDecisionAnswerAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  const answers = response.answers;
  if (!Array.isArray(answers) || !isTraceContentEnabled()) return;

  try {
    span.setAttribute(
      OUTPUT_ATTRIBUTE,
      JSON.stringify([{ role: "assistant", content: safeStringify(answers) }]),
    );
  } catch (error) {
    // Runs after the call succeeded; never cost the user their response.
    NetraLogger.warn("Failed to record OpenAI decision answers:", error);
  }
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
