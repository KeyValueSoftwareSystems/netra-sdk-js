import { Tracer, Span, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { setRequestAttributes, setResponseAttributes } from "./utils";
import {
  modelAsDict,
  isPromise,
  shouldSuppressInstrumentation,
} from "../utils";

type GoogleGenAIRequestType = "chat" | "embedding";

const CHAT_SPAN_NAME = "google_genai.chat";
const EMBEDDING_SPAN_NAME = "google_genai.embedding";

function googleGenAIWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: GoogleGenAIRequestType
) {
  return function wrapper<F extends (...args: any[]) => any>(original: F): F {
    return function (this: unknown, ...args: Parameters<F>): any {
      if (shouldSuppressInstrumentation()) {
        return original.apply(this, args);
      }

      const kwargs = (args[0] || {}) as Record<string, unknown>;

      return tracer.startActiveSpan(
        spanName,
        {
          kind: SpanKind.CLIENT,
          attributes: { "llm.request.type": requestType },
        },
        (span: Span) => {
          try {
            setRequestAttributes(span, kwargs, requestType);
            const startTime = Date.now();
            const response = original.apply(this, args);

            if (isPromise(response)) {
              return (async () => {
                try {
                  const value = await response;
                  const endTime = Date.now();
                  const responseDict = modelAsDict(value);
                  setResponseAttributes(span, responseDict);
                  span.setAttribute(
                    "llm.response.duration",
                    (endTime - startTime) / 1000
                  );
                  span.setStatus({ code: SpanStatusCode.OK });
                  span.end();
                  return value;
                } catch (error) {
                  console.error("netra.instrumentation.google-genai:", error);
                  span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
                  span.recordException(error as Error);
                  span.end();
                  throw error;
                }
              })();
            } else {
              const endTime = Date.now();
              const responseDict = modelAsDict(response);
              setResponseAttributes(span, responseDict);
              span.setAttribute(
                "llm.response.duration",
                (endTime - startTime) / 1000
              );
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return response;
            }
          } catch (error) {
            console.error("netra.instrumentation.google-genai:", error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
            span.recordException(error as Error);
            span.end();
            throw error;
          }
        }
      );
    } as unknown as F;
  };
}

/* Specific wrappers for different requests */
export const chatWrapper = (tracer: Tracer) =>
  googleGenAIWrapper(tracer, CHAT_SPAN_NAME, "chat");

export const embeddingsWrapper = (tracer: Tracer) =>
  googleGenAIWrapper(tracer, EMBEDDING_SPAN_NAME, "embedding");

// Streaming wrapper for Google GenAI can be added later if needed.
// Google GenAI's generateContentStream returns an object with a 'stream' property which is an AsyncIterable.
