import {
  Span as OTelSpan,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
  trace,
} from "@opentelemetry/api";
import { SpanType } from "../../types";
import { SpanAttributes } from "../span-attributes";
import { safeStringify } from "../../utils/serialization";
import {
  DEFAULT_LLM_SYSTEM,
  NETRA_AGENTS_GROUP_ID,
  NETRA_AGENTS_METADATA,
  NETRA_AGENTS_PARENT_AGENT,
  NETRA_AGENTS_SPAN_TYPE,
  NETRA_SPAN_TYPE_ATTR,
  NETRA_WORKFLOW_NAME,
} from "./constants";
import { getNetraSpanType, getSpanName } from "./utils";
import { setSpanDataAttributes } from "./attributes";
import { Logger } from "../../logger";
import type { AgentSpan, AgentTrace, TracingProcessor } from "./types";

export class NetraAgentsTracingProcessor implements TracingProcessor {
  private static readonly MAX_TRACKED_SPANS = 10_000;
  private static readonly MAX_TRACKED_TRACES = 1_000;

  private _tracer: Tracer;
  private _systemName: string;
  private _isShutdown = false;
  private _rootSpans = new Map<string, OTelSpan>();
  private _otelSpans = new Map<string, OTelSpan>();
  private _handoffs = new Map<string, Map<string, string>>();
  private _traceErrors = new Set<string>();
  private _traceSpans = new Map<string, Set<string>>();

  constructor(tracer: Tracer, systemName: string = DEFAULT_LLM_SYSTEM) {
    this._tracer = tracer;
    this._systemName = systemName;
  }

  private _parseTimestamp(iso: string | null | undefined): Date | undefined {
    if (!iso) return undefined;
    const ts = new Date(iso);
    return isNaN(ts.getTime()) ? undefined : ts;
  }

  private _evictOldestSpan(): void {
    const oldest = this._otelSpans.keys().next().value;
    if (oldest) {
      const stale = this._otelSpans.get(oldest);
      try {
        stale?.setAttribute("netra.agents.evicted", true);
        stale?.end();
      } catch { /* already ended */ }
      this._otelSpans.delete(oldest);
      Logger.debug("NetraAgentsTracingProcessor: evicted span due to MAX_TRACKED_SPANS limit");
    }
  }

  private _evictOldestTrace(): void {
    const oldest = this._rootSpans.keys().next().value;
    if (oldest) {
      const stale = this._rootSpans.get(oldest);
      try {
        stale?.setAttribute("netra.agents.evicted", true);
        stale?.setStatus({ code: SpanStatusCode.ERROR, message: "Trace evicted due to limit" });
        stale?.end();
      } catch { /* already ended */ }
      this._rootSpans.delete(oldest);
      this._traceErrors.delete(oldest);
      this._handoffs.delete(oldest);

      const orphanedSpanIds = this._traceSpans.get(oldest);
      if (orphanedSpanIds) {
        for (const spanId of orphanedSpanIds) {
          const orphan = this._otelSpans.get(spanId);
          if (orphan) {
            try {
              orphan.setAttribute("netra.agents.evicted", true);
              orphan.end();
            } catch { /* already ended */ }
            this._otelSpans.delete(spanId);
          }
        }
        this._traceSpans.delete(oldest);
      }

      Logger.debug("NetraAgentsTracingProcessor: evicted root trace due to MAX_TRACKED_TRACES limit");
    }
  }

  onTraceStart(agentTrace: AgentTrace): void {
    if (this._isShutdown) return;
    if (agentTrace.disabled) return;

    const existingRoot = this._rootSpans.get(agentTrace.traceId);
    if (existingRoot) {
      try { existingRoot.end(); } catch { /* already ended */ }
      this._rootSpans.delete(agentTrace.traceId);
    }

    if (this._rootSpans.size >= NetraAgentsTracingProcessor.MAX_TRACKED_TRACES) {
      this._evictOldestTrace();
    }

    const span = this._tracer.startSpan(agentTrace.name || "Agent workflow", {
      kind: SpanKind.INTERNAL,
      attributes: {
        [NETRA_SPAN_TYPE_ATTR]: SpanType.AGENT,
        [NETRA_WORKFLOW_NAME]: agentTrace.name || "Agent workflow",
        [SpanAttributes.LLM_SYSTEM]: this._systemName,
      },
    });

    if (agentTrace.groupId) {
      span.setAttribute(NETRA_AGENTS_GROUP_ID, agentTrace.groupId);
    }
    if (agentTrace.metadata) {
      span.setAttribute(NETRA_AGENTS_METADATA, safeStringify(agentTrace.metadata));
    }

    this._rootSpans.set(agentTrace.traceId, span);
  }

  onTraceEnd(agentTrace: AgentTrace): void {
    if (this._isShutdown) return;

    const rootSpan = this._rootSpans.get(agentTrace.traceId);
    if (!rootSpan) return;

    const hasErrors = this._traceErrors.has(agentTrace.traceId);
    rootSpan.setStatus(hasErrors
      ? { code: SpanStatusCode.ERROR, message: "One or more child spans failed" }
      : { code: SpanStatusCode.OK },
    );
    rootSpan.end();

    this._rootSpans.delete(agentTrace.traceId);
    this._traceErrors.delete(agentTrace.traceId);
    this._handoffs.delete(agentTrace.traceId);
    this._traceSpans.delete(agentTrace.traceId);
  }

