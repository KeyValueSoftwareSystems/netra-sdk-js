import { context, Span, SpanKind, SpanStatusCode, trace, Tracer } from "@opentelemetry/api";
import { Logger } from "../../logger";
import { defineHidden, isPromise, modelAsDict, shouldSuppressInstrumentation } from "../utils";
import {
  finalizeStreamSpan,
  processStreamChunk,
  registerToolCycle,
  resolveToolCycle,
  setRequestAttributes,
  setResponseAttributes,
} from "./utils";


type AnthropicRequestType = "chat" | "beta" | "batches";

const CHAT_SPAN_NAME = "anthropic.chat";
const BETA_SPAN_NAME = "anthropic.beta";
const BATCHES_SPAN_NAME = "anthropic.batches";

function isAsyncIterable(value: unknown): boolean {
  return value != null && typeof (value as any)[Symbol.asyncIterator] === "function";
}

/**
 * Wrap an async-iterable Stream from `.create({stream:true})` so that
 * iterating it accumulates response data and finalizes the span on completion.
 * Returns a Proxy that preserves the original Stream's properties (e.g.
 * `.controller`) while intercepting `Symbol.asyncIterator`.
 */
function wrapStreamIterable(
  stream: any,
  span: Span,
  startTime: number,
  parentContext: any,
): any {
  const completeResponse: Record<string, any> = {
    content: [],
    model: "",
    usage: {},
  };
  let spanFinalized = false;
  const finalizeOnce = (code: SpanStatusCode) => {
    if (spanFinalized) return;
    spanFinalized = true;
    finalizeStreamSpan(span, completeResponse, startTime, parentContext, code);
  };

  async function* trackedIterator(): AsyncGenerator<unknown> {
    let errorOccurred = false;
    try {
      for await (const chunk of stream) {
        processStreamChunk(completeResponse, chunk, span);
        yield chunk;
      }
    } catch (err) {
      errorOccurred = true;
      Logger.error("netra.instrumentation.anthropic: Stream iteration error", err);
      finalizeOnce(SpanStatusCode.ERROR);
      throw err;
    } finally {
      if (!errorOccurred) {
        finalizeOnce(SpanStatusCode.OK);
      }
    }
  }

  let generator: AsyncGenerator<unknown> | null = null;

  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return function () {
          if (!generator) {
            generator = trackedIterator();
          }
          return generator;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

function anthropicWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: AnthropicRequestType
) {
  return function wrapper<F extends (...args: any[]) => any>(
    wrapped: F,
    instance: unknown,
    args: Parameters<F>,
    kwargs: Record<string, unknown> & { stream?: boolean }
  ): unknown {
    if (shouldSuppressInstrumentation()) {
      const result = wrapped.call(instance, ...args);
      return isPromise(result) ? result.then((value) => value) : result;
    }
    const currentContext = context.active();
    const isStreaming = args[0]?.stream === true;

    const activeSpan = trace.getSpan(context.active());
    Logger.debug(`Anthropic invoke (${requestType}). Active TraceId: ${activeSpan?.spanContext().traceId}, SpanId: ${activeSpan?.spanContext().spanId}`);

    resolveToolCycle(kwargs.messages, tracer);

    return tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes: { "llm.request.type": requestType },
      },
      (span: Span) => {
        try {
          setRequestAttributes(span, kwargs, requestType);
          if (isStreaming) {
            span.setAttribute("llm.streaming", true);
          }
          const startTime = Date.now();
          const spanContext = trace.setSpan(currentContext, span);
          const response = context.with(spanContext, () => wrapped.call(instance, ...args));
          if (isPromise(response)) {
              // Create a new promise that handles instrumentation
            const instrumentedPromise = (async () => {
              try {
                const value = await response;

                if (isStreaming && isAsyncIterable(value)) {
                  return wrapStreamIterable(value, span, startTime, currentContext);
                }

                const endTime = Date.now();
                const responseDict = modelAsDict(value);
                setResponseAttributes(span, responseDict);
                span.setAttribute(
                  "llm.response.duration",
                  (endTime - startTime) / 1000,
                );
                registerToolCycle(
                  responseDict,
                  span,
                  currentContext,
                  endTime,
                );
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                return value;
              } catch (error) {
                Logger.error("netra.instrumentation.anthropic:", error);
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

            // Proxy preserves SDK methods (.withResponse(), .asResponse(), etc.)
            // while routing then/catch/finally to the instrumented promise.
            return new Proxy(instrumentedPromise, {
              get(target, prop, receiver) {
                if (
                  prop === "then" ||
                  prop === "catch" ||
                  prop === "finally"
                ) {
                  const value = Reflect.get(target, prop, receiver);
                  if (typeof value === "function") {
                    return value.bind(target);
                  }
                  return value;
                }

                const responseValue = (response as any)[prop];
                if (responseValue !== undefined) {
                  if (typeof responseValue === "function") {
                    return responseValue.bind(response);
                  }
                  return responseValue;
                }

                const value = Reflect.get(target, prop, receiver);
                if (typeof value === "function") {
                  return value.bind(target);
                }
                return value;
              },
            });
          } else {
            const endTime = Date.now();
            const responseDict = modelAsDict(response);
            setResponseAttributes(span, responseDict);
            span.setAttribute(
              "llm.response.duration",
              (endTime - startTime) / 1000,
            );
            registerToolCycle(responseDict, span, currentContext, endTime);
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return response;
          }
        } catch (error) {
          Logger.error("netra.instrumentation.anthropic:", error);
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
  };
}

export const chatWrapper = (tracer: Tracer) =>
  anthropicWrapper(tracer, CHAT_SPAN_NAME, "chat");

export const betaWrapper = (tracer: Tracer) =>
  anthropicWrapper(tracer, BETA_SPAN_NAME, "beta");

export const batchesWrapper = (tracer: Tracer) =>
  anthropicWrapper(tracer, BATCHES_SPAN_NAME, "batches");


const WRAPPER_OWN_PROPS = new Set([
  "span",
  "messageStream",
  "startTime",
  "requestKwargs",
  "completeResponse",
  "processChunk",
  "finalizeSpanOnce",
  "processEventData",
  "finalizeSpanFromMessage",
  "parentContext",
  "tracer",
  "spanFinalized",
  "listenerMap",
]);

const EVENT_EMITTER_METHODS = new Set([
  "on",
  "once",
  "off",
  "removeListener",
  "addListener",
  "emit",
  "removeAllListeners",
  "listeners",
  "listenerCount",
]);

const LISTENER_REGISTRATION_METHODS = new Set(["on", "once", "addListener"]);

const COMPLETION_METHODS = new Set(["finalMessage", "done", "finalText"]);

const TRACKED_STREAM_EVENTS = new Set([
  "message",
  "contentBlock",
  "text",
  "finalMessage",
]);

const LISTENER_REMOVAL_METHODS = new Set(["off", "removeListener"]);

export class MessageStreamWrapper {
  private completeResponse: Record<string, any> = {
    content: [],
    model: "",
    usage: {},
  };
  private span!: Span;
  private messageStream!: any;
  private startTime!: number;
  private requestKwargs!: Record<string, any>;
  private spanContext!: any;
  private parentContext!: any;
  private tracer!: Tracer;
  private spanFinalized = false;
  private listenerMap = new WeakMap<Function, Map<string, Function>>();

  constructor(
    span: Span,
    messageStream: any,
    startTime: number,
    requestKwargs: Record<string, any>,
    spanContext?: any,
    parentContext?: any,
  ) {
    defineHidden(this, "span", span);
    defineHidden(this, "messageStream", messageStream);
    defineHidden(this, "startTime", startTime);
    defineHidden(this, "requestKwargs", requestKwargs);
    defineHidden(
      this,
      "spanContext",
      spanContext || trace.setSpan(context.active(), span),
    );
    defineHidden(this, "parentContext", parentContext || context.active());

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === "toJSON") {
          return () => target.completeResponse;
        }

        if (typeof prop === "string" && WRAPPER_OWN_PROPS.has(prop)) {
          return Reflect.get(target, prop, receiver);
        }

        if (prop === Symbol.asyncIterator) {
          return target[Symbol.asyncIterator].bind(target);
        }

        if (typeof prop === "string" && EVENT_EMITTER_METHODS.has(prop)) {
          const method = target.messageStream[prop];
          if (typeof method === "function") {
            if (LISTENER_REGISTRATION_METHODS.has(prop)) {
              return function (event: string, listener: Function) {
                const wrappedListener = (...args: any[]) => {
                  target.span.addEvent(`messagestream.event.${event}`, {
                    "event.type": event,
                  });

                  if (TRACKED_STREAM_EVENTS.has(event)) {
                    if (args[0]) {
                      target.processEventData(event, args[0]);
                    }
                  }

                  return listener(...args);
                };

                let eventMap = target.listenerMap.get(listener);
                if (!eventMap) {
                  eventMap = new Map();
                  target.listenerMap.set(listener, eventMap);
                }
                eventMap.set(event, wrappedListener);

                return method.call(target.messageStream, event, wrappedListener);
              };
            }
            if (LISTENER_REMOVAL_METHODS.has(prop)) {
              return function (event: string, listener: Function) {
                const eventMap = target.listenerMap.get(listener);
                const wrapped = eventMap?.get(event) ?? listener;
                eventMap?.delete(event);
                return method.call(target.messageStream, event, wrapped);
              };
            }
            return method.bind(target.messageStream);
          }
          return method;
        }

        if (typeof prop === "string" && COMPLETION_METHODS.has(prop)) {
          const method = target.messageStream[prop];
          if (typeof method === "function") {
            return async function (...args: any[]) {
              try {
                const result = await method.call(
                  target.messageStream,
                  ...args,
                );

                if (prop === "finalMessage" || prop === "done") {
                  target.finalizeSpanFromMessage(result);
                } else if (prop === "finalText") {
                  target.finalizeSpanOnce(SpanStatusCode.OK);
                }

                return result;
              } catch (error) {
                target.finalizeSpanOnce(SpanStatusCode.ERROR);
                throw error;
              }
            };
          }
          return method;
        }

        const value = target.messageStream[prop];
        if (typeof value === "function") {
          return value.bind(target.messageStream);
        }
        return value;
      },
    });
  }

  toJSON() {
    return this.completeResponse;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    let errorOccurred = false;
    try {
      for await (const chunk of this.messageStream) {
        processStreamChunk(this.completeResponse, chunk, this.span);
        yield chunk;
      }
    } catch (err) {
      errorOccurred = true;
      Logger.error("netra.instrumentation.anthropic: Stream error", err);
      this.finalizeSpanOnce(SpanStatusCode.ERROR);
      throw err;
    } finally {
      if (!errorOccurred) {
        this.finalizeSpanOnce(SpanStatusCode.OK);
      }
    }
  }

  getSpanContext(): any {
    return this.spanContext;
  }

  private processEventData(eventType: string, data: any): void {
    switch (eventType) {
      case 'message':
        if (data.model) {
          this.completeResponse.model = data.model;
        }
        if (data.usage) {
          this.completeResponse.usage = data.usage;
        }
        break;

      case 'text':
        if (!this.completeResponse.currentText) {
          this.completeResponse.currentText = '';
        }
        this.completeResponse.currentText += data;
        break;

      case 'contentBlock':
        if (!this.completeResponse.content) {
          this.completeResponse.content = [];
        }
        this.completeResponse.content.push(data);
        break;

      case 'finalMessage':
        if (data.model) this.completeResponse.model = data.model;
        if (data.content) this.completeResponse.content = data.content;
        if (data.usage) this.completeResponse.usage = data.usage;
        break;
    }
  }

  private finalizeSpanFromMessage(message: any): void {
    if (message) {
      if (message.model) this.completeResponse.model = message.model;
      if (message.content) this.completeResponse.content = message.content;
      if (message.usage) this.completeResponse.usage = message.usage;
      if (message.stop_reason)
        this.completeResponse.stop_reason = message.stop_reason;
    }
    this.finalizeSpanOnce(SpanStatusCode.OK);
  }

  private finalizeSpanOnce(code: SpanStatusCode): void {
    if (this.spanFinalized) return;
    this.spanFinalized = true;
    finalizeStreamSpan(
      this.span,
      this.completeResponse,
      this.startTime,
      this.parentContext,
      code,
    );
  }
}

