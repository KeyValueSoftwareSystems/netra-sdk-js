/**
 * Root Instrument Filter Processor
 *
 * Records spans from auto-instrumentation libraries that are not permitted to
 * produce root-level spans, so the exporter can *drop-and-reparent* them rather
 * than discarding a whole subtree.
 *
 * When an auto-instrumentation span (e.g. Express, HTTP, FastAPI-equivalent)
 * comes from a library outside the allowed root-instrument set, this processor
 * marks it as a **root-block candidate** with a durable instance-level marker
 * (`ROOT_BLOCK_CANDIDATE_FIELD`) and records it — along with its parent
 * `SpanContext` — in a module-global, TTL-evicted registry used for cross-batch
 * reparenting.
 *
 * The actual drop decision is made at export time by `FilteringSpanExporter`:
 * a candidate is dropped only when it is *root-connected* — it is a trace root,
 * or every ancestor up to the trace root is also a dropped candidate. Dropped
 * candidates have their children reparented onto the dropped span's parent
 * (`undefined` for a true root, so the child becomes the new root). This peel
 * repeats recursively until a survivor is reached (an allowed instrument, a
 * Netra decorator / manual span, or any non-instrumentation span).
 *
 * Spans created directly through Netra decorators or `Netra.startSpan` are
 * never candidates — only spans from recognised auto-instrumentation libraries
 * are subject to the allow-list.
 */

import { Context, Span } from "@opentelemetry/api";
import type { SpanContext } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

const INVALID_SPAN_ID = "0000000000000000";

const INSTRUMENTATION_PREFIXES = [
  "opentelemetry.instrumentation.",
  "netra.instrumentation.",
  "@opentelemetry/instrumentation-",
  "@traceloop/instrumentation-",
];

const MAX_ROOT_CANDIDATES = 4096;
const ROOT_CANDIDATE_TTL_MS = 600_000; // 600 seconds

/**
 * Durable per-span marker set the moment a span is classified as a root-block
 * candidate. It is a plain *instance property* — deliberately NOT an OTel span
 * attribute — so it travels with the span into its export batch without
 * consuming the span's bounded attribute capacity and without being evicted by
 * `AttributeSizeLimitProcessor`. Being off the attribute map, it is never
 * serialised to the backend. The exporter can still recognise a blocked root
 * even if the registry entry was evicted (TTL/overflow) or cleared (shutdown)
 * between `onStart` and export.
 */
export const ROOT_BLOCK_CANDIDATE_FIELD = "_netraRootBlockCandidate";

/**
 * `endedAt` is `null` while the span is still active; the TTL clock starts once
 * the span ends. A long-lived active candidate is therefore never evicted while
 * still open.
 */
interface CandidateEntry {
  parentCtx: SpanContext | undefined;
  endedAt: number | null;
}

/**
 * Module-global registry of root-block candidates: `spanId -> CandidateEntry`.
 *
 * Shared between this processor (writer, on span start/end) and the exporter's
 * peel (reader, on export). It enables *cross-batch* ancestry resolution —
 * reparenting a child that exports in a later batch than its dropped ancestor.
 * It is a supplement, not the source of truth: candidacy is carried durably on
 * the span via `ROOT_BLOCK_CANDIDATE_FIELD`.
 *
 * JS is single-threaded — `onStart` and `export()` never run concurrently — so
 * no locking is required (unlike the Python equivalent).
 */
const ROOT_BLOCK_CANDIDATES = new Map<string, CandidateEntry>();

/**
 * Return a snapshot `{ spanId -> parentCtx }` of the current candidate registry
 * for the exporter's peel. Copies so the exporter's read is decoupled from
 * later writes.
 */
export function getRootBlockCandidates(): Map<string, SpanContext | undefined> {
  const snapshot = new Map<string, SpanContext | undefined>();
  for (const [spanId, entry] of ROOT_BLOCK_CANDIDATES) {
    snapshot.set(spanId, entry.parentCtx);
  }
  return snapshot;
}

/**
 * Cheap membership probe so the exporter can skip the full snapshot when a
 * batch references no cross-batch candidate ancestor.
 */
