import {
  context,
  Context,
  Span,
  SpanKind,
  SpanStatusCode,
  trace,
  Tracer,
} from "@opentelemetry/api";
import { Logger } from "../../logger";
import { wrapResponse } from "../../utils/response-handler";
import { safeStringify } from "../../utils/serialization";
import {
  FirstTokenTracker,
  recordNonStreamingTimingAttributes,
} from "../../utils/span-timing";
import { SpanAttributes } from "../span-attributes";
import {
  defineHidden,
  isTraceContentEnabled,
  modelAsDict,
  shouldSuppressInstrumentation,
} from "../utils";
import { AnthropicRequestType, SPAN_NAMES } from "./types";
import {
  finalizeStreamSpan,
  processStreamChunk,
  setRequestAttributes,
  setResponseAttributes,
} from "./utils";

const WRAPPER_OWN_PROPS = new Set([
  "span",
  "messageStream",
  "startTime",
  "requestKwargs",
  "completeResponse",
  "finalizeSpanOnce",
  "processEventData",
  "finalizeSpanFromMessage",
  "parentContext",
  "spanFinalized",
  "completionPending",
  "listenerMap",
  "tokenTracker",
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
const LISTENER_REMOVAL_METHODS = new Set(["off", "removeListener"]);
const COMPLETION_METHODS = new Set(["finalMessage", "done", "finalText"]);

const TRACKED_STREAM_EVENTS = new Set([
  "message",
  "contentBlock",
  "text",
  "finalMessage",
]);

/**
 * Wrap each tool's `run()` method so every invocation produces a TOOL span.
 * Preserves the tool's prototype chain — only `run` is replaced.
 * User tool errors are recorded on the span and re-thrown.
 */
export function wrapRunnableTools(
  tools: any[],
  tracer: Tracer,
  parentContext: Context,
): any[] {
  return tools.map((tool) => {
    if (typeof tool.run !== "function") return tool;

    const originalRun = tool.run;
    const toolName = tool.name ?? "unknown_tool";

    const wrappedRun = async function (
      this: any,
      input: any,
      runContext?: any,
    ) {
      const toolUseId = runContext?.toolUse?.id ?? runContext?.toolUseBlock?.id;
      const traceContent = isTraceContentEnabled();
      const attrs: Record<string, string> = {
        "netra.span.type": "TOOL",
        [SpanAttributes.LLM_REQUEST_TOOL_NAME]: toolName,
      };
      if (toolUseId) attrs[SpanAttributes.LLM_REQUEST_TOOL_ID] = toolUseId;
      if (traceContent) {
        attrs.input = safeStringify(input);
      }

      const span = tracer.startSpan(
        toolName,
        { kind: SpanKind.INTERNAL, attributes: attrs },
        parentContext,
      );

      const spanCtx = trace.setSpan(parentContext, span);
      try {
        const result = await context.with(spanCtx, () =>
          originalRun.call(this, input, runContext),
        );
        if (traceContent) {
          span.setAttribute("output", safeStringify(result));
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    };

    const wrapped = Object.create(
      Object.getPrototypeOf(tool),
      Object.getOwnPropertyDescriptors(tool),
    );
    wrapped.run = wrappedRun;
    return wrapped;
  });
}

/**
 * Proxy wrapper for Anthropic MessageStream objects returned by `.stream()`.
 * Preserves the full MessageStream interface (events, completion methods,
 * async iteration) while tracking span lifecycle.
 */
class MessageStreamWrapper {
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
  private spanFinalized = false;
  private completionPending = false;
  private listenerMap = new WeakMap<Function, Map<string, Function[]>>();
  private tokenTracker!: FirstTokenTracker;

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
    defineHidden(this, "tokenTracker", new FirstTokenTracker(span, startTime));
    defineHidden(
      this,
      "spanContext",
      spanContext || trace.setSpan(context.active(), span),
    );
    defineHidden(this, "parentContext", parentContext || context.active());

    this.registerSafetyNetListeners();

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
          if (typeof method !== "function") return method;

          if (LISTENER_REGISTRATION_METHODS.has(prop)) {
            return function (event: string, listener: Function) {
              const wrappedListener = (...args: any[]) => {
                try {
                  target.span.addEvent(`messagestream.event.${event}`, {
                    "event.type": event,
                  });
                  if (TRACKED_STREAM_EVENTS.has(event) && args[0]) {
                    target.processEventData(event, args[0]);
                  }
                } catch (e) {
                  Logger.error(
                    "netra.instrumentation.anthropic: event tracking error",
                    e,
                  );
                }
                return listener(...args);
              };

              let eventMap = target.listenerMap.get(listener);
              if (!eventMap) {
                eventMap = new Map();
                target.listenerMap.set(listener, eventMap);
              }
              let wrappers = eventMap.get(event);
              if (!wrappers) {
                wrappers = [];
                eventMap.set(event, wrappers);
              }
              wrappers.push(wrappedListener);

              return method.call(target.messageStream, event, wrappedListener);
            };
          }
          if (LISTENER_REMOVAL_METHODS.has(prop)) {
            return function (event: string, listener: Function) {
              const eventMap = target.listenerMap.get(listener);
              const wrappers = eventMap?.get(event);
              const wrapped = wrappers?.shift() ?? listener;
              if (wrappers && wrappers.length === 0) eventMap?.delete(event);
              return method.call(target.messageStream, event, wrapped);
            };
          }
          if (prop === "removeAllListeners") {
            return function (event?: string) {
              target.listenerMap = new WeakMap();
              return method.call(target.messageStream, event);
            };
          }
          return method.bind(target.messageStream);
        }

        if (typeof prop === "string" && COMPLETION_METHODS.has(prop)) {
          const method = target.messageStream[prop];
          if (typeof method !== "function") return method;

          return async function (...args: any[]) {
            target.completionPending = true;
            try {
              const result = await method.call(target.messageStream, ...args);

              if (prop === "finalMessage" || prop === "done") {
                if (result) {
                  const hasText = Array.isArray(result.content) &&
                    result.content.some((b: any) => b.type === "text" && b.text);
                  if (hasText) {
                    target.tokenTracker.markFirstToken();
                  }
                }
                target.finalizeSpanFromMessage(result);
              } else if (prop === "finalText") {
                if (typeof result === "string" && result.length > 0) {
                  target.completeResponse.content = [
                    { type: "text", text: result },
                  ];
                  target.tokenTracker.markFirstToken();
                } else {
                  target.flushCurrentText();
                }
                target.finalizeSpanOnce(SpanStatusCode.OK);
              }

              return result;
            } catch (error) {
              target.finalizeSpanOnce(SpanStatusCode.ERROR);
              throw error;
            }
          };
        }

        const value = target.messageStream[prop];
        if (typeof value === "function")
          return value.bind(target.messageStream);
        return value;
      },
    });
  }

  private registerSafetyNetListeners(): void {
    try {
      if (typeof this.messageStream?.on !== "function") return;

      // Capture TTFT directly from the raw stream so it is recorded
      // even when the consumer (e.g. tool runner) never registers its
      // own "text" listener through our proxy.
      this.messageStream.on("text", (data: any) => {
        if (data) this.tokenTracker.markFirstToken();
      });

      this.messageStream.on("end", () => {
        if (!this.completionPending) {
          this.finalizeSpanOnce(SpanStatusCode.OK);
        }
      });
      this.messageStream.on("error", (err: any) => {
        if (err && !this.spanFinalized) {
          this.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          this.span.recordException(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
        this.finalizeSpanOnce(SpanStatusCode.ERROR);
      });
    } catch (e) {
      Logger.error(
        "netra.instrumentation.anthropic: safety net listener registration failed",
        e,
      );
    }
  }

  toJSON() {
    return this.completeResponse;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    let errorOccurred = false;
    try {
      for await (const chunk of this.messageStream) {
        processStreamChunk(
          this.completeResponse,
          chunk,
          this.span,
          this.tokenTracker,
        );
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
      case "message":
        if (data.model) this.completeResponse.model = data.model;
        if (data.usage) this.completeResponse.usage = data.usage;
        break;

      case "text":
        if (!this.completeResponse.currentText) {
          this.completeResponse.currentText = "";
        }
        this.completeResponse.currentText += data;
        if (data) this.tokenTracker.markFirstToken();
        break;

      case "contentBlock":
        if (!this.completeResponse.content) {
          this.completeResponse.content = [];
        }
        this.completeResponse.content.push(data);
        break;

      case "finalMessage":
        if (data.model) this.completeResponse.model = data.model;
        if (data.content) this.completeResponse.content = data.content;
        if (data.usage) this.completeResponse.usage = data.usage;
        break;
    }
  }

  private flushCurrentText(): void {
    if (
      this.completeResponse.currentText &&
      (!this.completeResponse.content ||
        this.completeResponse.content.length === 0)
    ) {
      this.completeResponse.content = [
        { type: "text", text: this.completeResponse.currentText },
      ];
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
    finalizeStreamSpan(this.span, this.completeResponse, this.startTime, code);
  }
}

/**
 * Shimmer-compatible wrapper factory for `.create()` methods.
 * Returns `(original) => replacement` as expected by `shimmer.wrap()`.
 */
function anthropicWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: AnthropicRequestType,
) {
  return function wrapper<F extends (...args: any[]) => any>(original: F): F {
    return function (this: unknown, ...args: any[]) {
      if (shouldSuppressInstrumentation()) {
        return original.apply(this, args);
      }

      const attributes = (args[0] || {}) as Record<string, unknown>;
      const currentContext = context.active();
      const isStreaming = attributes.stream === true;

      const activeSpan = trace.getSpan(currentContext);
      Logger.debug(
        `Anthropic invoke (${requestType}). Active TraceId: ${activeSpan?.spanContext().traceId}, SpanId: ${activeSpan?.spanContext().spanId}`,
      );

      return tracer.startActiveSpan(
        spanName,
        {
          kind: SpanKind.CLIENT,
          attributes: { "llm.request.type": requestType },
        },
        (span: Span) => {
          try {
            setRequestAttributes(span, attributes, requestType);
            if (isStreaming) {
              span.setAttribute("llm.streaming", true);
            }
            const startTime = Date.now();
            const spanContext = trace.setSpan(currentContext, span);
            const response = context.with(spanContext, () =>
              original.apply(this, args),
            );

            const completeResponse: Record<string, any> = {
              content: [],
              model: "",
              usage: {},
            };
            const tokenTracker = new FirstTokenTracker(span, startTime);

            return wrapResponse(
              response,
              {
                withContext: (fn) => context.with(spanContext, fn),
                onChunk: (chunk) =>
                  processStreamChunk(
                    completeResponse,
                    chunk,
                    span,
                    tokenTracker,
                  ),
                onError: (error) => {
                  Logger.error("netra.instrumentation.anthropic:", error);
                  span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
                  span.recordException(error as Error);
                },
                onSuccess: (value) => {
                  const endTime = Date.now();
                  const responseDict = modelAsDict(value);
                  setResponseAttributes(span, responseDict);
                  span.setAttribute(
                    "llm.response.duration",
                    (endTime - startTime) / 1000,
                  );
                  recordNonStreamingTimingAttributes(span, startTime, endTime);
                },
                finalize: (status) => {
                  const hasStreamData =
                    completeResponse.content?.length ||
                    completeResponse.model ||
                    completeResponse.usage?.input_tokens !== undefined ||
                    completeResponse.usage?.output_tokens !== undefined;
                  if (status === "ok" && hasStreamData) {
                    finalizeStreamSpan(
                      span,
                      completeResponse,
                      startTime,
                      SpanStatusCode.OK,
                    );
                  } else {
                    if (status === "ok") {
                      span.setStatus({ code: SpanStatusCode.OK });
                    }
                    span.end();
                  }
                },
              },
              { preserveOriginal: response },
            );
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
    } as unknown as F;
  };
}

/**
 * Shimmer-compatible wrapper factory for `.stream()` methods.
 * `originalCreate` is the unpatched `create` method captured before patching,
 * used to build a per-call Proxy so `.stream()` calls the uninstrumented
 * `create` internally (avoids double-spanning).
 */
function streamWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: AnthropicRequestType,
  originalCreate?: Function,
) {
  return function wrapper<F extends (...args: any[]) => any>(original: F): F {
    return function (this: unknown, ...args: any[]) {
      if (shouldSuppressInstrumentation()) {
        return original.apply(this, args);
      }

      const attributes = (args[0] || {}) as Record<string, unknown>;
      const currentContext = context.active();

      const span = tracer.startSpan(
        spanName,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "llm.request.type": requestType,
            "llm.streaming": true,
            "llm.operation": "stream",
          },
        },
        currentContext,
      );

      const spanContext = trace.setSpan(currentContext, span);
      setRequestAttributes(span, attributes, requestType);
      const startTime = Date.now();

      const callTarget = originalCreate
        ? new Proxy(this as any, {
            get(target, prop) {
              // Using the uninstrumented create method to avoid double-spanning, since `.stream()` calls `.create()` internally.
              if (prop === "create") return originalCreate.bind(target);
              // All other methods bound to the target object.
              const value = target[prop];
              if (typeof value === "function") return value.bind(target);
              return value;
            },
          })
        : this;

      try {
        const messageStream = context.with(spanContext, () =>
          original.call(callTarget, ...args),
        );
        return new MessageStreamWrapper(
          span,
          messageStream,
          startTime,
          attributes,
          spanContext,
          currentContext,
        );
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    } as unknown as F;
  };
}

/**
 * Shimmer-compatible wrapper factory for `.toolRunner()`.
 * Wraps the returned ToolRunner with a Proxy that manages
 * span lifecycle across async iteration and thenable resolution.
 */
function toolRunnerWrapper(
  tracer: Tracer,
  spanName: string,
  requestType: AnthropicRequestType,
) {
  return function wrapper<F extends (...args: any[]) => any>(original: F): F {
    return function (this: unknown, ...args: any[]) {
      if (shouldSuppressInstrumentation()) {
        return original.apply(this, args);
      }

      const attributes = (args[0] || {}) as Record<string, unknown>;
      const currentContext = context.active();
      const span = tracer.startSpan(
        spanName,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "llm.request.type": requestType,
            "netra.span.type": "AGENT",
            "llm.operation": "tool.runner",
          },
        },
        currentContext,
      );

      let spanEnded = false;
      const endSpanOnce = (code: SpanStatusCode, error?: Error) => {
        if (spanEnded) return;
        spanEnded = true;
        if (error) {
          span.setStatus({ code, message: error.message });
          span.recordException(error);
        } else {
          span.setStatus({ code });
        }
        span.end();
      };

      try {
        setRequestAttributes(span, attributes, "beta");
        const spanContext = trace.setSpan(currentContext, span);

        const wrappedTools = Array.isArray(attributes.tools)
          ? wrapRunnableTools(attributes.tools as any[], tracer, spanContext)
          : attributes.tools;

        const wrappedArgs = [
          { ...attributes, tools: wrappedTools },
          ...args.slice(1),
        ];
        const runner = context.with(spanContext, () =>
          original.apply(this, wrappedArgs),
        );

        if (runner == null) {
          endSpanOnce(SpanStatusCode.OK);
          return runner;
        }

        return new Proxy(runner, {
          get(target: any, prop: string | symbol, receiver: any) {
            if (prop === Symbol.asyncIterator) {
              return function () {
                const originalIterator = target[Symbol.asyncIterator]();
                return {
                  [Symbol.asyncIterator]() {
                    return this;
                  },
                  async next() {
                    try {
                      const result = await context.with(spanContext, () =>
                        originalIterator.next(),
                      );
                      if (result.done) endSpanOnce(SpanStatusCode.OK);
                      return result;
                    } catch (error) {
                      endSpanOnce(SpanStatusCode.ERROR, error as Error);
                      throw error;
                    }
                  },
                  async return(value?: any) {
                    try {
                      const result = await (originalIterator.return?.(
                        value,
                      ) ?? {
                        done: true,
                        value,
                      });
                      return result;
                    } finally {
                      endSpanOnce(SpanStatusCode.OK);
                    }
                  },
                  async throw(error?: any) {
                    const err =
                      error instanceof Error ? error : new Error(String(error));
                    if (originalIterator.throw) {
                      try {
                        const result = await originalIterator.throw(error);
                        if (result.done) {
                          endSpanOnce(SpanStatusCode.ERROR, err);
                        }
                        return result;
                      } catch (e) {
                        endSpanOnce(
                          SpanStatusCode.ERROR,
                          e instanceof Error ? e : new Error(String(e)),
                        );
                        throw e;
                      }
                    }
                    endSpanOnce(SpanStatusCode.ERROR, err);
                    throw error;
                  },
                };
              };
            }

            if (prop === "then" || prop === "catch" || prop === "finally") {
              const originalMethod = target[prop];
              if (typeof originalMethod !== "function") return originalMethod;

              if (prop === "then") {
                return function (
                  onFulfilled?: Function,
                  onRejected?: Function,
                ) {
                  return originalMethod.call(
                    target,
                    (v: any) => {
                      endSpanOnce(SpanStatusCode.OK);
                      return onFulfilled ? onFulfilled(v) : v;
                    },
                    (e: any) => {
                      endSpanOnce(
                        SpanStatusCode.ERROR,
                        e instanceof Error ? e : new Error(String(e)),
                      );
                      if (onRejected) return onRejected(e);
                      throw e;
                    },
                  );
                };
              }
              if (prop === "catch") {
                return function (onRejected?: Function) {
                  return receiver.then(undefined, onRejected);
                };
              }
              if (prop === "finally") {
                return function (onFinally?: Function) {
                  return receiver.then(
                    (v: any) => {
                      onFinally?.();
                      return v;
                    },
                    (e: any) => {
                      onFinally?.();
                      throw e;
                    },
                  );
                };
              }
            }

            const value = target[prop];
            if (typeof value === "function") return value.bind(target);
            return value;
          },
        });
      } catch (error) {
        endSpanOnce(
          SpanStatusCode.ERROR,
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      }
    } as unknown as F;
  };
}

export const chatWrapper = (tracer: Tracer) =>
  anthropicWrapper(tracer, SPAN_NAMES.CHAT, "chat");

export const betaWrapper = (tracer: Tracer) =>
  anthropicWrapper(tracer, SPAN_NAMES.BETA, "beta");

export const batchesWrapper = (tracer: Tracer) =>
  anthropicWrapper(tracer, SPAN_NAMES.BATCHES, "batches");

export const chatStreamWrapper = (tracer: Tracer, originalCreate?: Function) =>
  streamWrapper(tracer, SPAN_NAMES.STREAM, "chat", originalCreate);

export const betaStreamWrapper = (tracer: Tracer, originalCreate?: Function) =>
  streamWrapper(tracer, SPAN_NAMES.BETA_STREAM, "beta", originalCreate);

export const betaToolRunnerWrapper = (tracer: Tracer) =>
  toolRunnerWrapper(tracer, SPAN_NAMES.BETA_TOOL_RUNNER, "beta");