  onSpanStart(agentSpan: AgentSpan): void {
    if (this._isShutdown) return;

    const existingSpan = this._otelSpans.get(agentSpan.spanId);
    if (existingSpan) {
      try { existingSpan.end(); } catch { /* already ended */ }
      this._otelSpans.delete(agentSpan.spanId);
    }

    if (this._otelSpans.size >= NetraAgentsTracingProcessor.MAX_TRACKED_SPANS) {
      this._evictOldestSpan();
    }

    const parentSpan = agentSpan.parentId
      ? this._otelSpans.get(agentSpan.parentId)
      : this._rootSpans.get(agentSpan.traceId);

    const parentContext = parentSpan
      ? trace.setSpan(context.active(), parentSpan)
      : undefined;

    const spanName = getSpanName(agentSpan);
    const netraType = getNetraSpanType(agentSpan.spanData);
    const startTime = this._parseTimestamp(agentSpan.startedAt);

    const span = this._tracer.startSpan(
      spanName,
      {
        kind: SpanKind.INTERNAL,
        startTime,
        attributes: {
          [NETRA_SPAN_TYPE_ATTR]: netraType,
          [SpanAttributes.LLM_SYSTEM]: this._systemName,
          [NETRA_AGENTS_SPAN_TYPE]: agentSpan.spanData.type,
        },
      },
      parentContext,
    );

    this._otelSpans.set(agentSpan.spanId, span);

    let spanSet = this._traceSpans.get(agentSpan.traceId);
    if (!spanSet) {
      spanSet = new Set();
      this._traceSpans.set(agentSpan.traceId, spanSet);
    }
    spanSet.add(agentSpan.spanId);
  }

  onSpanEnd(agentSpan: AgentSpan): void {
    if (this._isShutdown) return;

    const span = this._otelSpans.get(agentSpan.spanId);
    if (!span) return;

    span.updateName(getSpanName(agentSpan));
    setSpanDataAttributes(span, agentSpan, this._systemName);

    const data = agentSpan.spanData;

    if (data.type === "handoff" && data.to_agent && data.from_agent) {
      let traceHandoffs = this._handoffs.get(agentSpan.traceId);
      if (!traceHandoffs) {
        traceHandoffs = new Map();
        this._handoffs.set(agentSpan.traceId, traceHandoffs);
      }
      traceHandoffs.set(data.to_agent, data.from_agent);
    }

    if (data.type === "agent" && data.name) {
      const traceHandoffs = this._handoffs.get(agentSpan.traceId);
      if (traceHandoffs) {
        const parentNode = traceHandoffs.get(data.name);
        if (parentNode) {
          span.setAttribute(NETRA_AGENTS_PARENT_AGENT, parentNode);
          traceHandoffs.delete(data.name);
          if (traceHandoffs.size === 0) {
            this._handoffs.delete(agentSpan.traceId);
          }
        }
      }
    }

    if (agentSpan.error) {
      const MAX_ERROR_DATA_LEN = 4096;
      const errorMsg = agentSpan.error.data
        ? `${agentSpan.error.message}: ${safeStringify(agentSpan.error.data, { maxLength: MAX_ERROR_DATA_LEN })}`
        : agentSpan.error.message;
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
      span.recordException(new Error(agentSpan.error.message));
      this._traceErrors.add(agentSpan.traceId);
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    const endTime = this._parseTimestamp(agentSpan.endedAt);
    span.end(endTime);
    this._otelSpans.delete(agentSpan.spanId);

    const spanSet = this._traceSpans.get(agentSpan.traceId);
    if (spanSet) {
      spanSet.delete(agentSpan.spanId);
      if (spanSet.size === 0) {
        this._traceSpans.delete(agentSpan.traceId);
      }
    }
  }

  forceFlush(): void {
    // The OTel pipeline handles flushing via its own span processors.
    // In-flight spans (started but not yet ended) cannot be flushed here
    // because they are still accumulating attributes; they will be exported
    // when their corresponding onSpanEnd / onTraceEnd callback fires.
  }

  shutdown(): void {
    this._isShutdown = true;

    for (const span of this._rootSpans.values()) {
      try {
        span.setAttribute("netra.agents.interrupted", true);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: "Span interrupted by processor shutdown",
        });
        span.end();
      } catch {
        // span may already be ended
      }
    }

    for (const span of this._otelSpans.values()) {
      try {
        span.setAttribute("netra.agents.interrupted", true);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: "Span interrupted by processor shutdown",
        });
        span.end();
      } catch {
        // span may already be ended
      }
    }
    this._rootSpans.clear();
    this._otelSpans.clear();
    this._handoffs.clear();
    this._traceErrors.clear();
    this._traceSpans.clear();
  }
}
