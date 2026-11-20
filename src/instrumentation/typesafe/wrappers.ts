import { Span, SpanKind, SpanStatusCode, Tracer } from "@opentelemetry/api";
import { SpanAttributes } from "../span-attributes";
import { isPromise, shouldSuppressInstrumentation } from "../utils";
import { wrapPromise } from "../../utils/response-handler";
import {
  ERROR_TYPE_ATTR,
  GEN_AI_SYSTEM_TYPESAFE,
  setRequestAttributes,
  setResponseAttributes,
  TYPESAFE_REQUEST_TYPE,
} from "./utils";

export const SYSTEM_ONE_SPAN_NAME = "typesafe.system_one";
const LLM_RESPONSE_DURATION = "llm.response.duration";

const SPAN_OPTIONS = {
  kind: SpanKind.CLIENT,
  attributes: {
    [SpanAttributes.LLM_SYSTEM]: GEN_AI_SYSTEM_TYPESAFE,
    [SpanAttributes.LLM_REQUEST_TYPE]: TYPESAFE_REQUEST_TYPE,
  },
};

export type WrapperFn = (
  wrapped: (...args: unknown[]) => unknown,
  instance: unknown,
  args: unknown[],
) => unknown;

function recordSuccess(span: Span, response: unknown, startTime: number): void {
  span.setAttribute(LLM_RESPONSE_DURATION, (Date.now() - startTime) / 1000);
  setResponseAttributes(span, response);
  span.setStatus({ code: SpanStatusCode.OK });
}

function recordFailure(span: Span, error: unknown): void {
  const errorType = (error as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  span.setAttribute(
    ERROR_TYPE_ATTR,
    error instanceof Error && typeof errorType === "string" ? errorType : typeof error,
  );
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Wrap `TypeSafeClient.systemOne` in a CLIENT span covering the call and its retries.
 *
 * `systemOne` returns the SDK's `APIPromise`, which is handed back as an
 * `APIPromise` (derived with its `map`), so `.asResponse()` and
 * `.withResponse()` keep working and the body is still parsed only once.
 */
export function systemOneWrapper(tracer: Tracer): WrapperFn {
  return (wrapped, instance, args) => {
    if (shouldSuppressInstrumentation()) {
      return wrapped.call(instance, ...args);
    }

    return tracer.startActiveSpan(SYSTEM_ONE_SPAN_NAME, SPAN_OPTIONS, (span) => {
      const startTime = Date.now();
      setRequestAttributes(span, instance, args);

      let result: unknown;
      try {
        result = wrapped.call(instance, ...args);
      } catch (error) {
        recordFailure(span, error);
        span.end();
        throw error;
      }

      if (!isPromise(result)) {
        recordSuccess(span, result, startTime);
        span.end();
        return result;
      }

      return wrapPromise(
        result,
        {
          withContext: (fn) => fn(),
          onSuccess: (value) => recordSuccess(span, value, startTime),
          onError: (error) => recordFailure(span, error),
          finalize: () => span.end(),
        },
        { deriveAPIPromise: true },
      );
    });
  };
}
