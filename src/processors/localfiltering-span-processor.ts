import {
  context as otelContext,
  propagation,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import type { Baggage, Context, Span } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export const LOCAL_BLOCKED_SPANS_BAGGAGE_KEY = "netra.local_blocked_spans";
export const LOCAL_BLOCKED_SPANS_ATTR_KEY = "netra.local_blocked_spans";

/* ---------------------------------- utils --------------------------------- */

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

function matchesAnyPattern(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (!p) return false;
    if (p.endsWith("*") && !p.startsWith("*")) {
      return name.startsWith(p.slice(0, -1));
    }
    if (p.startsWith("*") && !p.endsWith("*")) {
      return name.endsWith(p.slice(1));
    }
    return name === p;
  });
}

/* ----------------------- context-based local blocking ----------------------- */

export async function withBlockedSpansLocal<T>(
  patterns: readonly string[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const payload = JSON.stringify(patterns.filter(Boolean));
  const activeCtx = otelContext.active();

  // Always ensure baggage exists
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

/* -------------------------- span processor (mark) --------------------------- */

export class LocalFilteringSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const bag = propagation.getBaggage(parentContext);
    const raw = bag?.getEntry(LOCAL_BLOCKED_SPANS_BAGGAGE_KEY)?.value;
    if (!raw) return;

    const patterns = decodePatterns(raw);
    if (!patterns || patterns.length === 0) return;

    const name = (span as any).name as string | undefined;
    if (!name) return;

    // expose patterns for exporter
    span.setAttribute(LOCAL_BLOCKED_SPANS_ATTR_KEY, patterns);

    if (matchesAnyPattern(name, patterns)) {
      span.setAttribute("netra.local_blocked", true);
    }
  }

  onEnd(_span: ReadableSpan): void {
    // no-op (exporter handles removal)
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
