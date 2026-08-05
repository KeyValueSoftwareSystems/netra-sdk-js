/**
 * Shimmer wrapper factories for @google/genai instrumentation.
 *
 * Two wrapper types:
 *   genericWrapper — for generateContent, embedContent, sendMessage
 *   streamWrapper  — for generateContentStream, sendMessageStream
 *
 * All wrappers use the shared wrapResponse() infrastructure to handle
 * promises and async iterables uniformly.  Netra errors are isolated
 * from user code; user/API errors are always recorded on the span and
 * re-thrown.
 */

import {
  Span,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
  trace,
} from "@opentelemetry/api";
import { Logger } from "../../logger";
import { wrapResponse } from "../../utils/response-handler";
import {
  FirstTokenTracker,
  recordNonStreamingTimingAttributes,
} from "../../utils/span-timing";
import {
  createSuppressedContext,
  modelAsDict,
  shouldSuppressInstrumentation,
} from "../utils";
import { GoogleGenAIRequestType, SPAN_NAMES } from "./types";
import {
  buildAccumulatedResponse,
  processStreamChunk,
  setRequestAttributes,
  setResponseAttributes,
} from "./utils";
import { SpanAttributes } from "../span-attributes";

const LOG_PREFIX = "netra.instrumentation.google_genai";

/**
 * Build a params dict from the first argument and the `this` context
 * (Models or Chat instance).  Shared by both wrapper factories.
 */
function buildParams(args: any[], self: Record<string, unknown>): Record<string, unknown> {
  const raw = args[0];
  const params: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? { ...raw } : { message: raw };

  if (!params.model && self.model) {
    params.model = self.model;
  }
  if (!params.config && self.config) {
    params.config = self.config;
  }

  // Chat.getHistory(true) returns the internal history array including
  // the pending user message.  Wrapped in try/catch in case the SDK
  // changes the method signature or it has unexpected side-effects.
  try {
    const history =
      typeof (self as any).getHistory === "function"
        ? (self as any).getHistory(true)
        : self.history;
    if (Array.isArray(history)) {
      params._history = history;
    }
  } catch {
    // Fall back silently — history is best-effort for tracing
  }

  return params;
}

/**
 * Wrapper factory for non-streaming SDK methods:
 *   Models.generateContent, Models.embedContent, Chat.sendMessage
 *
 * Creates a CLIENT span, sets request/response attributes, and delegates
 * return-type dispatch (sync / Promise / AsyncIterable) to wrapResponse().
 */
function genericWrapperFactory(
  tracer: Tracer,
  spanName: string,
  requestType: GoogleGenAIRequestType,
) {
  return function wrapper<F extends (...args: any[]) => any>(original: F): F {
    return function (this: unknown, ...args: any[]) {
      if (shouldSuppressInstrumentation()) {
        return original.apply(this, args);
      }

      const self = this as Record<string, unknown>;
      const params = buildParams(args, self);

      const currentContext = context.active();

      return tracer.startActiveSpan(
        spanName,
        { kind: SpanKind.CLIENT },
        (span: Span) => {
          try {
            setRequestAttributes(span, params, requestType);

            const startTime = Date.now();
            const spanContext = trace.setSpan(currentContext, span);
            const suppressedCtx = createSuppressedContext(spanContext);
            const response = context.with(suppressedCtx, () =>
              original.apply(this, args),
            );

            return wrapResponse(
              response,
              {
                withContext: (fn) => context.with(spanContext, fn),
                onSuccess: (value) => {
                  const endTime = Date.now();
                  const responseDict = modelAsDict(value);
                  // Preserve getter-based properties that JSON serialization drops
                  if (typeof (value as any)?.text === "string") {
                    responseDict.text = (value as any).text;
                  }
                  if (Array.isArray((value as any)?.functionCalls)) {
                    responseDict.functionCalls = (value as any).functionCalls;
                  }
                  setResponseAttributes(span, responseDict);
                  span.setAttribute(
                    SpanAttributes.LLM_RESPONSE_DURATION,
                    (endTime - startTime) / 1000,
                  );
                  if (requestType !== "embedding") {
                    recordNonStreamingTimingAttributes(
                      span,
                      startTime,
                      endTime,
                    );
                  }
                },
                onError: (error) => {
                  span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
                  span.recordException(error as Error);
                },
                finalize: (status) => {
                  if (status === "ok") {
                    span.setStatus({ code: SpanStatusCode.OK });
                  }
                  span.end();
                },
              },
              { preserveOriginal: response },
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
        },
      );
    } as unknown as F;
  };
}

/**
 * Wrapper factory for streaming SDK methods:
 *   Models.generateContentStream, Chat.sendMessageStream
 *
 * The SDK returns Promise<AsyncGenerator<GenerateContentResponse>>.
 * wrapResponse handles the Promise -> AsyncIterable dispatch; onChunk
 * accumulates each GenerateContentResponse chunk, and finalize writes
 * the combined result to the span.
 */
function streamWrapperFactory(
  tracer: Tracer,
  spanName: string,
  requestType: GoogleGenAIRequestType,
) {
  return function wrapper<F extends (...args: any[]) => any>(original: F): F {
    return function (this: unknown, ...args: any[]) {
      if (shouldSuppressInstrumentation()) {
        return original.apply(this, args);
      }

      const self = this as Record<string, unknown>;
      const params = buildParams(args, self);

      const currentContext = context.active();

      return tracer.startActiveSpan(
        spanName,
        {
          kind: SpanKind.CLIENT,
          attributes: { [SpanAttributes.LLM_IS_STREAMING]: true },
        },
        (span: Span) => {
          const startTime = Date.now();
          const accumulated: Record<string, any> = {};
          const tokenTracker = new FirstTokenTracker(span, startTime);

          try {
            setRequestAttributes(span, params, requestType);

            const spanContext = trace.setSpan(currentContext, span);
            const suppressedCtx = createSuppressedContext(spanContext);
            const response = context.with(suppressedCtx, () =>
              original.apply(this, args),
            );

            return wrapResponse(
              response,
              {
                withContext: (fn) => context.with(spanContext, fn),
                onChunk: (chunk) => {
                  processStreamChunk(
                    accumulated,
                    chunk,
                    span,
                    startTime,
                    tokenTracker,
                  );
                },
                onError: (error) => {
                  span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
                  span.recordException(error as Error);
                },
                finalize: (status) => {
                  try {
                    const endTime = Date.now();
                    const syntheticResponse =
                      buildAccumulatedResponse(accumulated);
                    setResponseAttributes(span, syntheticResponse);
                    span.setAttribute(
                      SpanAttributes.LLM_RESPONSE_DURATION,
                      (endTime - startTime) / 1000,
                    );
                  } catch (e) {
                    Logger.error(`${LOG_PREFIX}: stream finalize error`, e);
                  }
                  if (status === "ok") {
                    span.setStatus({ code: SpanStatusCode.OK });
                  }
                  span.end();
                },
              },
              { preserveOriginal: response },
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
        },
      );
    } as unknown as F;
  };
}

export const chatWrapper = (tracer: Tracer) =>
  genericWrapperFactory(tracer, SPAN_NAMES.CHAT, "chat");

export const chatStreamWrapper = (tracer: Tracer) =>
  streamWrapperFactory(tracer, SPAN_NAMES.CHAT, "chat");

export const embeddingsWrapper = (tracer: Tracer) =>
  genericWrapperFactory(tracer, SPAN_NAMES.EMBEDDING, "embedding");
