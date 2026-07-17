import { jsonrepair } from "jsonrepair";
import { safeStringify } from "./safe-stringify";
import { Logger } from "../../logger";

const TRUNCATION_SUFFIX = "...[TRUNCATED]";

const MINIMAL_TRUNCATED_OBJECT = '{"__truncated__":true}';
const MINIMAL_TRUNCATED_ARRAY = '[{"__truncated__":true}]';
const MIN_JSON_TRUNCATION_LENGTH = MINIMAL_TRUNCATED_ARRAY.length; // 24

const RETRY_RATIOS = [0.7, 0.5, 0.3];

export interface TruncatingSerializerConfig {
  maxAttributeSize: number;
}

const DEFAULT_CONFIG: TruncatingSerializerConfig = {
  maxAttributeSize: 30000,
};

function isJsonLike(str: string): boolean {
  const trimmed = str.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function minimalTruncatedJson(json: string): string {
  return json.trimStart().startsWith("[")
    ? MINIMAL_TRUNCATED_ARRAY
    : MINIMAL_TRUNCATED_OBJECT;
}

function injectTruncationMarker(parsed: unknown): void {
  if (Array.isArray(parsed)) {
    parsed.push({ __truncated__: true });
  } else if (typeof parsed === "object" && parsed !== null) {
    (parsed as Record<string, unknown>).__truncated__ = true;
  }
}

function tryRepairAndFit(
  json: string,
  cutLen: number,
  budget: number,
): string | null {
  if (cutLen <= 0) return null;
  try {
    const repaired = jsonrepair(json.slice(0, cutLen));
    const parsed: unknown = JSON.parse(repaired);
    injectTruncationMarker(parsed);
    const result = JSON.stringify(parsed);
    if (result.length <= budget) return result;
  } catch {
    Logger.debug("Failed to repair and fit JSON at cut length", {
      length: json.length,
      cutLength: cutLen,
    });
  }
  return null;
}

function truncateJsonValue(json: string, budget: number): string {
  const minimal = minimalTruncatedJson(json);
  if (budget < minimal.length) {
    return truncatePlainString(json, budget);
  }

  // Estimate overhead: the marker itself plus structural chars added by jsonrepair.
  // Use a generous estimate to leave room for repair expansion.
  const overhead = Math.max(30, Math.ceil(budget * 0.05));
  const initialCut = budget - overhead;

  // Phase 1: fixed ratio candidates (coarse)
  const candidateLengths = [
    initialCut,
    ...RETRY_RATIOS.map((ratio) => Math.floor(initialCut * ratio)),
  ];

  for (const cutLen of candidateLengths) {
    const result = tryRepairAndFit(json, cutLen, budget);
    if (result !== null) return result;
  }

  // Phase 2: binary search for the largest cut that fits
  let lo = 1;
  let hi = Math.max(1, Math.floor(initialCut * 0.1));
  let bestResult: string | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const result = tryRepairAndFit(json, mid, budget);
    if (result !== null) {
      bestResult = result;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (bestResult !== null) return bestResult;

  return minimal;
}

function truncatePlainString(str: string, maxLen: number): string {
  if (maxLen <= TRUNCATION_SUFFIX.length) {
    return str.slice(0, maxLen);
  }
  return str.slice(0, maxLen - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

function truncateString(value: string, budget: number): string {
  if (value.length <= budget) return value;

  if (isJsonLike(value) && budget >= MIN_JSON_TRUNCATION_LENGTH) {
    return truncateJsonValue(value, budget);
  }

  return truncatePlainString(value, budget);
}

export type SerializedAttributeValue =
  | string
  | number
  | boolean
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>;

/**
 * Serializes and truncates a single span attribute value.
 *
 * - Numbers and booleans pass through unchanged (they're always small).
 * - Strings are truncated using jsonrepair-based truncation (for JSON)
 *   or `...[TRUNCATED]` suffix (for plain strings).
 * - Homogeneous primitive arrays (number[], boolean[], string[]) are
 *   kept as native OTel arrays when their serialized form fits within
 *   the budget; otherwise they are serialized to a JSON string and truncated.
 * - Everything else is serialized via safeStringify then truncated.
 *
 * This is the single source of truth for attribute size enforcement.
 */
export function serializeAttribute(
  value: unknown,
  maxSize: number,
): SerializedAttributeValue {
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value, maxSize);
  }

  if (Array.isArray(value)) {
    if (value.every((v) => v == null || typeof v === "number")) {
      const serializedLen = estimateArraySize(value);
      if (serializedLen <= maxSize) {
        return value as Array<null | undefined | number>;
      }
    } else if (value.every((v) => v == null || typeof v === "boolean")) {
      const serializedLen = estimateArraySize(value);
      if (serializedLen <= maxSize) {
        return value as Array<null | undefined | boolean>;
      }
    } else if (value.every((v) => v == null || typeof v === "string")) {
      // `s == null` intentionally matches both `null` and `undefined`.
      // In arrays, both `null` and `undefined` are serialized as `null`,
      // so both contribute 4 characters.
      const serializedLen = value.reduce(
        (sum, s) => sum + (s == null ? 4 : (s as string).length + 2),
        2 + Math.max(0, value.length - 1),
      );
      if (serializedLen <= maxSize) {
        return value as Array<null | undefined | string>;
      }
    }
  }

  const serialized = safeStringify(value);
  return truncateString(serialized, maxSize);
}

function estimateArraySize(arr: unknown[]): number {
  let size = 2; // [ ]
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) size += 1; // comma
    const v = arr[i];
    // Check to handle null and undefined, since both are serialized as null.
    // Without this check, length of undefined is 9, which is longer than the length of null.
    if (v == null) size += 4;
    else size += String(v).length;
  }
  return size;
}

export class TruncatingSerializer {
  private readonly maxAttributeSize: number;

  constructor(config?: Partial<TruncatingSerializerConfig>) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    this.maxAttributeSize = merged.maxAttributeSize;
  }

  serializeAttribute(
    value: unknown,
    budget?: number,
  ): SerializedAttributeValue {
    return serializeAttribute(value, budget ?? this.maxAttributeSize);
  }
}