export function rootBlockCandidatesContains(spanIds: Set<string>): boolean {
  if (spanIds.size === 0) {
    return false;
  }
  for (const spanId of spanIds) {
    if (ROOT_BLOCK_CANDIDATES.has(spanId)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a span carries the durable root-block-candidate marker. Robust
 * against registry eviction/clear because the marker lives on the span object.
 */
export function isRootBlockCandidate(span: unknown): boolean {
  return Boolean((span as Record<string, unknown> | null | undefined)?.[ROOT_BLOCK_CANDIDATE_FIELD]);
}

export class RootInstrumentFilterProcessor implements SpanProcessor {
  private readonly _allowed: Set<string>;

  constructor(allowedRootInstrumentNames: Set<string>) {
    this._allowed = new Set(allowedRootInstrumentNames);
  }

  onStart(span: Span, _parentContext: Context): void {
    try {
      this._processSpanStart(span);
    } catch {
      // Best-effort; never break span pipeline
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      this._markEnded(span);
      this._evictStaleCandidates();
    } catch {
      // no-op
    }
  }

  /**
   * No-op — the candidate registry is deliberately NOT cleared here.
   *
   * This processor is registered before the exporter's span processor, so
   * clearing the shared registry on shutdown would empty it *before* the
   * exporter's final flush runs — letting still-buffered blocked roots slip
   * through as exported roots. The registry is bounded (`MAX_ROOT_CANDIDATES`)
   * and TTL-evicted, so leaving it intact is safe.
   */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private _processSpanStart(span: Span): void {
    if (!this._isFromInstrumentationLibrary(span)) {
      return;
    }

    const instrName = this._extractInstrumentationName(span);
    if (instrName === null || this._allowed.has(instrName)) {
      return;
    }

    const spanId = this._getOwnSpanId(span);
    if (spanId === null || spanId === INVALID_SPAN_ID) {
      return;
    }

    const parentCtx = this._getParentSpanContext(span);
    // Mark durably first: the marker must survive even if the registry entry is
    // later evicted/cleared before this span reaches the exporter.
    this._markCandidate(span);
    this._recordCandidate(spanId, parentCtx);
  }

  private _markCandidate(span: Span): void {
    try {
      (span as unknown as Record<string, unknown>)[ROOT_BLOCK_CANDIDATE_FIELD] = true;
    } catch {
      // no-op
    }
  }

  /**
   * Register `spanId` as an active candidate. `move-to-end` semantics
   * (delete+set) refresh insertion order; overflow drops the oldest entry.
   */
  private _recordCandidate(spanId: string, parentCtx: SpanContext | undefined): void {
    ROOT_BLOCK_CANDIDATES.delete(spanId);
    ROOT_BLOCK_CANDIDATES.set(spanId, { parentCtx, endedAt: null });
    while (ROOT_BLOCK_CANDIDATES.size > MAX_ROOT_CANDIDATES) {
      const oldest = ROOT_BLOCK_CANDIDATES.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      ROOT_BLOCK_CANDIDATES.delete(oldest);
    }
  }

  /** Start the TTL clock for a just-ended candidate, if it has an entry. */
  private _markEnded(span: ReadableSpan): void {
    const spanId = this._getOwnSpanId(span);
    if (spanId === null) {
      return;
    }
    const entry = ROOT_BLOCK_CANDIDATES.get(spanId);
    if (entry) {
      entry.endedAt = Date.now();
    }
  }

  /**
   * Evict entries whose span ended more than `ROOT_CANDIDATE_TTL_MS` ago.
   * Active candidates (`endedAt === null`) are never TTL-evicted; scanning stops
   * at the first entry still active or not yet stale.
   */
  private _evictStaleCandidates(): void {
    const cutoff = Date.now() - ROOT_CANDIDATE_TTL_MS;
    for (const [spanId, entry] of ROOT_BLOCK_CANDIDATES) {
      if (entry.endedAt === null || entry.endedAt > cutoff) {
        break;
      }
      ROOT_BLOCK_CANDIDATES.delete(spanId);
    }
  }

  private _getOwnSpanId(span: Span | ReadableSpan): string | null {
    try {
      const sc = (span as Span).spanContext?.() ?? (span as unknown as { spanContext?: SpanContext }).spanContext;
      const spanId = (sc as SpanContext | undefined)?.spanId;
      return typeof spanId === "string" && spanId ? spanId : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the parent `SpanContext` recorded on the span, normalizing an
   * invalid/sentinel parent to `undefined` (= trace root).
   */
  private _getParentSpanContext(span: Span): SpanContext | undefined {
    const spanAny = span as unknown as {
      parentSpanContext?: SpanContext;
      parent?: SpanContext;
    };
    const parent = spanAny.parentSpanContext ?? spanAny.parent;
    if (!parent) {
      return undefined;
    }
    if (!parent.spanId || parent.spanId === INVALID_SPAN_ID) {
      return undefined;
    }
    return parent;
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
}
