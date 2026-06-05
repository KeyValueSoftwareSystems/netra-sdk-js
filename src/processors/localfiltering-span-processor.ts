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
import { Logger } from "../logger";
import { compilePatterns, matchesPatterns, CompiledPatterns } from "../utils/pattern-matching";

export const LOCAL_BLOCKED_SPANS_BAGGAGE_KEY = "netra.local_blocked_spans";
export const LOCAL_BLOCKED_SPANS_ATTR_KEY = "netra.local_blocked_spans";

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
      const name = (span as any).name as string | undefined;
      if (!name) return;

      let blocked = false;

      if (matchesPatterns(name, this.globalCompiled)) {
        blocked = true;
      }

      const bag = propagation.getBaggage(parentContext);
      const raw = bag?.getEntry(LOCAL_BLOCKED_SPANS_BAGGAGE_KEY)?.value;

      if (raw) {
        const patterns = decodePatterns(raw);
        if (patterns && patterns.length > 0) {
          span.setAttribute(LOCAL_BLOCKED_SPANS_ATTR_KEY, patterns);

          const compiled = this.getCompiledLocalPatterns(raw, patterns);
          if (matchesPatterns(name, compiled)) {
            span.setAttribute("netra.local_blocked", true);
            blocked = true;
          }
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
      Logger.debug("LocalFilteringSpanProcessor.onStart error:", e);
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
    const excess = this._blockedParentMap.size - LocalFilteringSpanProcessor.MAX_ENTRIES;
    const keys = Array.from(this._blockedParentMap.keys()).slice(0, excess);
    for (const key of keys) {
      this._blockedParentMap.delete(key);
    }
  }
}
