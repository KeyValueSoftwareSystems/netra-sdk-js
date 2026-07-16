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

export const INVALID_SPAN_ID = "0000000000000000";

const INSTRUMENTATION_PREFIXES = [
  "opentelemetry.instrumentation.",
  "netra.instrumentation.",
  "@opentelemetry/instrumentation-",
  "@traceloop/instrumentation-",
];

const MAX_ROOT_CANDIDATES = 4096;
const ROOT_CANDIDATE_TTL_MS = 600_000; // 600 seconds
/**
 * Minimum spacing between TTL sweeps. `onEnd` fires for every span, so the
 * (unbounded-order) full sweep is time-throttled to keep the hot path cheap;
 * the hard `MAX_ROOT_CANDIDATES` overflow bound still applies between sweeps.
 */
const EVICTION_INTERVAL_MS = 10_000;

/**
 * Canonicalize an instrumentation name for allow-list comparison. Instrument
 * scope names arrive concatenated (e.g. `@traceloop/instrumentation-llamaindex`
 * → `"llamaindex"`, `...-mistralai` → `"mistralai"`) while the
 * `NetraInstruments` values use snake_case (`"llama_index"`, `"mistral_ai"`).
 * The only discrepancy is underscore placement, so lower-casing and stripping
 * underscores on both sides makes the two representations match without a
 * hand-maintained alias table.
 */
export function canonicalInstrumentName(name: string): string {
  return name.toLowerCase().replace(/_/g, "");
}

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
 * Resolve only the registry ancestry reachable from `seedIds` — the cross-batch
 * parent ids (and their parents, transitively) referenced by the current export
 * batch. Returns a fresh `{ spanId -> parentCtx }` map, decoupled from later
 * writes. Walking only the reachable subset avoids copying the entire registry
 * (up to `MAX_ROOT_CANDIDATES` entries) on every export.
 */
export function getRootBlockCandidatesFor(
  seedIds: Set<string>,
): Map<string, SpanContext | undefined> {
  const out = new Map<string, SpanContext | undefined>();
  const stack = [...seedIds];
  while (stack.length > 0) {
    const spanId = stack.pop();
    if (spanId === undefined || out.has(spanId)) {
      continue;
    }
    const entry = ROOT_BLOCK_CANDIDATES.get(spanId);
    if (!entry) {
      continue;
    }
    out.set(spanId, entry.parentCtx);
    const parentId = entry.parentCtx?.spanId;
    if (parentId && parentId !== INVALID_SPAN_ID) {
      stack.push(parentId);
    }
  }
  return out;
}

/**
 * Clear the module-global candidate registry. Called when a new processor is
 * constructed so a fresh Netra session (or test) does not inherit stale
 * cross-batch state. Deliberately NOT called on shutdown — see `shutdown()`.
 */
export function resetRootBlockCandidates(): void {
  ROOT_BLOCK_CANDIDATES.clear();
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
  private _lastEvictionAt = 0;

  constructor(allowedRootInstrumentNames: Set<string>) {
    this._allowed = new Set(
      [...allowedRootInstrumentNames].map(canonicalInstrumentName),
    );
    // A new processor marks the start of a fresh session; drop any registry
    // state left behind by a previous init (or a prior test).
    resetRootBlockCandidates();
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
      const now = Date.now();
      this._markEnded(span, now);
      this._evictStaleCandidates(now);
    } catch {
      // no-op
    }
  }

  /**
   * No-op — the candidate registry is deliberately NOT cleared here.
   *
   * `MultiSpanProcessor.shutdown()` invokes every registered processor's
   * `shutdown()` concurrently (`Promise.all`), so clearing the shared registry
   * here could race with the exporter's final flush still reading it to
   * reparent buffered blocked roots. Fresh sessions instead reset the registry
   * on construction (see the constructor); it is also bounded
   * (`MAX_ROOT_CANDIDATES`) and TTL-evicted, so leaving it intact on shutdown
   * is safe.
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
    if (instrName === null || this._allowed.has(canonicalInstrumentName(instrName))) {
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
  private _markEnded(span: ReadableSpan, now: number): void {
    const spanId = this._getOwnSpanId(span);
    if (spanId === null) {
      return;
    }
    const entry = ROOT_BLOCK_CANDIDATES.get(spanId);
    if (entry) {
      entry.endedAt = now;
    }
  }

  /**
   * Evict entries whose span ended more than `ROOT_CANDIDATE_TTL_MS` ago.
   * Active candidates (`endedAt === null`) are skipped — never evicted while the
   * span is still open.
   *
   * The scan cannot break early: the registry is ordered by span *start*
   * (insertion) whereas staleness is measured from span *end*, and those two
   * orders do not coincide (a long-lived active root sits at the head while
   * short spans behind it may already be stale). A full sweep is therefore
   * required, but it is time-throttled (`EVICTION_INTERVAL_MS`) so it does not
   * run on every span end.
   */
  private _evictStaleCandidates(now: number): void {
    if (now - this._lastEvictionAt < EVICTION_INTERVAL_MS) {
      return;
    }
    this._lastEvictionAt = now;
    const cutoff = now - ROOT_CANDIDATE_TTL_MS;
    for (const [spanId, entry] of ROOT_BLOCK_CANDIDATES) {
      if (entry.endedAt !== null && entry.endedAt <= cutoff) {
        ROOT_BLOCK_CANDIDATES.delete(spanId);
      }
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
