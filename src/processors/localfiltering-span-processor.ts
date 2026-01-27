import {
  context as otelContext,
  propagation,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import type { Context, Span } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export const LOCAL_BLOCKED_SPANS_BAGGAGE_KEY = "netra.local_blocked_spans";
export const LOCAL_BLOCKED_SPANS_ATTR_KEY = "netra.local_blocked_spans";

// spanId -> parentSpanContext (for exporter reparenting)
export const BLOCKED_LOCAL_PARENT_MAP = new Map<string, unknown>();

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
  for (const p of patterns) {
    if (!p) continue;

    // prefix*
    if (p.endsWith("*") && !p.startsWith("*")) {
      if (name.startsWith(p.slice(0, -1))) return true;
      continue;
    }

    // *suffix
    if (p.startsWith("*") && !p.endsWith("*")) {
      if (name.endsWith(p.slice(1))) return true;
      continue;
    }

    // exact
    if (name === p) return true;
  }
  return false;
}

/**
 * Python parity for block_spans_local(patterns) contextmanager.
 *
 * In JS we implement this via context.with(), since your OTel ContextAPI
 * doesn't expose attach/detach.
 *
 * Usage:
 * await withBlockedSpansLocal(["db.query*"], async () => {
 *   // spans created here inherit baggage
 * });
 */
export async function withBlockedSpansLocal<T>(
  patterns: readonly string[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const normalized = patterns.filter(
    (p): p is string => typeof p === "string" && !!p,
  );
  const payload = JSON.stringify(normalized);

  const activeCtx = otelContext.active();

  // Always get a baggage instance (fallback to ROOT_CONTEXT)
  const baseBaggage =
    propagation.getBaggage(activeCtx) ?? propagation.getBaggage(ROOT_CONTEXT);

  if (!baseBaggage) {
    // extreme edge case: run without local blocking
    return otelContext.with(activeCtx, fn);
  }

  const nextBaggage = baseBaggage.setEntry("netra.local_blocked_spans", {
    value: payload,
  });

  const nextCtx = propagation.setBaggage(activeCtx, nextBaggage);
  return otelContext.with(nextCtx, fn);
}

export class LocalFilteringSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext?: Context): void {
    try {
      //  THIS is the authoritative context
      const ctx = parentContext ?? otelContext.active();

      const bag = propagation.getBaggage(ctx);
      const raw = bag?.getEntry(LOCAL_BLOCKED_SPANS_BAGGAGE_KEY)?.value;
      if (!raw) return;

      const patterns = decodePatterns(raw);
      if (!patterns || patterns.length === 0) return;

      // Snapshot patterns for exporter
      span.setAttribute(LOCAL_BLOCKED_SPANS_ATTR_KEY, patterns);

      const name = (span as any).attributes?.["netra.span.name"];

      if (typeof name === "string" && matchesAnyPattern(name, patterns)) {
        span.setAttribute("netra.local_blocked", true);
      }
    } catch (e) {
      console.error("LocalFilteringSpanProcessor error", e);
    }
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
