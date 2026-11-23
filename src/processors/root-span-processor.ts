import { Context, Span, trace } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NetraLogger } from "../netraLogger";

export class RootSpanProcessor implements SpanProcessor {
  private static _rootOf = new WeakMap<object, Span>();

  private static readonly _rootSpans = new Map<string, Set<Span>>();

  static getRootSpan(span: Span | ReadableSpan): Span | undefined {
    const root = RootSpanProcessor._rootOf.get(span);
    if (root) return root;
    const ctx = span.spanContext();
    if (!ctx || !trace.isSpanContextValid(ctx)) return undefined;
    return RootSpanProcessor._onlyOpenRoot(ctx.traceId);
  }

  static setAttributeOnRootSpan(key: string, value: string): void {
    try {
      const active = trace.getActiveSpan();
      if (!active) {
        NetraLogger.warn(`setAttributeOnRootSpan: no active span`);
        return;
      }
      if (!trace.isSpanContextValid(active.spanContext())) {
        NetraLogger.warn(`setAttributeOnRootSpan: active span context is invalid`);
        return;
      }
      const root = RootSpanProcessor.getRootSpan(active);
      if (!root) {
        NetraLogger.warn(`setAttributeOnRootSpan: no root span found for current trace`);
        return;
      }
      root.setAttribute(key, value);
    } catch (e) {
      NetraLogger.error(`setAttributeOnRootSpan: failed to set '${key}':`, e);
    }
  }

  onStart(span: Span, parentContext: Context): void {
    try {
      const ctx = span.spanContext();
      if (!ctx || !trace.isSpanContextValid(ctx)) return;

      if (this._isRootSpan(parentContext)) {
        RootSpanProcessor._rootOf.set(span, span);
        let roots = RootSpanProcessor._rootSpans.get(ctx.traceId);
        if (!roots) {
          roots = new Set();
          RootSpanProcessor._rootSpans.set(ctx.traceId, roots);
        }
        roots.add(span);
        return;
      }

      const parent = trace.getSpan(parentContext);
      const root =
        (parent && RootSpanProcessor._rootOf.get(parent)) ??
        // Unknown parent (e.g. trace.setSpanContext): use the trace's root only if it is unambiguous.
        RootSpanProcessor._onlyOpenRoot(ctx.traceId);
      if (root) RootSpanProcessor._rootOf.set(span, root);
    } catch (e) {
      NetraLogger.warn("RootSpanProcessor.onStart: unexpected error:", e);
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      const ctx = span.spanContext();
      if (!ctx || !trace.isSpanContextValid(ctx)) return;
      const roots = RootSpanProcessor._rootSpans.get(ctx.traceId);
      if (!roots) return;
      for (const root of roots) {
        if (root === (span as unknown) || root.spanContext().spanId === ctx.spanId) {
          roots.delete(root);
          break;
        }
      }
      if (roots.size === 0) RootSpanProcessor._rootSpans.delete(ctx.traceId);
    } catch (e) {
      NetraLogger.warn("RootSpanProcessor.onEnd: unexpected error:", e);
    }
  }

  shutdown(): Promise<void> {
    RootSpanProcessor._rootSpans.clear();
    RootSpanProcessor._rootOf = new WeakMap();
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private static _onlyOpenRoot(traceId: string): Span | undefined {
    const roots = RootSpanProcessor._rootSpans.get(traceId);
    return roots?.size === 1 ? roots.values().next().value : undefined;
  }

  private _isRootSpan(parentContext: Context | undefined): boolean {
    const parentSpan = parentContext ? trace.getSpan(parentContext) : undefined;
    if (!parentSpan) return true;
    const parentCtx = parentSpan.spanContext();
    // A remote parent means this span is the local root in this process.
    return !parentCtx || !trace.isSpanContextValid(parentCtx) || parentCtx.isRemote === true;
  }
}
