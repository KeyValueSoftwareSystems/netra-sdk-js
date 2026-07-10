const ELLIPSIS = "...";

function truncate(s: string, maxLength: number): string {
  if (s.length <= maxLength) return s;
  if (maxLength <= ELLIPSIS.length) return s.slice(0, maxLength);
  return s.slice(0, maxLength - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * Circular-reference-safe JSON.stringify with optional length truncation.
 *
 * - Strings pass through as-is (only truncated if over maxLength)
 * - Functions, symbols, bigints get descriptive placeholders
 * - Circular references become "[Circular]"
 * - Large class instances (>20 keys) become "[ClassName]"
 * - Result is truncated to `maxLength` when provided
 */
export function safeStringify(
  value: unknown,
  maxLength?: number,
): string {
  if (typeof value === "string") {
    if (maxLength && value.length > maxLength) {
      return truncate(value, maxLength);
    }
    return value;
  }

  const seen = new WeakSet<object>();
  let result: string;
  try {
    result = JSON.stringify(value, (_key, val) => {
      if (typeof val === "string" && maxLength && val.length > maxLength) {
        return truncate(val, maxLength);
      }
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
    }) ?? String(value);
  } catch {
    result =
      (value as any)?.constructor?.name
        ? `[${(value as any).constructor.name}]`
        : String(value);
  }

  if (maxLength && result.length > maxLength) {
    return truncate(result, maxLength);
  }
  return result;
}

/**
 * Convert any value to a string suitable for span attributes.
 * Primitives use `String()`, objects use `safeStringify`.
 */
export function serializeValue(
  value: unknown,
  maxLength?: number,
): string {
  if (value === null || value === undefined) return String(value);
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    const s = String(value);
    if (maxLength && s.length > maxLength) return truncate(s, maxLength);
    return s;
  }
  return safeStringify(value, maxLength);
}
