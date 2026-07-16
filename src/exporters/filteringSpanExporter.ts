import { ExportResultCode } from "@opentelemetry/core";
import { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { SpanContext } from "@opentelemetry/api";
import {
  compilePatterns,
  matchesAnyPattern,
  CompiledPatterns,
} from "../utils/pattern-matching";
import {
  addBlockedTraceId,
  findRootSpansBlocked,
  getTraceId,
  isTraceIdBlocked,
  isTrialBlocked,
  normalizeParent,
} from "./utils";

/**
 * Wrapper that overrides parentSpanContext without mutating the original span.
 * Delegates all other ReadableSpan properties to the original.
 *
 * NOTE: This class manually delegates every property of the ReadableSpan
 * interface. If the upstream interface adds new properties, they must be
 * forwarded here as well to avoid silent data loss during export.
 */
class ReparentedSpan implements ReadableSpan {
  constructor(
    private readonly delegate: ReadableSpan,
    private readonly newParent: SpanContext | undefined,
  ) {}

  get parentSpanContext(): SpanContext | undefined {
    return this.newParent;
  }

  get name() { return this.delegate.name; }
  get kind() { return this.delegate.kind; }
  spanContext() { return this.delegate.spanContext(); }
  get startTime() { return this.delegate.startTime; }
  get endTime() { return this.delegate.endTime; }
  get status() { return this.delegate.status; }
  get attributes() { return this.delegate.attributes; }
  get links() { return this.delegate.links; }
  get events() { return this.delegate.events; }
  get duration() { return this.delegate.duration; }
  get ended() { return this.delegate.ended; }
  get resource() { return this.delegate.resource; }
  get instrumentationScope() { return this.delegate.instrumentationScope; }
  get droppedAttributesCount() { return this.delegate.droppedAttributesCount; }
  get droppedEventsCount() { return this.delegate.droppedEventsCount; }
  get droppedLinksCount() { return this.delegate.droppedLinksCount; }
}

/**
 * SpanExporter wrapper that drops spans by name and by root-instrument policy.
 *
 * A span is dropped when any of the following holds:
 * - its trace id was blocked while a trial/quota block was active;
 * - its name matches a globally configured block pattern;
 * - its name matches a per-span local block pattern set by
 *   `LocalFilteringSpanProcessor`;
 * - it is a root-connected span from an instrumentation not allowed to emit
 *   root spans (resolved by `findRootSpansBlocked`).
 *
 * Children of a dropped span are reparented onto the dropped span's parent so
 * subtrees are never silently discarded.
 */
export class FilteringSpanExporter implements SpanExporter {
  private static readonly MAX_REMEMBERED_ENTRIES = 10_000;

  /** Pre-compiled global patterns — compiled once in the constructor. */
  private readonly compiled: CompiledPatterns;

  /**
   * Spans that were blocked in a previous export() call but whose children
   * may still arrive in a later call (e.g. out-of-order export batches).
   */
  private readonly rememberedBlockedParentMap = new Map<
    string,
    SpanContext | undefined
  >();

  /** Cache for compiled local pattern sets to avoid per-span recompilation. */
  private readonly localPatternCache = new Map<string, CompiledPatterns>();
  private static readonly MAX_LOCAL_PATTERN_CACHE = 100;

  constructor(
    private readonly exporter: SpanExporter,
    globalPatterns: string[],
    private readonly localBlockedMap?: ReadonlyMap<string, SpanContext | undefined>,
  ) {
    this.compiled = compilePatterns(globalPatterns);
  }

  /**
   * Filter `spans`, reparent survivors, and forward them to the wrapped exporter.
   *
   * While a trial/quota block is active the whole batch is dropped and its trace
   * ids are remembered so their later spans are dropped too. Otherwise the batch
   * is classified into name/local drops and root-instrument drops, the survivors
   * are reparented past any dropped ancestor, and only they are forwarded.
   */
  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: ExportResultCode }) => void,
  ): void {
    if (isTrialBlocked()) {
      this.recordBlockedTraceIds(spans);
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    // Snapshot the shared processor map to avoid iteration/mutation races
    // when BatchSpanProcessor invokes export() concurrently with onStart().
    const localBlockedSnapshot = this.localBlockedMap
      ? new Map(this.localBlockedMap)
      : undefined;

    // Find unconditional name/local drops first, then resolve which root-block
    // candidates are root-connected. Feeding the name/local drops into that walk
    // is what stops a disallowed candidate from being promoted to a root when
    // its only surviving ancestor is itself name-blocked.
    const parentsOfSpansBlockedByName = this.findSpansBlockedByName(spans);
    const { rootConnectedIds: rootSpansBlocked, parentsOfRootSpansBlocked } =
      findRootSpansBlocked(spans, parentsOfSpansBlockedByName);

    const allBlockedSpanIds = new Set<string>([
      ...parentsOfSpansBlockedByName.keys(),
      ...rootSpansBlocked,
    ]);

    const survivingSpans = this.collectSurvivors(spans, allBlockedSpanIds);

    const reparentMap = this.buildReparentMap(
      parentsOfRootSpansBlocked,
      parentsOfSpansBlockedByName,
      localBlockedSnapshot,
    );
    if (reparentMap.size > 0) {
      this.reparentSpans(survivingSpans, reparentMap);
    }

    this.evictRememberedIfNeeded();

    if (survivingSpans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    this.exporter.export(survivingSpans, resultCallback);
  }

  shutdown(): Promise<void> {
    this.rememberedBlockedParentMap.clear();
    this.localPatternCache.clear();
    return this.exporter.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
  }

  /**
   * Remember the trace ids seen during a block so their later spans are dropped
   * too, even after the block expires.
   */
  private recordBlockedTraceIds(spans: ReadableSpan[]): void {
    for (const span of spans) {
      const traceId = getTraceId(span);
      if (traceId) addBlockedTraceId(traceId);
    }
  }

  /**
   * Find the spans dropped unconditionally by a global or local name rule.
   *
   * Trace-blocked spans are skipped entirely (dropped without reparenting). Each
   * dropped span is also recorded in the cross-batch remembered map so a child
   * arriving in a later batch can still be reparented past it. The returned map
   * feeds both the root-connected candidate walk — as transparent dropped
   * ancestors — and the reparent map.
   *
   * @returns A `{droppedSpanId -> normalizedParent}` map for the name/locally
   *   blocked spans in this batch.
   */
  private findSpansBlockedByName(
    spans: ReadableSpan[],
  ): Map<string, SpanContext | undefined> {
    const parentMap = new Map<string, SpanContext | undefined>();
    for (const span of spans) {
      const traceId = getTraceId(span);
      if (traceId && isTraceIdBlocked(traceId)) continue;

      const name = span.name;
      const globallyBlocked = matchesAnyPattern(name, this.compiled);
      if (!globallyBlocked && !this.isLocallyBlocked(span, name)) continue;

      const spanId = span.spanContext().spanId;
      const parentCtx = normalizeParent(span.parentSpanContext);
      parentMap.set(spanId, parentCtx);
      this.rememberedBlockedParentMap.set(spanId, parentCtx);
    }
    return parentMap;
  }

  /**
   * Check whether `span` is blocked by its per-span local rules — either its
   * name matches a local pattern or it carries the local-block flag.
   */
  private isLocallyBlocked(span: ReadableSpan, name: string): boolean {
    const localPatterns = this.readLocalBlockPatterns(span);
    if (
      localPatterns.length > 0 &&
      matchesAnyPattern(name, this.getCompiledLocalPatterns(localPatterns))
    ) {
      return true;
    }
    return this.hasLocalBlockFlag(span);
  }

  /**
   * Return the spans that survive filtering: not trace-blocked and not in
   * `allBlockedSpanIds` (name/local drops or the root-instrument policy).
   */
  private collectSurvivors(
    spans: ReadableSpan[],
    allBlockedSpanIds: Set<string>,
  ): ReadableSpan[] {
    const survivingSpans: ReadableSpan[] = [];
    for (const span of spans) {
      const traceId = getTraceId(span);
      if (traceId && isTraceIdBlocked(traceId)) continue;
      if (allBlockedSpanIds.has(span.spanContext().spanId)) continue;
      survivingSpans.push(span);
    }
    return survivingSpans;
  }

  /**
   * Merge the cross-batch remembered map with this batch's dropped-parent maps.
   *
   * Ordering matters — later wins on conflict: the remembered map and the
   * injected local-block snapshot are the base, overlaid by root-blocked
   * parents, then this batch's name/local blocks, so in-batch drops win.
   *
   * @returns The merged `{droppedSpanId -> parent}` map used for reparenting.
   */
  private buildReparentMap(
    parentsOfRootSpansBlocked: Map<string, SpanContext | undefined>,
    parentsOfSpansBlockedByName: Map<string, SpanContext | undefined>,
    localBlockedSnapshot?: Map<string, SpanContext | undefined>,
  ): Map<string, SpanContext | undefined> {
    const reparentMap = new Map<string, SpanContext | undefined>();
    for (const [k, v] of this.rememberedBlockedParentMap) {
      reparentMap.set(k, v);
    }
    if (localBlockedSnapshot) {
      for (const [k, v] of localBlockedSnapshot) {
        reparentMap.set(k, v);
      }
    }
    for (const [k, v] of parentsOfRootSpansBlocked) {
      reparentMap.set(k, v);
    }
    for (const [k, v] of parentsOfSpansBlockedByName) {
      reparentMap.set(k, v);
    }
    return reparentMap;
  }

  private getCompiledLocalPatterns(patterns: string[]): CompiledPatterns {
    const key = patterns.join("\0");
    let compiled = this.localPatternCache.get(key);
    if (!compiled) {
      compiled = compilePatterns(patterns);
      this.localPatternCache.set(key, compiled);
      if (this.localPatternCache.size > FilteringSpanExporter.MAX_LOCAL_PATTERN_CACHE) {
        const first = this.localPatternCache.keys().next().value;
        if (first) this.localPatternCache.delete(first);
      }
    }
    return compiled;
  }

  private evictRememberedIfNeeded(): void {
    if (this.rememberedBlockedParentMap.size <= FilteringSpanExporter.MAX_REMEMBERED_ENTRIES) {
      return;
    }
    // Batch-evict 25% to amortize cost and avoid per-export eviction overhead
    const toRemove = Math.max(
      this.rememberedBlockedParentMap.size - FilteringSpanExporter.MAX_REMEMBERED_ENTRIES,
      Math.ceil(FilteringSpanExporter.MAX_REMEMBERED_ENTRIES * 0.25),
    );
    const keys = Array.from(this.rememberedBlockedParentMap.keys()).slice(0, toRemove);
    for (const key of keys) {
      this.rememberedBlockedParentMap.delete(key);
    }
  }

  /**
   * Read the per-span local-block patterns set by `LocalFilteringSpanProcessor`,
   * or an empty list when none are set.
   */
  private readLocalBlockPatterns(span: ReadableSpan): string[] {
    const value = span.attributes?.["netra.local_blocked_spans"];
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      return (value as string[]).filter((v) => v !== "");
    }
    return [];
  }

  /** Check whether the processor explicitly flagged `span` as locally blocked. */
  private hasLocalBlockFlag(span: ReadableSpan): boolean {
    return span.attributes?.["netra.local_blocked"] === true;
  }

  /**
   * Reparent each span past any dropped ancestor onto its first surviving one.
   *
   * Walks the chain of dropped parents (following `blockedMap`) until a surviving
   * parent — or `undefined` (promote to root) — is reached, then wraps the span
   * in a `ReparentedSpan` pointing there. A cycle guard (visited set) prevents
   * infinite loops in malformed traces.
   */
  private reparentSpans(
    spans: ReadableSpan[],
    blockedMap: Map<string, SpanContext | undefined>,
  ): void {
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      let parent = span.parentSpanContext;
      if (!parent) continue;

      const visited = new Set<string>();
      let changed = false;

      while (parent && blockedMap.has(parent.spanId)) {
        if (visited.has(parent.spanId)) break;
        visited.add(parent.spanId);
        parent = blockedMap.get(parent.spanId);
        changed = true;
      }

      if (changed) {
        spans[i] = new ReparentedSpan(span, parent);
      }
    }
  }
}
