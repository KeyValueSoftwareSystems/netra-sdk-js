import {
  Span,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
} from "@opentelemetry/api";
import { Logger } from "../../logger";
import {
  isPromise,
  modelAsDict,
  shouldSuppressInstrumentation,
} from "../utils";
import { extractModelName, setRequestAttributes, setResponseAttributes } from "./utils";

type GoogleGenAIRequestType = "chat" | "embedding";

const CHAT_SPAN_NAME = "google_genai.chat";
const EMBEDDING_SPAN_NAME = "google_genai.embedding";

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
      const history = modelInstance.history as unknown | undefined;

      if(modelName) {
        kwargs.model = extractModelName(modelName);
      }
      if (systemInstruction) {
        kwargs.systemInstruction = systemInstruction;
      }
      if (history) {
        kwargs.history = history;
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
                  const duration = (endTime - startTime) / 1000;
                  span.setAttribute("llm.response.duration", duration);
                  span.setAttribute(
                    "gen_ai.performance.time_to_first_token",
                    duration,
                  );
                  span.setStatus({ code: SpanStatusCode.OK });
                  span.end();
                  return value;
                } catch (error) {
                  Logger.error("netra.instrumentation.google-genai:", error);
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
            Logger.error("netra.instrumentation.google-genai:", error);
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
      const history = modelInstance.history as unknown | undefined;

      if (modelName) kwargs.model = extractModelName(modelName);
      if (systemInstruction) kwargs.systemInstruction = systemInstruction;
      if (history) kwargs.history = history;

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
                  const duration = (endTime - startTime) / 1000;
                  span.setAttribute("llm.response.duration", duration);
                  span.setAttribute(
                    "gen_ai.performance.time_to_first_token",
                    duration,
                  );
                  span.setStatus({ code: SpanStatusCode.OK });
                  span.end();
                  return streamResult;
                }

                let chunkIndex = 0;
                let finalText = "";
                let firstTokenRecorded = false;

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

                            const duration = (endTime - startTime) / 1000;
                            span.setAttribute(
                              "llm.response.duration",
                              duration,
                            );
                            span.setStatus({ code: SpanStatusCode.OK });
                            span.end();
                            return res;
                          }

                          const chunk = res.value;

                          // Optional: store chunk-by-chunk attributes if you want
                          // span.setAttribute(`llm.stream.chunk.${chunkIndex}`, ...)
                          // Best-effort: accumulate chunk.text() if available
                          try {
                            const t =
                              typeof chunk?.text === "function"
                                ? chunk.text()
                                : chunk?.text;
                            if (typeof t === "string") {
                              if (t && !firstTokenRecorded) {
                                span.setAttribute(
                                  "gen_ai.performance.time_to_first_token",
                                  (Date.now() - startTime) / 1000,
                                );
                                firstTokenRecorded = true;
                              }
                              finalText += t;
                            }
                          } catch {
                            // ignore chunk parsing issues
                          }

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
                        const duration = (endTime - startTime) / 1000;
                        span.setAttribute("llm.response.duration", duration);
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
                Logger.error("netra.instrumentation.google-genai:", error);
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
            Logger.error("netra.instrumentation.google-genai:", error);
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

/**
 * Wraps startChat to instrument the returned ChatSession's sendMessage
 * and sendMessageStream methods with proper tracing.
 */
function googleGenAIStartChatWrapper(tracer: Tracer, spanName: string, requestType: GoogleGenAIRequestType) {
  const sendMessageWrapperFn = googleGenAIWrapper(tracer, spanName, requestType);
  const sendMessageStreamWrapperFn = googleGenAIStreamWrapper(tracer, spanName, requestType);

  return function wrapper<F extends (...args: any[]) => any>(original: F): F {
    return function (this: unknown, ...args: Parameters<F>): any {
      const chatSession = original.apply(this, args);
      if (!chatSession) return chatSession;

      const modelInstance = this as Record<string, unknown>;
      const modelName = modelInstance.model as string | undefined;
      const systemInstruction = modelInstance.systemInstruction as unknown | undefined;
      const chatHistory = (args[0] as Record<string, unknown> | undefined)?.history;

      if (typeof chatSession.sendMessage === "function" && !chatSession.__netra_patched) {
        const originalSendMessage = chatSession.sendMessage.bind(chatSession);
        const wrappedSendMessage = sendMessageWrapperFn(originalSendMessage);

        chatSession.sendMessage = function (this: unknown, ...sendArgs: any[]) {
          const ctx = this as Record<string, unknown>;
          if (modelName) ctx.model = modelName;
          if (systemInstruction) ctx.systemInstruction = systemInstruction;
          if (chatHistory) ctx.history = chatHistory;
          return wrappedSendMessage.apply(this, sendArgs);
        };

        if (typeof chatSession.sendMessageStream === "function") {
          const originalSendStream = chatSession.sendMessageStream.bind(chatSession);
          const wrappedSendStream = sendMessageStreamWrapperFn(originalSendStream);

          chatSession.sendMessageStream = function (this: unknown, ...sendArgs: any[]) {
            const ctx = this as Record<string, unknown>;
            if (modelName) ctx.model = modelName;
            if (systemInstruction) ctx.systemInstruction = systemInstruction;
            if (chatHistory) ctx.history = chatHistory;
            return wrappedSendStream.apply(this, sendArgs);
          };
        }

        chatSession.__netra_patched = true;
      }

      return chatSession;
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

export const startChatWrapper = (tracer: Tracer) =>
  googleGenAIStartChatWrapper(tracer, CHAT_SPAN_NAME, "chat");
