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

  const seen = new WeakSet<object>();
  let result: string;

  try {
    result = JSON.stringify(value, (_key, val) => {
      if (typeof val === "function")
        return `[Function: ${val.name || "anonymous"}]`;
      if (typeof val === "symbol") return val.toString();
      if (typeof val === "bigint") return val.toString();
      if (val !== null && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
        const name = val.constructor?.name;
        if (
          name &&
          name !== "Object" &&
          name !== "Array" &&
          Object.keys(val).length > 20
        ) {
          return `[${name}]`;
        }
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
