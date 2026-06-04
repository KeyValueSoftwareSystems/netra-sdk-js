import {
  context as otelContext,
  propagation,
  ROOT_CONTEXT,
  SpanContext,
  trace,
} from "@opentelemetry/api";
import type { Baggage, Context, Span } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { compilePatterns, matchesPatterns } from "../utils/pattern-matching";

export const LOCAL_BLOCKED_SPANS_BAGGAGE_KEY = "netra.local_blocked_spans";
export const LOCAL_BLOCKED_SPANS_ATTR_KEY = "netra.local_blocked_spans";

/**
 * Module-level registry: spanId → parent SpanContext.
 *
 * Populated in onStart when a span's name matches local blocking patterns.
 * Consumed by FilteringSpanExporter for reparenting surviving children.
 * Cleaned up in onEnd to prevent memory leaks.
 *
 * This map solves a timing problem with SimpleSpanProcessor: a child span may
 * be exported (and need reparenting) before its blocked parent is exported.
 * Pre-registering the blocked parent here lets the exporter find it immediately.
 */
export const BLOCKED_LOCAL_PARENT_MAP = new Map<
  string,
  SpanContext | undefined
>();


function decodePatterns(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
      return parsed.filter(Boolean);
    }
  } catch {
    // ignore
  }
  return null;
}

export async function withBlockedSpansLocal<T>(
  patterns: readonly string[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const payload = JSON.stringify(patterns.filter(Boolean));
  const activeCtx = otelContext.active();

  const baggage: Baggage =
    propagation.getBaggage(activeCtx) ??
    propagation.getBaggage(ROOT_CONTEXT) ??
    propagation.createBaggage();

  const nextBaggage = baggage.setEntry(LOCAL_BLOCKED_SPANS_BAGGAGE_KEY, {
    value: payload,
  });

  const nextCtx = propagation.setBaggage(activeCtx, nextBaggage);
  return otelContext.with(nextCtx, fn);
}

export class LocalFilteringSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    try {
      const bag = propagation.getBaggage(parentContext);
      const raw = bag?.getEntry(LOCAL_BLOCKED_SPANS_BAGGAGE_KEY)?.value;
      if (!raw) return;

      const patterns = decodePatterns(raw);
      if (!patterns || patterns.length === 0) return;

      const name = (span as any).name as string | undefined;
      if (!name) return;

      // Stamp patterns onto span so FilteringSpanExporter can read them at export time
      span.setAttribute(LOCAL_BLOCKED_SPANS_ATTR_KEY, patterns);

      const compiled = compilePatterns(patterns);
      if (matchesPatterns(name, compiled)) {
        span.setAttribute("netra.local_blocked", true);

        // Pre-register in the shared map so the exporter can reparent children
        // even when this span hasn't been exported yet (SimpleSpanProcessor timing)
        const spanId = span.spanContext().spanId;
        const parentSpan = trace.getSpan(parentContext);
        const parentSpanContext = parentSpan?.spanContext();
        BLOCKED_LOCAL_PARENT_MAP.set(spanId, parentSpanContext);
      }
    } catch {
      // Never throw from a span processor — it would break the entire pipeline
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      // Remove from the shared map to prevent unbounded memory growth
      const spanId = span.spanContext().spanId;
      BLOCKED_LOCAL_PARENT_MAP.delete(spanId);
    } catch {
      // Never throw from a span processor
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
