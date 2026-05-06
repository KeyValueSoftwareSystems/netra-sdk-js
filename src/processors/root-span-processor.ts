import { Context, Span, trace } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * A SpanProcessor that tracks root spans using an in-memory map keyed by
 * traceId.
 *
 * Root spans are identified at span start (no valid parent) and stored in a
 * class-level mapping so that static lookup helpers can resolve root spans
 * without requiring a processor instance. The mapping is cleaned up when the
 * corresponding root span ends.
 */
export class RootSpanProcessor implements SpanProcessor {
  private static _rootSpans: Map<string, Span> = new Map();

  /**
   * Retrieve the root span associated with a given trace ID.
   *
   * @param traceId - The 32-char hex trace identifier
   * @returns The root Span if present, otherwise undefined
   */
  static getRootSpanByTraceId(traceId: string): Span | undefined {
    return RootSpanProcessor._rootSpans.get(traceId);
  }

  /**
   * Resolve the root span for a given span by looking up its trace ID.
   *
   * @param span - The span whose root span is to be determined
   * @returns The root Span if available, otherwise undefined
   */
  static getRootSpan(span: Span): Span | undefined {
    const spanCtx = span.spanContext();
    if (!spanCtx || !spanCtx.traceId) {
      return undefined;
    }
    return RootSpanProcessor.getRootSpanByTraceId(spanCtx.traceId);
  }

  private _isRootSpan(span: Span, parentContext: Context): boolean {
    const parentSpan = trace.getSpan(parentContext);
    if (!parentSpan) {
      return true;
    }
    const parentSpanCtx = parentSpan.spanContext();
    return !parentSpanCtx || !parentSpanCtx.spanId;
  }

  onStart(span: Span, parentContext: Context): void {
    try {
      const spanCtx = span.spanContext();
      if (!spanCtx || !spanCtx.traceId) {
        return;
      }

      if (!this._isRootSpan(span, parentContext)) {
        return;
      }

      if (!RootSpanProcessor._rootSpans.has(spanCtx.traceId)) {
        RootSpanProcessor._rootSpans.set(spanCtx.traceId, span);
      }
    } catch (e) {
      console.warn("RootSpanProcessor: error in onStart:", e);
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      const spanCtx = span.spanContext();
      if (!spanCtx || !spanCtx.traceId) {
        return;
      }

      const root = RootSpanProcessor._rootSpans.get(spanCtx.traceId);
      if (root) {
        const rootCtx = root.spanContext();
        if (rootCtx && rootCtx.spanId === spanCtx.spanId) {
          RootSpanProcessor._rootSpans.delete(spanCtx.traceId);
        }
      }
    } catch (e) {
      console.warn("RootSpanProcessor: error in onEnd:", e);
    }
  }

  shutdown(): Promise<void> {
    RootSpanProcessor._rootSpans.clear();
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
