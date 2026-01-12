import { context } from "@opentelemetry/api";

// Suppression key for instrumentation
const SUPPRESS_INSTRUMENTATION_KEY = Symbol("netra.suppress_instrumentation");

/**
 * Check if instrumentation should be suppressed
 */
export function shouldSuppressInstrumentation(): boolean {
  const ctx = context.active();
  return ctx.getValue(SUPPRESS_INSTRUMENTATION_KEY) === true;
}

/**
 * Converts a model or response value into a plain dictionary object.
 *
 * This utility is intended for normalizing SDK models, class instances,
 * or arbitrary values into a JSON-compatible key–value structure suitable
 * for logging, tracing, or serialization.
 *
 * Conversion strategy (in order):
 * 1. Non-objects return an empty object.
 * 2. Objects with a `toJSON()` method use its output.
 * 3. Plain objects are shallow-copied.
 * 4. Other objects are serialized via `JSON.stringify` / `JSON.parse`.
 *
 * If conversion fails, an empty object is returned.
 *
 * @param obj - The value to convert.
 * @returns A plain dictionary representation of the input.
 */
export function modelAsDict(obj: unknown): Record<string, unknown> {
  if (obj == null || typeof obj !== "object") {
    return {};
  }

  // Prefer explicit JSON serialization when available
  if (
    "toJSON" in obj &&
    typeof (obj as { toJSON?: unknown }).toJSON === "function"
  ) {
    return (obj as { toJSON: () => unknown }).toJSON() as Record<
      string,
      unknown
    >;
  }

  // Fast path for plain objects
  if (Object.getPrototypeOf(obj) === Object.prototype) {
    return { ...(obj as Record<string, unknown>) };
  }

  // Fallback: attempt structural serialization
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return {};
  }
}

/**
 * Type guard that determines whether a value is a Promise.
 *
 * This is useful for distinguishing between synchronous return values
 * and Promise-based (asynchronous) results at runtime.
 *
 * @param value - The value to test.
 * @returns `true` if the value is a Promise instance.
 */
export function isPromise<T = unknown>(value: unknown): value is Promise<T> {
  return value instanceof Promise;
}

/**
 * Determines whether a value is a plain json object.
 *
 * This intended for validating JSON-style objects at runtime
 *
 * Excludes:
 * - `null`
 * - Arrays
 *
 * @param v - The value to test.
 * @returns `true` if the value is a non-null, non-array object.
 */
export function isDict(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
