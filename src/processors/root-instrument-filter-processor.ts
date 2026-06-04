/**
 * Root Instrument Filter Processor
 *
 * Blocks root spans (and their entire subtree) from instrumentations not in
 * the allowed root_instruments set. Tracking is trace-ID-based: when a root
 * span is blocked, its trace_id is recorded and all subsequent spans sharing
 * that trace_id are blocked as well.
 *
 * This guarantees correct propagation even in async frameworks where a parent
 * span may end before all children have started.
 */

import { Context, Span, trace } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

const LOCAL_BLOCKED_ATTR = "netra.local_blocked";

const INSTRUMENTATION_PREFIXES = [
  "opentelemetry.instrumentation.",
  "netra.instrumentation.",
  "@opentelemetry/instrumentation-",
  "@traceloop/instrumentation-",
];

const MAX_BLOCKED_TRACES = 4096;
const BLOCKED_TRACE_TTL_MS = 600_000; // 600 seconds

interface BlockedEntry {
  timestamp: number;
}

export class RootInstrumentFilterProcessor implements SpanProcessor {
  private readonly _allowed: Set<string>;
  private readonly _blockedTraceIds: Map<string, BlockedEntry> = new Map();

  constructor(allowedRootInstrumentNames: Set<string>) {
    this._allowed = new Set(allowedRootInstrumentNames);
  }

  onStart(span: Span, parentContext: Context): void {
    try {
      this._processSpanStart(span, parentContext);
    } catch {
      // Best-effort; never break span pipeline
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      this._evictStaleTraces();
    } catch {
      // no-op
    }
  }

  shutdown(): Promise<void> {
    this._blockedTraceIds.clear();
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private _processSpanStart(span: Span, parentContext: Context): void {
    const parentSpanId = this._resolveParentSpanId(parentContext)
      ?? this._getParentSpanIdFromSpan(span);

    const isChild = parentSpanId !== null && parentSpanId !== "0000000000000000";

    if (isChild) {
      this._maybeBlockChild(span);
    } else {
      this._maybeBlockRoot(span);
    }
  }

  private _maybeBlockChild(span: Span): void {
    const traceId = this._getTraceId(span);
    if (!traceId) {
      return;
    }
    if (this._blockedTraceIds.has(traceId)) {
      this._markBlocked(span);
    }
  }

  private _maybeBlockRoot(span: Span): void {
    if (!this._isFromInstrumentationLibrary(span)) {
      return;
    }

    const instrName = this._extractInstrumentationName(span);
    if (instrName === null || this._allowed.has(instrName)) {
      return;
    }

    const traceId = this._getTraceId(span);
    if (traceId) {
      this._blockedTraceIds.set(traceId, { timestamp: Date.now() });
      this._evictOverflow();
    }
    this._markBlocked(span);
  }

  private _resolveParentSpanId(parentContext: Context): string | null {
    const parentSpan = trace.getSpan(parentContext);
    if (!parentSpan) {
      return null;
    }
    const sc = parentSpan.spanContext();
    if (!sc || sc.spanId === "0000000000000000") {
      return null;
    }
    return sc.spanId;
  }

  private _getParentSpanIdFromSpan(span: Span): string | null {
    const spanAny = span as any;
    const parent = spanAny.parentSpanId ?? spanAny.parent?.spanId ?? null;
    if (!parent || parent === "0000000000000000") {
      return null;
    }
    return parent;
  }

  private _getTraceId(span: Span | ReadableSpan): string | null {
    try {
      const ctx = (span as any).spanContext?.() ?? (span as any).context;
      if (ctx) {
        return ctx.traceId ?? null;
      }
    } catch {
      // no-op
    }
    return null;
  }

  private _markBlocked(span: Span): void {
    try {
      span.setAttribute(LOCAL_BLOCKED_ATTR, true);
    } catch {
      // no-op
    }
  }

  private _isFromInstrumentationLibrary(span: Span): boolean {
    const spanAny = span as any;
    const scope =
      spanAny.instrumentationLibrary || spanAny.instrumentationScope;
    if (!scope) {
      return false;
    }
    const name: unknown = scope.name;
    if (typeof name !== "string" || !name) {
      return false;
    }
    return INSTRUMENTATION_PREFIXES.some((prefix) => name.startsWith(prefix));
  }

  private _extractInstrumentationName(span: Span): string | null {
    const spanAny = span as any;
    const scope =
      spanAny.instrumentationLibrary || spanAny.instrumentationScope;
    if (!scope) {
      return null;
    }
    const name: unknown = scope.name;
    if (typeof name !== "string" || !name) {
      return null;
    }
    for (const prefix of INSTRUMENTATION_PREFIXES) {
      if (name.startsWith(prefix)) {
        const segments = name.split(/[./\-]/);
        const base = segments[segments.length - 1]?.trim();
        if (base) {
          return base;
        }
      }
    }
    return name;
  }

  private _evictStaleTraces(): void {
    const cutoff = Date.now() - BLOCKED_TRACE_TTL_MS;
    for (const [traceId, entry] of this._blockedTraceIds) {
      if (entry.timestamp > cutoff) {
        break;
      }
      this._blockedTraceIds.delete(traceId);
    }
  }

  private _evictOverflow(): void {
    while (this._blockedTraceIds.size > MAX_BLOCKED_TRACES) {
      const first = this._blockedTraceIds.keys().next().value;
      if (first !== undefined) {
        this._blockedTraceIds.delete(first);
      } else {
        break;
      }
    }
  }
}
