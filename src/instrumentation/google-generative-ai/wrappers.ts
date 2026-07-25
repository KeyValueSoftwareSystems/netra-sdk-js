import {
  Span,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
} from "@opentelemetry/api";
import { Logger } from "../../logger";
import {
  isGenerativeRequestType,
  isPromise,
  modelAsDict,
  recordTimeToFirstToken,
  shouldSuppressInstrumentation,
} from "../utils";
import { extractModelName, setRequestAttributes, setResponseAttributes } from "./utils";

type GoogleGenerativeAIRequestType = "chat" | "embedding";

const LOG_PREFIX = "netra.instrumentation.google_generative_ai";
const CHAT_SPAN_NAME = "google_generative_ai.chat";
const EMBEDDING_SPAN_NAME = "google_generative_ai.embedding";

/**
 * Build kwargs from the calling context (`this`).
 *
 * `this` is either a GenerativeModel (for generateContent/embedContent)
 * or a ChatSession (for sendMessage/sendMessageStream).
 *
 * GenerativeModel stores config directly: this.generationConfig, this.tools, ...
 * ChatSession stores config inside this.params: this.params.generationConfig, ...
 * Both have this.model.
 */
function buildKwargs(instance: Record<string, unknown>): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {};
  const params = instance.params as Record<string, unknown> | undefined;

  const modelName = instance.model as string | undefined;
  if (modelName) {
    kwargs.model = extractModelName(modelName);
  }

  const systemInstruction = instance.systemInstruction ?? params?.systemInstruction;
  if (systemInstruction) kwargs.systemInstruction = systemInstruction;

  const history = (instance as any)._history ?? instance.history;
  if (history) kwargs.history = history;

  const generationConfig = instance.generationConfig ?? params?.generationConfig;
  if (generationConfig) kwargs.generationConfig = generationConfig;

  const safetySettings = instance.safetySettings ?? params?.safetySettings;
  if (safetySettings) kwargs.safetySettings = safetySettings;

  const tools = instance.tools ?? params?.tools;
  if (tools) kwargs.tools = tools;

  const toolConfig = instance.toolConfig ?? params?.toolConfig;
  if (toolConfig) kwargs.toolConfig = toolConfig;

  return kwargs;
}

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

      const modelInstance = this as Record<string, unknown>;
      const kwargs = buildKwargs(modelInstance);

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
              Logger.error(`${LOG_PREFIX}:`, e);
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
                    // Non-streaming: the whole response lands at once, so first
                    // token == response. Embeddings generate no tokens.
                    if (isGenerativeRequestType(requestType)) {
                      recordTimeToFirstToken(span);
                    }
                  } catch (e) {
                    Logger.error(`${LOG_PREFIX}:`, e);
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
                if (isGenerativeRequestType(requestType)) {
                  recordTimeToFirstToken(span);
                }
              } catch (e) {
                Logger.error(`${LOG_PREFIX}:`, e);
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

      const modelInstance = this as Record<string, unknown>;
      const kwargs = buildKwargs(modelInstance);

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
              Logger.error(`${LOG_PREFIX}:`, e);
            }

            const response = original.apply(this, args);

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
                    // Not actually a stream — the whole response lands at once
                    recordTimeToFirstToken(span);
                  } catch (e) {
                    Logger.error(`${LOG_PREFIX}:`, e);
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
                              Logger.error(`${LOG_PREFIX}:`, e);
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
                                firstTokenRecorded = true;
                                recordTimeToFirstToken(span);
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

export const chatWrapper = (tracer: Tracer) =>
  googleGenerativeAIWrapper(tracer, CHAT_SPAN_NAME, "chat");

export const embeddingsWrapper = (tracer: Tracer) =>
  googleGenerativeAIWrapper(tracer, EMBEDDING_SPAN_NAME, "embedding");

export const chatStreamWrapper = (tracer: Tracer) =>
  googleGenerativeAIStreamWrapper(tracer, CHAT_SPAN_NAME, "chat");
