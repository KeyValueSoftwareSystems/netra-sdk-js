import {
  Span,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
} from "@opentelemetry/api";
import {
  isPromise,
  modelAsDict,
  shouldSuppressInstrumentation,
} from "../utils";
import { setRequestAttributes, setResponseAttributes } from "./utils";

type GoogleGenAIRequestType = "chat" | "embedding";

const CHAT_SPAN_NAME = "google_genai.chat";
const EMBEDDING_SPAN_NAME = "google_genai.embedding";

// (
//  request: GenerateContentRequest | string | Array<string | Part>,
//  requestOptions?: SingleRequestOptions,
//  ) => Promise<GenerateContentResult>,
function googleGenAIWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: GoogleGenAIRequestType,
) {
  return function wrapper<F extends (...args: any[]) => any>(original: F): F {
    return function (this: unknown, ...args: Parameters<F>): any {
      if (shouldSuppressInstrumentation()) {
        return original.apply(this, args);
      }
      let kwargs: Record<string, unknown> = {};

      const modelInstance = this as Record<string, unknown>;
      const modelName = modelInstance.model as string | undefined;
      const systemInstruction = modelInstance.systemInstruction as
        | unknown
        | undefined;

      if (modelName) {
        kwargs.model = modelName;
      }
      if (systemInstruction) {
        kwargs.systemInstruction = systemInstruction;
      }

      const currentContext = context.active();
      return tracer.startActiveSpan(
        spanName,
        {
          kind: SpanKind.CLIENT,
          attributes: { "llm.request.type": requestType },
        },
        currentContext,
        (span: Span) => {
          try {
            setRequestAttributes(span, kwargs, requestType, args[0]);
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
                    (endTime - startTime) / 1000,
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
                (endTime - startTime) / 1000,
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
        },
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
