/**
 * Public helpers for distributed tracing context propagation.
 *
 * These utilities let users extract incoming W3C Trace Context from HTTP
 * headers and run code within that context so that all child spans (LLM
 * calls, database queries, outgoing HTTP, etc.) are linked to the upstream
 * trace.
 *
 * When `@opentelemetry/instrumentation-http` + `@opentelemetry/instrumentation-express`
 * are installed and working, incoming context extraction happens automatically.
 * These helpers cover cases where auto-instrumentation is unavailable (e.g.
 * ESM module loading order issues, missing peer dependencies, or non-Express
 * frameworks).
 */

import { context, propagation, Context } from "@opentelemetry/api";
import { Logger } from "../logger";

/**
 * Inject W3C trace context (traceparent/tracestate) from the currently active
 * span into a copy of the provided headers object.
 *
 * This is used internally by HTTP clients to propagate distributed trace
 * context on outgoing requests. The injection is best-effort — if propagation
 * fails for any reason, the original headers are returned unmodified.
 *
 * @param headers - Base headers to merge trace context into.
 * @returns A new headers object containing the original headers plus trace context.
 */
export function injectTraceContextHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const carrier: Record<string, string> = { ...headers };
  try {
    propagation.inject(context.active(), carrier);
  } catch {
    Logger.warn("netra: Failed to inject trace context headers");
    return headers;
  }
  return carrier;
}

/**
 * Extract an OpenTelemetry context from HTTP request headers.
 *
 * Handles the common Node.js header shapes -- plain strings, string arrays,
 * and `undefined` values -- and normalises keys to lower-case before passing
 * them to the global W3C propagator.
 *
 * @param headers - Incoming HTTP request headers (e.g. `req.headers`).
 * @returns An OTel `Context` carrying the extracted span context and baggage.
 */
export function extractContextFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): Context {
  const carrier: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      carrier[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      carrier[key.toLowerCase()] = value[0];
    }
  }
  return propagation.extract(context.active(), carrier);
}

/**
 * Run a function within a context extracted from HTTP headers.
 *
 * All spans created inside `fn` will be children of the trace described by the
 * incoming `traceparent` / `tracestate` headers, enabling end-to-end
 * distributed tracing across service boundaries.
 *
 * @param headers - Incoming HTTP request headers (e.g. `req.headers`).
 * @param fn      - The function to execute within the extracted context.
 *                  May be sync or async -- the return value is forwarded as-is.
 * @returns The return value of `fn`.
 *
 * @example
 * ```ts
 * import { runWithExtractedContext } from "netra";
 *
 * app.post("/api/chat", async (req, res) => {
 *   await runWithExtractedContext(req.headers, async () => {
 *     const result = await myAgent(req.body.message);
 *     res.json(result);
 *   });
 * });
 * ```
 */
export function runWithExtractedContext<T>(
  headers: Record<string, string | string[] | undefined>,
  fn: () => T,
): T {
  const extractedCtx = extractContextFromHeaders(headers);
  return context.with(extractedCtx, fn);
}

/**
 * Express/Connect-compatible middleware that extracts W3C Trace Context from
 * incoming request headers and runs all downstream handlers within the
 * extracted context.
 *
 * This is the recommended way to enable distributed tracing for Express
 * servers when `@opentelemetry/instrumentation-http` is not available or not
 * working (e.g. due to ESM module loading order with `tsx`). It is the
 * TypeScript equivalent of the Python SDK's `NetraFastAPIMiddleware`.
 *
 * **Note:** In Express 4.x, async errors thrown inside downstream handlers are
 * not automatically caught by the Express error handler. Wrap async route
 * handlers with your own try/catch or use Express 5 which supports async
 * error propagation natively.
 *
 * @returns An Express middleware function.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { netraExpressMiddleware } from "netra-sdk";
 *
 * const app = express();
 * app.use(netraExpressMiddleware());
 *
 * app.post("/api/chat", async (req, res) => {
 *   // Spans created here are children of the upstream trace
 *   const result = await myAgent(req.body.message);
 *   res.json(result);
 * });
 * ```
 */
export function netraExpressMiddleware(): (
  req: { headers: Record<string, string | string[] | undefined> },
  res: unknown,
  next: () => void,
) => void {
  return (req, _res, next) => {
    const extractedCtx = extractContextFromHeaders(req.headers);
    context.with(extractedCtx, next);
  };
}
