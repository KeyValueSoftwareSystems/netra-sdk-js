import { Span } from "@opentelemetry/api";
import { Config } from "../../config";
import { Logger } from "../../logger";
import { UsageModel } from "../../types";
import {
  setRequestAttributes as setBaseRequestAttributes,
  setResponseAttributes as setBaseResponseAttributes,
} from "../utils";

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
  setBaseRequestAttributes(span, kwargs, requestType, "openai");

  // Embeddings-only: output dimension hint
  if (kwargs.dimensions !== undefined) {
    span.setAttribute("gen_ai.request.dimensions", Number(kwargs.dimensions));
  }
}

/**
 * OpenAI-specific response attributes.
 * Delegates token/content handling to the shared base, then records
 * OpenRouter's provider-reported cost when `usage.cost` is present.
 */
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  if (!span.isRecording()) return;
  setBaseResponseAttributes(span, response);

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
    Logger.debug(
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
