import { ExportResultCode } from "@opentelemetry/core";
import { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { SpanContext } from "@opentelemetry/api";
import { BLOCKED_LOCAL_PARENT_MAP } from "../processors/localfiltering-span-processor";
import {
  compilePatterns,
  matchesPatterns,
  CompiledPatterns,
} from "../utils/pattern-matching";
import {
  addBlockedTraceId,
  getTraceId,
  isTraceIdBlocked,
  isTrialBlocked,
} from "./utils";

export class FilteringSpanExporter implements SpanExporter {
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

  constructor(
    private readonly exporter: SpanExporter,
    globalPatterns: string[],
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
    // Blocked spans discovered in this batch: spanId → parent SpanContext
    const batchBlockedMap = new Map<string, SpanContext | undefined>();

    for (const span of spans) {
      const traceId = getTraceId(span);
      if (traceId && isTraceIdBlocked(traceId)) continue;

      const name = span.name;

      // 1. Global pattern check (pre-compiled at construction time)
      const globallyBlocked = matchesPatterns(name, this.compiled);

      // 2. Local pattern check (compile inline — lists are typically ≤5 entries)
      const localPatterns = this.getLocalPatterns(span);
      const locallyBlocked =
        (localPatterns.length > 0 &&
          matchesPatterns(name, compilePatterns(localPatterns))) ||
        this.hasLocalBlockFlag(span);

      if (!globallyBlocked && !locallyBlocked) {
        filtered.push(span);
        continue;
      }

      // Span is blocked — record its parent for reparenting survivors
      const spanId = span.spanContext().spanId;
      const parentCtx = span.parentSpanContext as SpanContext | undefined;
      batchBlockedMap.set(spanId, parentCtx);
      // Persist across export() calls (cross-batch reparenting)
      this.rememberedBlockedParentMap.set(spanId, parentCtx);
    }

    // 3. Build the merged reparenting map:
    //    - rememberedBlockedParentMap: spans blocked in previous batches
    //    - batchBlockedMap: spans blocked in this batch
    //    - BLOCKED_LOCAL_PARENT_MAP: spans pre-registered by LocalFilteringSpanProcessor
    //      (handles SimpleSpanProcessor timing — child exported before its blocked parent)
    const merged = new Map<string, SpanContext | undefined>();

    for (const [k, v] of this.rememberedBlockedParentMap) {
      merged.set(k, v);
    }
    for (const [k, v] of BLOCKED_LOCAL_PARENT_MAP) {
      merged.set(k, v);
    }
    for (const [k, v] of batchBlockedMap) {
      merged.set(k, v);
    }

    if (merged.size > 0) {
      this.reparentBlockedChildren(filtered, merged);
    }

    if (filtered.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    this.exporter.export(filtered, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
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
   * Walk up the blocked-parent chain for each surviving span and rewrite its
   * parentSpanContext to the nearest non-blocked ancestor.
   *
   * A cycle guard (visited set) prevents infinite loops in malformed traces.
   */
  private reparentBlockedChildren(
    spans: ReadableSpan[],
    blockedMap: Map<string, SpanContext | undefined>,
  ): void {
    for (const span of spans) {
      let parent = span.parentSpanContext as SpanContext | undefined;
      if (!parent) continue;

      const visited = new Set<string>();
      let changed = false;

      while (parent && blockedMap.has(parent.spanId)) {
        if (visited.has(parent.spanId)) break; // cycle guard
        visited.add(parent.spanId);
        parent = blockedMap.get(parent.spanId);
        changed = true;
      }

      if (changed) {
        (span as any).parentSpanContext = parent;
      }
    }
  }
}
