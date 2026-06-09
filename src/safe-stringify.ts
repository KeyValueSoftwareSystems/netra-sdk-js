/**
 * Safe JSON serialization that handles circular references, non-serializable
 * Node.js objects, and all JavaScript value types without throwing.
 *
 * Uses ancestor-path tracking (Set + add/delete) instead of a flat WeakSet so
 * that shared references (the same object reachable via two different paths)
 * are serialized in full at each location — only true cycles produce the
 * "[Circular]" placeholder.
 */

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_STRING_LENGTH = 8_192;
const DEFAULT_MAX_ARRAY_LENGTH = 100;
const DEFAULT_MAX_KEYS = 128;
const DEFAULT_MAX_OUTPUT_LENGTH = 65_536;

export interface SafeStringifyOptions {
  maxDepth?: number;
  maxStringLength?: number;
  maxArrayLength?: number;
  maxKeys?: number;
  maxOutputLength?: number;
}

function escapeString(s: string): string {
  return JSON.stringify(s);
}

function truncatedString(s: string, max: number): string {
  if (s.length <= max) return escapeString(s);
  return escapeString(s.slice(0, max) + "…[truncated]");
}

function serializeMap(
  map: Map<unknown, unknown>,
  depth: number,
  ancestors: Set<object>,
  opts: Required<SafeStringifyOptions>,
): string {
  ancestors.add(map);
  try {
    const entries: string[] = [];
    let count = 0;
    for (const [k, v] of map) {
      if (count >= opts.maxKeys) {
        entries.push(`"…":"${map.size - count} more entries"`);
        break;
      }
      const keyStr = typeof k === "string" ? k : String(k);
      entries.push(
        `${escapeString(keyStr)}:${serialize(v, depth + 1, ancestors, opts)}`,
      );
      count++;
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(map);
  }
}

function serializeSet(
  set: Set<unknown>,
  depth: number,
  ancestors: Set<object>,
  opts: Required<SafeStringifyOptions>,
): string {
  ancestors.add(set);
  try {
    const items: string[] = [];
    let count = 0;
    for (const item of set) {
      if (count >= opts.maxArrayLength) {
        items.push(`"…${set.size - count} more items"`);
        break;
      }
      items.push(serialize(item, depth + 1, ancestors, opts));
      count++;
    }
    return `[${items.join(",")}]`;
  } finally {
    ancestors.delete(set);
  }
}

function serializeError(
  err: Error,
  depth: number,
  ancestors: Set<object>,
  opts: Required<SafeStringifyOptions>,
): string {
  ancestors.add(err);
  try {
    const parts: string[] = [];
    parts.push(`"name":${escapeString(err.name)}`);
    parts.push(`"message":${escapeString(err.message)}`);
    if (err.stack) {
      const brief = err.stack.split("\n").slice(0, 5).join("\n");
      parts.push(`"stack":${escapeString(brief)}`);
    }
    if ("code" in err) {
      parts.push(
        `"code":${serialize((err as any).code, depth + 1, ancestors, opts)}`,
      );
    }
    for (const key of Object.keys(err)) {
      if (["name", "message", "stack", "code"].includes(key)) continue;
      try {
        parts.push(
          `${escapeString(key)}:${serialize((err as any)[key], depth + 1, ancestors, opts)}`,
        );
      } catch {
        parts.push(`${escapeString(key)}:"[Access error]"`);
      }
    }
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.delete(err);
  }
}

function serializeArray(
  arr: unknown[],
  depth: number,
  ancestors: Set<object>,
  opts: Required<SafeStringifyOptions>,
): string {
  ancestors.add(arr);
  try {
    const items: string[] = [];
    const len = Math.min(arr.length, opts.maxArrayLength);
    for (let i = 0; i < len; i++) {
      items.push(serialize(arr[i], depth + 1, ancestors, opts));
    }
    if (arr.length > opts.maxArrayLength) {
      items.push(`"…${arr.length - opts.maxArrayLength} more items"`);
    }
    return `[${items.join(",")}]`;
  } finally {
    ancestors.delete(arr);
  }
}

function serializeObject(
  obj: object,
  depth: number,
  ancestors: Set<object>,
  opts: Required<SafeStringifyOptions>,
): string {
  // Honour custom toJSON (e.g. Date sub-classes, Mongoose docs)
  if (typeof (obj as any).toJSON === "function") {
    try {
      return serialize((obj as any).toJSON(), depth, ancestors, opts);
    } catch {
      /* fall through to generic handling */
    }
  }

  ancestors.add(obj);
  try {
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch {
      return `"[Object: keys inaccessible]"`;
    }

    const entries: string[] = [];
    let count = 0;
    for (const key of keys) {
      if (count >= opts.maxKeys) {
        entries.push(`"…":"${keys.length - count} more keys"`);
        break;
      }
      try {
        const val = (obj as any)[key];
        entries.push(
          `${escapeString(key)}:${serialize(val, depth + 1, ancestors, opts)}`,
        );
      } catch {
        entries.push(`${escapeString(key)}:"[Access error]"`);
      }
      count++;
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(obj);
  }
}

function serialize(
  val: unknown,
  depth: number,
  ancestors: Set<object>,
  opts: Required<SafeStringifyOptions>,
): string {
  if (val === null) return "null";
  if (val === undefined) return "null";

  switch (typeof val) {
    case "string":
      return truncatedString(val, opts.maxStringLength);
    case "number":
      return Number.isFinite(val) ? String(val) : "null";
    case "boolean":
      return String(val);
    case "bigint":
      return `"${val.toString()}"`;
    case "symbol":
      return `"${val.toString()}"`;
    case "function":
      return `"[Function: ${val.name || "anonymous"}]"`;
    case "object":
      break;
    default:
      return escapeString(String(val));
  }

  if (ancestors.has(val)) return `"[Circular]"`;
  if (depth >= opts.maxDepth) return `"[MaxDepth]"`;

  // Date
  if (val instanceof Date) {
    return Number.isNaN(val.getTime())
      ? `"[Invalid Date]"`
      : escapeString(val.toISOString());
  }

  // RegExp
  if (val instanceof RegExp) return escapeString(val.toString());

  // Error (before generic object so we capture name/message/stack)
  if (val instanceof Error) return serializeError(val, depth, ancestors, opts);

  // Buffer (Node.js)
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) {
    const preview =
      val.length <= 64
        ? val.toString("hex")
        : val.subarray(0, 64).toString("hex") + "…";
    return `"[Buffer ${val.length}B: ${preview}]"`;
  }

  // TypedArrays / ArrayBuffer
  if (ArrayBuffer.isView(val))
    return `"[${val.constructor.name}: ${val.byteLength} bytes]"`;
  if (val instanceof ArrayBuffer)
    return `"[ArrayBuffer: ${val.byteLength} bytes]"`;
  if (typeof SharedArrayBuffer !== "undefined" && val instanceof SharedArrayBuffer)
    return `"[SharedArrayBuffer: ${val.byteLength} bytes]"`;

  // Promise, WeakMap, WeakSet — opaque by design
  if (val instanceof Promise) return `"[Promise]"`;
  if (val instanceof WeakMap) return `"[WeakMap]"`;
  if (val instanceof WeakSet) return `"[WeakSet]"`;

  // Map → object-like output
  if (val instanceof Map) return serializeMap(val, depth, ancestors, opts);

  // Set → array-like output
  if (val instanceof Set) return serializeSet(val, depth, ancestors, opts);

  // Array
  if (Array.isArray(val)) return serializeArray(val, depth, ancestors, opts);

  // Generic object
  return serializeObject(val, depth, ancestors, opts);
}

/**
 * Safely serializes any JavaScript value to a JSON string.
 *
 * Handles circular references, Buffers, Maps, Sets, Errors, Dates,
 * BigInts, Symbols, Functions, Streams, Sockets, and all other types
 * without throwing.
 *
 * @param value  The value to serialize.
 * @param options  Either a `SafeStringifyOptions` object or a plain number
 *                 treated as `maxOutputLength` for backward compatibility.
 */
export function safeJsonStringify(
  value: unknown,
  options?: SafeStringifyOptions | number,
): string {
  const opts: Required<SafeStringifyOptions> =
    typeof options === "number"
      ? {
          maxDepth: DEFAULT_MAX_DEPTH,
          maxStringLength: DEFAULT_MAX_STRING_LENGTH,
          maxArrayLength: DEFAULT_MAX_ARRAY_LENGTH,
          maxKeys: DEFAULT_MAX_KEYS,
          maxOutputLength: options,
        }
      : {
          maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
          maxStringLength: options?.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
          maxArrayLength: options?.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
          maxKeys: options?.maxKeys ?? DEFAULT_MAX_KEYS,
          maxOutputLength:
            options?.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH,
        };

  try {
    const result = serialize(value, 0, new Set<object>(), opts);
    if (result.length > opts.maxOutputLength) {
      return result.slice(0, opts.maxOutputLength);
    }
    return result;
  } catch (e) {
    return escapeString(
      `[Serialization failed: ${e instanceof Error ? e.message : String(e)}]`,
    );
  }
}

/**
 * Convenience wrapper that serializes any value into a human-friendly
 * string suitable for span attributes. Primitives are returned directly
 * as strings; objects go through `safeJsonStringify`.
 */
export function serializeValue(value: unknown, maxLength = 1000): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    const s = String(value);
    return s.length > maxLength ? s.slice(0, maxLength) : s;
  }
  return safeJsonStringify(value, maxLength);
}
