import { jsonrepair } from "jsonrepair";
import { safeStringify } from "./safe-stringify";

const TRUNCATION_SUFFIX = "...[TRUNCATED]";
const JSON_MARKER_OVERHEAD = 30;
const MIN_JSON_TRUNCATION_LENGTH = JSON_MARKER_OVERHEAD + 20;
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

function injectTruncationMarker(parsed: unknown): void {
  if (Array.isArray(parsed)) {
    parsed.push({ __truncated__: true });
  } else if (typeof parsed === "object" && parsed !== null) {
    (parsed as Record<string, unknown>).__truncated__ = true;
  }
}

function truncateJsonValue(json: string, budget: number): string {
  const initialCut = budget - JSON_MARKER_OVERHEAD;
  const candidateLengths = [
    initialCut,
    ...RETRY_RATIOS.map((ratio) => Math.floor(initialCut * ratio)),
  ];

  for (const cutLen of candidateLengths) {
    if (cutLen <= 0) continue;

    try {
      const repaired = jsonrepair(json.slice(0, cutLen));
      const parsed: unknown = JSON.parse(repaired);
      injectTruncationMarker(parsed);

      const result = JSON.stringify(parsed);
      if (result.length <= budget) return result;
    } catch {
      continue;
    }
  }

  return truncatePlainString(json, budget);
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
      // In arrays, both `null` and`undefined` is serialized as `null`, 
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
    if (v == null) size += 4; // "null"
    else if (typeof v === "boolean") size += v ? 4 : 5;
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
