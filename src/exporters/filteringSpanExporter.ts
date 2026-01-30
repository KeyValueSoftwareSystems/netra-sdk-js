import { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";

import {
  addBlockedTraceId,
  getTraceId,
  isTraceIdBlocked,
  isTrialBlocked,
} from "./utils";

export class FilteringSpanExporter implements SpanExporter {
  private exact = new Set<string>();
  private prefixes: string[] = [];
  private suffixes: string[] = [];

  // Persist blocked parents across export() calls
  private rememberedBlockedParentMap = new Map<string, any>();

  constructor(
    private readonly exporter: SpanExporter,
    patterns: string[],
  ) {
    for (const p of patterns) {
      if (!p) continue;

      if (p.endsWith("*") && !p.startsWith("*")) {
        this.prefixes.push(p.slice(0, -1));
      } else if (p.startsWith("*") && !p.endsWith("*")) {
        this.suffixes.push(p.slice(1));
      } else {
        this.exact.add(p);
      }
    }
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
    const blockedParentMap = new Map<string, any>();

    for (const span of spans) {
      const traceId = getTraceId(span);
      if (traceId && isTraceIdBlocked(traceId)) continue;

      const name = span.name;
      const globallyBlocked = this.isBlocked(name);
      const locallyBlocked =
        this.matchesLocalPatterns(span) || this.hasLocalBlockFlag(span);

      if (!globallyBlocked && !locallyBlocked) {
        filtered.push(span);
        continue;
      }

      // Span is blocked — remember its parent
      const spanId = span.spanContext().spanId;
      const parent = span.parentSpanContext;

      if (parent) {
        // current batch
        blockedParentMap.set(spanId, parent);

        //  persist across export() calls
        this.rememberedBlockedParentMap.set(spanId, parent);
      }
    }

    //  Merge remembered + current batch blocked parents
    const merged = new Map<string, any>();

    for (const [k, v] of this.rememberedBlockedParentMap) {
      merged.set(k, v);
    }

    for (const [k, v] of blockedParentMap) {
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
    return this.exporter.forceFlush?.() || Promise.resolve();
  }

  // ---------- helpers ----------

  private isBlocked(name: string): boolean {
    if (this.exact.has(name)) return true;
    if (this.prefixes.some((p) => name.startsWith(p))) return true;
    if (this.suffixes.some((s) => name.endsWith(s))) return true;
    return false;
  }

  private matchesLocalPatterns(span: ReadableSpan): boolean {
    const patterns = span.attributes?.["netra.local_blocked_spans"];
    if (!Array.isArray(patterns)) return false;

    return patterns.some((p) => {
      if (typeof p !== "string") return false;

      if (p.endsWith("*")) return span.name.startsWith(p.slice(0, -1));
      if (p.startsWith("*")) return span.name.endsWith(p.slice(1));
      return span.name === p;
    });
  }

  private hasLocalBlockFlag(span: ReadableSpan): boolean {
    return span.attributes?.["netra.local_blocked"] === true;
  }

  private reparentBlockedChildren(
    spans: ReadableSpan[],
    blockedMap: Map<string, any>,
  ) {
    for (const span of spans) {
      let parent = span.parentSpanContext;
      const visited = new Set<string>();

      while (parent && blockedMap.has(parent.spanId)) {
        if (visited.has(parent.spanId)) break;
        visited.add(parent.spanId);
        parent = blockedMap.get(parent.spanId);
      }

      if (parent !== span.parentSpanContext) {
        (span as any)._parentSpanContext = parent;
      }
    }
  }
}
