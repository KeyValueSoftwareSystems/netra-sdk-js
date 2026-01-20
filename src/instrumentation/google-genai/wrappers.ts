import {
  Tracer,
  Span,
  SpanKind,
  SpanStatusCode,
  context,
} from "@opentelemetry/api";
import { setRequestAttributes, setResponseAttributes } from "./utils";
import {
  modelAsDict,
  isPromise,
  shouldSuppressInstrumentation,
} from "../utils";
import { SpanAttributes } from "../span-attributes";

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

function googleGenAIStreamWrapper(
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

      if (modelName) kwargs.model = modelName;
      if (systemInstruction) kwargs.systemInstruction = systemInstruction;

      const currentContext = context.active();

      return tracer.startActiveSpan(
        spanName,
        {
          kind: SpanKind.CLIENT,
          attributes: { "llm.request.type": requestType },
        },
        currentContext,
        (span: Span) => {
          const startTime = Date.now();

          try {
            setRequestAttributes(span, kwargs, requestType, args[0]);

            const response = original.apply(this, args);

            // generateContentStream() is async -> Promise<StreamResult>
            if (!isPromise(response)) {
              // If SDK changes to sync stream, still handle it safely
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return response;
            }

            return (async () => {
              try {
                const streamResult: any = await response;

                // Google GenAI stream result typically looks like:
                // { stream: AsyncIterable<Chunk>, response?: Promise<FinalResponse> }
                // We will wrap streamResult.stream so we can end span at completion.
                const originalStream: AsyncIterable<any> = streamResult.stream;

                if (
                  !originalStream ||
                  typeof originalStream[Symbol.asyncIterator] !== "function"
                ) {
                  // Not a real stream, treat like non-stream
                  const endTime = Date.now();
                  const responseDict = modelAsDict(streamResult);
                  setResponseAttributes(span, responseDict);
                  span.setAttribute(
                    "llm.response.duration",
                    (endTime - startTime) / 1000,
                  );
                  span.setStatus({ code: SpanStatusCode.OK });
                  span.end();
                  return streamResult;
                }

                let chunkIndex = 0;
                let finalText = "";

                const wrappedStream: AsyncIterable<any> = {
                  [Symbol.asyncIterator]() {
                    const iterator = originalStream[Symbol.asyncIterator]();
                    return {
                      async next() {
                        try {
                          const res = await iterator.next();

                          // res = { value, done }
                          if (res?.done) {
                            const endTime = Date.now();

                            // Await the response promise if available to get full metadata (token counts, etc.)
                            if (
                              streamResult.response &&
                              isPromise(streamResult.response)
                            ) {
                              try {
                                const finalResponse =
                                  await streamResult.response;
                                const responseDict = modelAsDict(finalResponse);
                                setResponseAttributes(span, responseDict);
                              } catch {
                                // If response promise fails, still set what we have from stream
                                const responseDict = modelAsDict(streamResult);
                                setResponseAttributes(span, responseDict);
                              }
                            } else {
                              // Fallback: set attributes from streamResult
                              const responseDict = modelAsDict(streamResult);
                              setResponseAttributes(span, responseDict);
                            }

                            span.setAttribute(
                              "llm.response.duration",
                              (endTime - startTime) / 1000,
                            );
                            span.setStatus({ code: SpanStatusCode.OK });
                            span.end();
                            return res;
                          }

                          const chunk = res.value;

                          // Best-effort: accumulate chunk.text() if available
                          try {
                            const t =
                              typeof chunk?.text === "function"
                                ? chunk.text()
                                : chunk?.text;
                            if (typeof t === "string") {
                              finalText += t;
                            }
                          } catch {
                            // ignore chunk parsing issues
                          }

                          // Optional: store chunk-by-chunk attributes if you want
                          // span.setAttribute(`llm.stream.chunk.${chunkIndex}`, ...)

                          chunkIndex += 1;
                          return res;
                        } catch (error) {
                          // End span on streaming error
                          span.setStatus({
                            code: SpanStatusCode.ERROR,
                            message:
                              error instanceof Error
                                ? error.message
                                : String(error),
                          });
                          span.recordException(error as Error);
                          span.end();
                          throw error;
                        }
                      },
                      async return() {
                        // Called if consumer stops early (break)
                        const endTime = Date.now();
                        span.setAttribute(
                          "llm.response.duration",
                          (endTime - startTime) / 1000,
                        );
                        span.setStatus({ code: SpanStatusCode.OK });
                        span.end();
                        return { value: undefined, done: true };
                      },
                    };
                  },
                };

                // Return same object but with wrapped stream
                return {
                  ...streamResult,
                  stream: wrappedStream,
                };
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

export const chatStreamWrapper = (tracer: Tracer) =>
  googleGenAIStreamWrapper(tracer, CHAT_SPAN_NAME, "chat");
