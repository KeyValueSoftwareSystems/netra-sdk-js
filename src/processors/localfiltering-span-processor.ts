import {
  context as otelContext,
  createContextKey,
  SpanContext,
  trace,
} from "@opentelemetry/api";
import type { Context, Span } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NetraLogger } from "../netraLogger";
import { compilePatterns, matchesAnyPattern, CompiledPatterns } from "../utils/pattern-matching";

export const LOCAL_BLOCKED_SPANS_ATTR_KEY = "netra.local_blocked_spans";

/**
 * Private OTel context key for span-name patterns blocked in the current scope.
 *
 * This used to be a W3C baggage entry, which meant any caller could send
 * `baggage: netra.local_blocked_spans=["*"]` and have its request dropped from
 * Netra, and the patterns were forwarded to every downstream host (JS-SEC-001).
 * Blocking is local by design, so it now lives only in the in-process context.
 */
const LOCAL_BLOCKED_SPANS_CONTEXT_KEY = createContextKey("netra.local_blocked_spans");

export function getLocalBlockedPatterns(ctx: Context): readonly string[] {
  const value = ctx.getValue(LOCAL_BLOCKED_SPANS_CONTEXT_KEY);
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

/**
 * Returns a copy of `ctx` whose blocked patterns are the existing ones plus
 * `patterns` (deduplicated, empty strings dropped).
 */
export function contextWithLocalBlockedPatterns(
  ctx: Context,
  patterns: readonly string[],
): Context {
  const incoming = patterns.filter((p) => typeof p === "string" && p.length > 0);
  if (incoming.length === 0) return ctx;
  const merged = Object.freeze([...new Set([...getLocalBlockedPatterns(ctx), ...incoming])]);
  return ctx.setValue(LOCAL_BLOCKED_SPANS_CONTEXT_KEY, merged);
}

export function withBlockedSpansLocal<T>(
  patterns: readonly string[],
  fn: () => Promise<T>,
): Promise<T>;
export function withBlockedSpansLocal<T>(
  patterns: readonly string[],
  fn: () => T,
): T;
export function withBlockedSpansLocal<T>(
  patterns: readonly string[],
  fn: () => Promise<T> | T,
): Promise<T> | T {
  const nextCtx = contextWithLocalBlockedPatterns(otelContext.active(), patterns);
  return otelContext.with(nextCtx, fn);
}

export class LocalFilteringSpanProcessor implements SpanProcessor {
  private static readonly MAX_ENTRIES = 10_000;

  /**
   * Instance-scoped registry: spanId → parent SpanContext.
   *
   * Populated in onStart when a span's name matches blocking patterns
   * (both global and local). Shared with FilteringSpanExporter via
   * constructor injection (as a ReadonlyMap) for reparenting.
   *
   * Eviction is size-based (FIFO) rather than per-span onEnd deletion to
   * avoid a race condition: with SimpleSpanProcessor, onEnd fires before
   * export(), so deleting here would remove entries the exporter still needs.
   *
   * This map solves a timing problem with SimpleSpanProcessor: a child span may
   * be exported (and need reparenting) before its blocked parent is exported.
   * Pre-registering the blocked parent here lets the exporter find it immediately.
   */
  private readonly _blockedParentMap = new Map<string, SpanContext | undefined>();

  get blockedParentMap(): ReadonlyMap<string, SpanContext | undefined> {
    return this._blockedParentMap;
  }

  private readonly globalCompiled: CompiledPatterns;

  /** Cache for compiled local pattern sets from baggage. */
  private readonly localPatternCache = new Map<string, CompiledPatterns>();
  private static readonly MAX_LOCAL_PATTERN_CACHE = 50;

  constructor(globalPatterns: string[] = []) {
    this.globalCompiled = compilePatterns(globalPatterns);
  }

  onStart(span: Span, parentContext: Context): void {
    try {
      // The OTel API `Span` interface does not expose `.name`, but the SDK's
      // concrete Span class (sdk-trace-base >=1.x) stores it as a public field.
      // This cast relies on that implementation detail.
      const name = (span as any).name as string | undefined;
      if (!name) return;

      let blocked = false;

      if (matchesAnyPattern(name, this.globalCompiled)) {
        blocked = true;
      }

      const patterns = getLocalBlockedPatterns(parentContext);
      if (patterns.length > 0) {
        span.setAttribute(LOCAL_BLOCKED_SPANS_ATTR_KEY, [...patterns]);

        const compiled = this.getCompiledLocalPatterns(JSON.stringify(patterns), [...patterns]);
        if (matchesAnyPattern(name, compiled)) {
          span.setAttribute("netra.local_blocked", true);
          blocked = true;
        }
      }

      if (blocked) {
        const spanId = span.spanContext().spanId;
        const parentSpan = trace.getSpan(parentContext);
        const parentSpanContext = parentSpan?.spanContext();
        this._blockedParentMap.set(spanId, parentSpanContext);
        this.evictIfNeeded();
      }
    } catch (e) {
      NetraLogger.debug("LocalFilteringSpanProcessor.onStart error:", e);
    }
  }

  onEnd(_span: ReadableSpan): void {
    // No-op: cleanup is handled by size-based eviction in onStart and by
    // FilteringSpanExporter.evictRememberedIfNeeded() to avoid race
    // conditions with out-of-order export batches.
  }

  shutdown(): Promise<void> {
    this._blockedParentMap.clear();
    this.localPatternCache.clear();
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private getCompiledLocalPatterns(cacheKey: string, patterns: string[]): CompiledPatterns {
    let compiled = this.localPatternCache.get(cacheKey);
    if (!compiled) {
      compiled = compilePatterns(patterns);
      this.localPatternCache.set(cacheKey, compiled);
      if (this.localPatternCache.size > LocalFilteringSpanProcessor.MAX_LOCAL_PATTERN_CACHE) {
        const first = this.localPatternCache.keys().next().value;
        if (first) this.localPatternCache.delete(first);
      }
    }
    return compiled;
  }

  private evictIfNeeded(): void {
    if (this._blockedParentMap.size <= LocalFilteringSpanProcessor.MAX_ENTRIES) {
      return;
    }
    // Batch-evict 25% to amortize cost and avoid per-insertion eviction
    const toRemove = Math.max(
      this._blockedParentMap.size - LocalFilteringSpanProcessor.MAX_ENTRIES,
      Math.ceil(LocalFilteringSpanProcessor.MAX_ENTRIES * 0.25),
    );
    const keys = Array.from(this._blockedParentMap.keys()).slice(0, toRemove);
    for (const key of keys) {
      this._blockedParentMap.delete(key);
    }
  }
}
