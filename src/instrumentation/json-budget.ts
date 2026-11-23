/**
 * Helpers for encoding span content as JSON within the attribute size limit.
 *
 * Content attributes (`input` / `output`) hold a JSON array of
 * `{"role", "content"}` entries. A cut JSON string is unreadable, so these
 * helpers shorten the content itself before encoding, keeping the attribute
 * valid JSON however large the content is.
 */
import { Config } from "../config";
import { safeStringify } from "../utils/serialization";

// Used when NETRA_SPAN_ATTRIBUTE_MAX_SIZE is not a positive number; matches Config's default.
const DEFAULT_ATTRIBUTE_MAX_SIZE = 30000;
// Separator `JSON.stringify` puts between array items; used when arrays are assembled from pre-encoded items.
export const JSON_ITEM_SEPARATOR = ",";

/** The attribute length limit content capture budgets against. */
export function attributeMaxSize(): number {
  const size = Config.SPAN_ATTRIBUTE_MAX_SIZE;
  return Number.isFinite(size) && size > 0 ? size : DEFAULT_ATTRIBUTE_MAX_SIZE;
}

/** Join already-encoded JSON values into a JSON array, formatted as `JSON.stringify` would. */
export function joinJsonArray(encodedItems: string[]): string {
  return "[" + encodedItems.join(JSON_ITEM_SEPARATOR) + "]";
}

/** Cut `text` to at most `maxLen` UTF-16 units without splitting a surrogate pair. */
export function sliceText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let end = Math.max(maxLen, 0);
  const lastCode = text.charCodeAt(end - 1);
  if (end > 0 && lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * JSON-encode `value` as valid JSON, whatever it holds.
 *
 * Functions, symbols and bigints become strings; anything `JSON.stringify`
 * still cannot encode is recorded as a JSON string of its `safeStringify` text.
 */
export function toJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "function") return `[Function: ${val.name || "anonymous"}]`;
      if (typeof val === "symbol") return val.toString();
      return val;
    });
    if (json !== undefined) return json;
  } catch {
    // Fall through to a string rendering below.
  }
  return JSON.stringify(safeStringify(value));
}

/**
 * JSON-encode `entry`, shortening its `content` until the encoding fits `maxLen`.
 *
 * Escaping makes the encoded content longer than the raw text (quotes,
 * backslashes and control characters), so the content is cut in proportion to
 * how far over the limit the encoding is and re-encoded.
 *
 * @returns The encoded entry, or undefined when not even an empty `content` fits.
 */
export function encodeEntryWithin<T extends { content: string }>(
  entry: T,
  maxLen: number,
): string | undefined {
  let content = entry.content;
  const overhead = JSON.stringify({ ...entry, content: "" }).length;
  if (overhead > maxLen) return undefined;
  const contentBudget = maxLen - overhead;
  for (;;) {
    const encoded = JSON.stringify({ ...entry, content });
    const encodedContentLen = encoded.length - overhead;
    if (encodedContentLen <= contentBudget) return encoded;
    const keep = Math.floor((content.length * contentBudget) / encodedContentLen);
    content = sliceText(content, Math.min(keep, content.length - 1));
  }
}
