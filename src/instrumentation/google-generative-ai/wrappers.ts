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

type GoogleGenerativeAIRequestType = "chat" | "embedding";

const CHAT_SPAN_NAME = "google_generative_ai.chat";
const EMBEDDING_SPAN_NAME = "google_generative_ai.embedding";

const patchedSessions = new Set<any>();

function googleGenerativeAIWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: GoogleGenerativeAIRequestType,
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
      const generationConfig = modelInstance.generationConfig as
        | Record<string, unknown>
        | undefined;
      const safetySettings = modelInstance.safetySettings as unknown | undefined;
      const tools = modelInstance.tools as unknown | undefined;
      const toolConfig = modelInstance.toolConfig as unknown | undefined;

      if(modelName) {
        kwargs.model = extractModelName(modelName);
      }
      if (systemInstruction) {
        kwargs.systemInstruction = systemInstruction;
      }
      if (history) {
        kwargs.history = history;
      }
      if (generationConfig) {
        kwargs.generationConfig = generationConfig;
      }
      if (safetySettings) {
        kwargs.safetySettings = safetySettings;
      }
      if (tools) {
        kwargs.tools = tools;
      }
      if (toolConfig) {
        kwargs.toolConfig = toolConfig;
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
            try {
              setRequestAttributes(span, kwargs, requestType, args[0]);
            } catch (e) {
              Logger.error("netra.instrumentation.google-generative-ai:", e);
            }
            const startTime = Date.now();
            const response = original.apply(this, args);

            if (isPromise(response)) {
              return (async () => {
                try {
                  const value = await response;
                  try {
                    const endTime = Date.now();
                    const responseDict = modelAsDict(value);
                    setResponseAttributes(span, responseDict);
                    const duration = (endTime - startTime) / 1000;
                    span.setAttribute("llm.response.duration", duration);
                    if (requestType !== "embedding") {
                      span.setAttribute(
                        "gen_ai.performance.time_to_first_token",
                        duration,
                      );
                    }
                  } catch (e) {
                    Logger.error("netra.instrumentation.google-generative-ai:", e);
                  }
                  span.setStatus({ code: SpanStatusCode.OK });
                  span.end();
                  return value;
                } catch (error) {
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
              try {
                const endTime = Date.now();
                const responseDict = modelAsDict(response);
                setResponseAttributes(span, responseDict);
                span.setAttribute(
                  "llm.response.duration",
                  (endTime - startTime) / 1000,
                );
              } catch (e) {
                Logger.error("netra.instrumentation.google-generative-ai:", e);
              }
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return response;
            }
          } catch (error) {
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

function googleGenerativeAIStreamWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: GoogleGenerativeAIRequestType,
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
      const generationConfig = modelInstance.generationConfig as
        | Record<string, unknown>
        | undefined;
      const safetySettings = modelInstance.safetySettings as unknown | undefined;
      const tools = modelInstance.tools as unknown | undefined;
      const toolConfig = modelInstance.toolConfig as unknown | undefined;

      if (modelName) kwargs.model = extractModelName(modelName);
      if (systemInstruction) kwargs.systemInstruction = systemInstruction;
      if (history) kwargs.history = history;
      if (generationConfig) kwargs.generationConfig = generationConfig;
      if (safetySettings) kwargs.safetySettings = safetySettings;
      if (tools) kwargs.tools = tools;
      if (toolConfig) kwargs.toolConfig = toolConfig;

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
            try {
              setRequestAttributes(span, kwargs, requestType, args[0]);
            } catch (e) {
              Logger.error("netra.instrumentation.google-generative-ai:", e);
            }

            const response = original.apply(this, args);

            // generateContentStream() is async -> Promise<StreamResult>
            if (!isPromise(response)) {
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return response;
            }

            return (async () => {
              try {
                const streamResult: any = await response;

                const originalStream: AsyncIterable<any> = streamResult.stream;

                if (
                  !originalStream ||
                  typeof originalStream[Symbol.asyncIterator] !== "function"
                ) {
                  try {
                    const endTime = Date.now();
                    const responseDict = modelAsDict(streamResult);
                    setResponseAttributes(span, responseDict);
                    const duration = (endTime - startTime) / 1000;
                    span.setAttribute("llm.response.duration", duration);
                    span.setAttribute(
                      "gen_ai.performance.time_to_first_token",
                      duration,
                    );
                  } catch (e) {
                    Logger.error("netra.instrumentation.google-generative-ai:", e);
                  }
                  span.setStatus({ code: SpanStatusCode.OK });
                  span.end();
                  return streamResult;
                }

                let firstTokenRecorded = false;

                const wrappedStream: AsyncIterable<any> = {
                  [Symbol.asyncIterator]() {
                    const iterator = originalStream[Symbol.asyncIterator]();
                    return {
                      async next() {
                        try {
                          const res = await iterator.next();

                          if (res?.done) {
                            try {
                              const endTime = Date.now();

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
                                  const responseDict = modelAsDict(streamResult);
                                  setResponseAttributes(span, responseDict);
                                }
                              } else {
                                const responseDict = modelAsDict(streamResult);
                                setResponseAttributes(span, responseDict);
                              }

                              const duration = (endTime - startTime) / 1000;
                              span.setAttribute(
                                "llm.response.duration",
                                duration,
                              );
                            } catch (e) {
                              Logger.error("netra.instrumentation.google-generative-ai:", e);
                            }
                            span.setStatus({ code: SpanStatusCode.OK });
                            span.end();
                            return res;
                          }

                          const chunk = res.value;

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
                            }
                          } catch {
                            // ignore chunk parsing issues
                          }

                          return res;
                        } catch (error) {
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
                      async return(value?: any) {
                        const endTime = Date.now();
                        const duration = (endTime - startTime) / 1000;
                        span.setAttribute("llm.response.duration", duration);
                        span.setStatus({ code: SpanStatusCode.OK });
                        span.end();
                        return iterator.return?.(value) ?? { value: undefined, done: true as const };
                      },
                      async throw(e?: any) {
                        span.setStatus({
                          code: SpanStatusCode.ERROR,
                          message: e instanceof Error ? e.message : String(e),
                        });
                        span.recordException(e instanceof Error ? e : new Error(String(e)));
                        span.end();
                        if (iterator.throw) return iterator.throw(e);
                        throw e;
                      },
                    };
                  },
                };

                return {
                  ...streamResult,
                  stream: wrappedStream,
                };
              } catch (error) {
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
function googleGenerativeAIStartChatWrapper(tracer: Tracer, spanName: string, requestType: GoogleGenerativeAIRequestType) {
  const sendMessageWrapperFn = googleGenerativeAIWrapper(tracer, spanName, requestType);
  const sendMessageStreamWrapperFn = googleGenerativeAIStreamWrapper(tracer, spanName, requestType);

  return function wrapper<F extends (...args: any[]) => any>(original: F): F {
    return function (this: unknown, ...args: Parameters<F>): any {
      const chatSession = original.apply(this, args);
      if (!chatSession) return chatSession;

      const modelInstance = this as Record<string, unknown>;
      const modelName = modelInstance.model as string | undefined;
      const systemInstruction = modelInstance.systemInstruction as unknown | undefined;
      const generationConfig = modelInstance.generationConfig as
        | Record<string, unknown>
        | undefined;
      const safetySettings = modelInstance.safetySettings as unknown | undefined;
      const tools = modelInstance.tools as unknown | undefined;
      const toolConfig = modelInstance.toolConfig as unknown | undefined;
      const chatHistory = (args[0] as Record<string, unknown> | undefined)?.history;

      if (typeof chatSession.sendMessage === "function" && !chatSession.__netra_patched) {
        const originalSendMessage = chatSession.sendMessage.bind(chatSession);
        const wrappedSendMessage = sendMessageWrapperFn(originalSendMessage);

        chatSession.__netra_orig_sendMessage = originalSendMessage;
        chatSession.sendMessage = function (this: unknown, ...sendArgs: any[]) {
          const ctx = this as Record<string, unknown>;
          if (modelName) ctx.model = modelName;
          if (systemInstruction) ctx.systemInstruction = systemInstruction;
          if (chatHistory) ctx.history = chatHistory;
          if (generationConfig) ctx.generationConfig = generationConfig;
          if (safetySettings) ctx.safetySettings = safetySettings;
          if (tools) ctx.tools = tools;
          if (toolConfig) ctx.toolConfig = toolConfig;
          return wrappedSendMessage.apply(this, sendArgs);
        };

        if (typeof chatSession.sendMessageStream === "function") {
          const originalSendStream = chatSession.sendMessageStream.bind(chatSession);
          const wrappedSendStream = sendMessageStreamWrapperFn(originalSendStream);

          chatSession.__netra_orig_sendMessageStream = originalSendStream;
          chatSession.sendMessageStream = function (this: unknown, ...sendArgs: any[]) {
            const ctx = this as Record<string, unknown>;
            if (modelName) ctx.model = modelName;
            if (systemInstruction) ctx.systemInstruction = systemInstruction;
            if (chatHistory) ctx.history = chatHistory;
            if (generationConfig) ctx.generationConfig = generationConfig;
            if (safetySettings) ctx.safetySettings = safetySettings;
            if (tools) ctx.tools = tools;
            if (toolConfig) ctx.toolConfig = toolConfig;
            return wrappedSendStream.apply(this, sendArgs);
          };
        }

        chatSession.__netra_patched = true;
        patchedSessions.add(chatSession);
      }

      return chatSession;
    } as unknown as F;
  };
}

/* Specific wrappers for different requests */
export const chatWrapper = (tracer: Tracer) =>
  googleGenerativeAIWrapper(tracer, CHAT_SPAN_NAME, "chat");

export const embeddingsWrapper = (tracer: Tracer) =>
  googleGenerativeAIWrapper(tracer, EMBEDDING_SPAN_NAME, "embedding");

export const chatStreamWrapper = (tracer: Tracer) =>
  googleGenerativeAIStreamWrapper(tracer, CHAT_SPAN_NAME, "chat");

export const startChatWrapper = (tracer: Tracer) =>
  googleGenerativeAIStartChatWrapper(tracer, CHAT_SPAN_NAME, "chat");

export function unpatchChatSessions(): void {
  for (const session of patchedSessions) {
    if (!session || !session.__netra_patched) continue;
    if (session.__netra_orig_sendMessage) {
      session.sendMessage = session.__netra_orig_sendMessage;
      delete session.__netra_orig_sendMessage;
    }
    if (session.__netra_orig_sendMessageStream) {
      session.sendMessageStream = session.__netra_orig_sendMessageStream;
      delete session.__netra_orig_sendMessageStream;
    }
    delete session.__netra_patched;
  }
  patchedSessions.clear();
}
