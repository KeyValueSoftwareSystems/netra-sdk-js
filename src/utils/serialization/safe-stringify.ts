export interface SafeStringifyOptions {
  maxLength?: number;
}

/**
 * Circular-reference-safe JSON serialization.
 *
 * Handles circular references, functions, symbols, bigints, and
 * large class instances gracefully. Never throws.
 *
 * When called without options, performs pure serialization with no truncation.
 * Pass `{ maxLength }` to enable hard truncation of the final result.
 */
const OVER_BUDGET = "[TRUNCATED]";
/** Class instances with more own keys than this are summarized as `[ClassName]`. */
const MAX_INSTANCE_KEYS = 20;

/** `[Buffer 1048576 bytes]` for binary data, otherwise undefined (JS-MEM-007). */
function describeBinary(val: unknown): string | undefined {
  if (val === null || typeof val !== "object") return undefined;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) return `[Buffer ${val.length} bytes]`;
  if (ArrayBuffer.isView(val)) return `[${val.constructor?.name ?? "TypedArray"} ${val.byteLength} bytes]`;
  if (val instanceof ArrayBuffer) return `[ArrayBuffer ${val.byteLength} bytes]`;
  return undefined;
}

/**
 * A shallow copy of `val` with binary children replaced by their description,
 * or `val` itself when it has none. Done while visiting the parent, because
 * JSON.stringify calls a Buffer's toJSON() (one array element per byte) before
 * the replacer ever sees the Buffer.
 */
function withBinaryChildrenDescribed(val: object): object {
  let copy: any;
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      const description = describeBinary(val[i]);
      if (description) {
        copy ??= val.slice();
        copy[i] = description;
      }
    }
    return copy ?? val;
  }
  for (const key of Object.keys(val)) {
    const description = describeBinary((val as any)[key]);
    if (description) {
      copy ??= { ...val };
      copy[key] = description;
    }
  }
  return copy ?? val;
}

/** True when `val` has more than `limit` enumerable keys, without listing them all. */
function hasMoreKeysThan(val: object, limit: number): boolean {
  let n = 0;
  for (const _ in val) {
    if (++n > limit) return true;
  }
  return false;
}

/**
 * Circular-reference-safe JSON serialization.
 *
 * Handles circular references, functions, symbols, bigints, binary data and
 * large class instances gracefully. Never throws.
 *
 * When called without options, performs pure serialization with no truncation.
 * Pass `{ maxLength }` to bound the work as well as the result: once roughly
 * `maxLength` characters have been produced, remaining values are replaced
 * with "[TRUNCATED]" instead of being walked, and the result is cut to
 * `maxLength` (JS-MEM-007, JS-PERF-012).
 */
export function safeStringify(value: unknown, options?: SafeStringifyOptions): string {
  const maxLength = options?.maxLength;

  if (typeof value === "string") {
    if (maxLength && value.length > maxLength) {
      return value.slice(0, maxLength);
    }
    return value;
  }

  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const t = typeof value;
  if (t === "number" || t === "boolean") return String(value);
  if (t === "bigint") return value.toString();
  if (t === "symbol") return (value as symbol).toString();
  if (t === "function") return `[Function: ${(value as Function).name || "anonymous"}]`;

  const binary = describeBinary(value);
  if (binary) return binary;

  const seen = new WeakSet<object>();
  let produced = 0;
  let result: string;

  try {
    result = JSON.stringify(value, function (this: any, key, val) {
      if (maxLength && produced > maxLength) return OVER_BUDGET;
      produced += key.length + 4;
      // `toJSON` has already run on `val`; the holder still has the original,
      // so a Buffer is caught here before it becomes an array of numbers.
      const original = key === "" ? value : this?.[key];
      const binaryVal = describeBinary(original);
      if (binaryVal) {
        produced += binaryVal.length;
        return binaryVal;
      }
      if (typeof val === "function")
        return `[Function: ${val.name || "anonymous"}]`;
      if (typeof val === "symbol") return val.toString();
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "string") {
        produced += val.length;
        if (maxLength && val.length > maxLength) return val.slice(0, maxLength);
        return val;
      }
      if (typeof val === "number" || typeof val === "boolean") {
        produced += 6;
        return val;
      }
      if (val !== null && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
        const name = val.constructor?.name;
        if (name && name !== "Object" && name !== "Array" && hasMoreKeysThan(val, MAX_INSTANCE_KEYS)) {
          return `[${name}]`;
        }
        return withBinaryChildrenDescribed(val);
      }
      return val;
    }) ?? "null";
  } catch {
    const name = (value as any)?.constructor?.name;
    result = name ? `[Unserializable: ${name}]` : "[Unserializable]";
  }

  if (maxLength && result.length > maxLength) {
    return result.slice(0, maxLength);
  }

  return result;
}
