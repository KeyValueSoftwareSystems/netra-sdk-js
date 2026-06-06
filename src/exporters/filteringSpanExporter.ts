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
  getTraceId,
  isTraceIdBlocked,
  isTrialBlocked,
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

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: ExportResultCode }) => void,
  ): void {
    if (isTrialBlocked()) {
      for (const span of spans) {
        const traceId = getTraceId(span);
        if (traceId) addBlockedTraceId(traceId);
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    const filtered: ReadableSpan[] = [];
    const batchBlockedMap = new Map<string, SpanContext | undefined>();

    // Snapshot the shared processor map to avoid iteration/mutation races
    // when BatchSpanProcessor invokes export() concurrently with onStart().
    const localBlockedSnapshot = this.localBlockedMap
      ? new Map(this.localBlockedMap)
      : undefined;

    for (const span of spans) {
      const traceId = getTraceId(span);
      if (traceId && isTraceIdBlocked(traceId)) continue;

      const name = span.name;

      const globallyBlocked = matchesAnyPattern(name, this.compiled);

      const localPatterns = this.getLocalPatterns(span);
      const locallyBlocked =
        (localPatterns.length > 0 &&
          matchesAnyPattern(name, this.getCompiledLocalPatterns(localPatterns))) ||
        this.hasLocalBlockFlag(span);

      if (!globallyBlocked && !locallyBlocked) {
        filtered.push(span);
        continue;
      }

      const spanId = span.spanContext().spanId;
      const parentCtx = span.parentSpanContext;
      batchBlockedMap.set(spanId, parentCtx);
      this.rememberedBlockedParentMap.set(spanId, parentCtx);
    }

    const merged = new Map<string, SpanContext | undefined>();

    for (const [k, v] of this.rememberedBlockedParentMap) {
      merged.set(k, v);
    }
    if (localBlockedSnapshot) {
      for (const [k, v] of localBlockedSnapshot) {
        merged.set(k, v);
      }
    }
    for (const [k, v] of batchBlockedMap) {
      merged.set(k, v);
    }

    if (merged.size > 0) {
      this.reparentBlockedChildren(filtered, merged);
    }

    this.evictRememberedIfNeeded();

    if (filtered.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    this.exporter.export(filtered, resultCallback);
  }

  shutdown(): Promise<void> {
    this.rememberedBlockedParentMap.clear();
    this.localPatternCache.clear();
    return this.exporter.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
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

  private getLocalPatterns(span: ReadableSpan): string[] {
    const value = span.attributes?.["netra.local_blocked_spans"];
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      return (value as string[]).filter((v) => v !== "");
    }
    return [];
  }

  private hasLocalBlockFlag(span: ReadableSpan): boolean {
    return span.attributes?.["netra.local_blocked"] === true;
  }

  /**
   * Walk up the blocked-parent chain for each surviving span and wrap it
   * with a ReparentedSpan pointing to the nearest non-blocked ancestor.
   *
   * A cycle guard (visited set) prevents infinite loops in malformed traces.
   */
  private reparentBlockedChildren(
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
