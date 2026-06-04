import { Context, Span, trace } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Logger } from "../logger";

/**
 * Tracks the root span for each trace keyed by traceId.
 * Exposes static helpers so other processors and session utilities
 * Register this processor AFTER LlmTraceIdentifierSpanProcessor so that
 * on_end cleanup happens after the LLM processor has finished marking the
 * root span.
 */
export class RootSpanProcessor implements SpanProcessor {
  private static readonly _rootSpans = new Map<string, Span>();

  static getRootSpanByTraceId(traceId: string): Span | undefined {
    return RootSpanProcessor._rootSpans.get(traceId);
  }

  static getRootSpan(span: Span): Span | undefined {
    const ctx = span.spanContext();
    if (!ctx || !trace.isSpanContextValid(ctx)) return undefined;
    return RootSpanProcessor._rootSpans.get(ctx.traceId);
  }

  static isRootSpanForTrace(traceId: string, spanId: string): boolean {
    const root = RootSpanProcessor._rootSpans.get(traceId);
    return root?.spanContext().spanId === spanId;
  }

  /**
   * Set an attribute on the root span of the currently active trace.
   * Resolves the root span via the active OTel context
   */
  static setAttributeOnRootSpan(key: string, value: string): void {
    try {
      const active = trace.getActiveSpan();
      if (!active) {
        Logger.warn(`setAttributeOnRootSpan: no active span`);
        return;
      }
      const spanCtx = active.spanContext();
      if (!trace.isSpanContextValid(spanCtx)) {
        Logger.warn(`setAttributeOnRootSpan: active span context is invalid`);
        return;
      }
      const root = RootSpanProcessor._rootSpans.get(spanCtx.traceId);
      if (!root) {
        Logger.warn(`setAttributeOnRootSpan: no root span found for current trace`);
        return;
      }
      root.setAttribute(key, value);
    } catch (e) {
      Logger.error(`setAttributeOnRootSpan: failed to set '${key}':`, e);
    }
  }

  onStart(span: Span, parentContext: Context): void {
    try {
      const ctx = span.spanContext();
      if (!ctx || !trace.isSpanContextValid(ctx)) return;
      if (!this._isRootSpan(parentContext)) return;
      // setdefault: first span with no valid parent wins
      if (!RootSpanProcessor._rootSpans.has(ctx.traceId)) {
        RootSpanProcessor._rootSpans.set(ctx.traceId, span);
      }
    } catch (e) {
      Logger.warn("RootSpanProcessor.onStart: unexpected error:", e);
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      const ctx = span.spanContext();
      if (!ctx || !trace.isSpanContextValid(ctx)) return;
      const root = RootSpanProcessor._rootSpans.get(ctx.traceId);
      if (root?.spanContext().spanId === ctx.spanId) {
        RootSpanProcessor._rootSpans.delete(ctx.traceId);
      }
    } catch (e) {
      Logger.warn("RootSpanProcessor.onEnd: unexpected error:", e);
    }
  }

  shutdown(): Promise<void> {
    RootSpanProcessor._rootSpans.clear();
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private _isRootSpan(parentContext: Context | undefined): boolean {
    const parentSpan = parentContext ? trace.getSpan(parentContext) : undefined;
    if (!parentSpan) return true;
    const parentCtx = parentSpan.spanContext();
    return !parentCtx || !trace.isSpanContextValid(parentCtx);
  }
}
