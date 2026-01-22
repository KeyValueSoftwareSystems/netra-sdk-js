import { Context, Span, trace } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

export class LlmTraceIdentifierSpanProcessor implements SpanProcessor {
  // Default attribute keys
  static DEFAULT_REQUEST_MODEL_KEY = "gen_ai.request.model";
  static DEFAULT_RESPONSE_MODEL_KEY = "gen_ai.response.model";
  static DEFAULT_ROOT_MARKER_KEY = "netra.trace.llm.call";

  private _requestModelKey: string;
  private _responseModelKey: string;
  private _rootMarkerKey: string;

  // Trace state tracking
  private _rootSpansByTrace: Map<string, Span> = new Map();
  private _rootSpanIdsByTrace: Map<string, string> = new Map();
  private _markedTraces: Set<string> = new Set();

  constructor(
    requestModelAttributeKey: string = LlmTraceIdentifierSpanProcessor.DEFAULT_REQUEST_MODEL_KEY,
    responseModelAttributeKey: string = LlmTraceIdentifierSpanProcessor.DEFAULT_RESPONSE_MODEL_KEY,
    rootMarkerAttributeKey: string = LlmTraceIdentifierSpanProcessor.DEFAULT_ROOT_MARKER_KEY,
  ) {
    if (
      !requestModelAttributeKey ||
      !responseModelAttributeKey ||
      !rootMarkerAttributeKey
    ) {
      throw new Error("Attribute keys cannot be empty");
    }
    this._requestModelKey = requestModelAttributeKey;
    this._responseModelKey = responseModelAttributeKey;
    this._rootMarkerKey = rootMarkerAttributeKey;
  }

  onStart(span: Span, parentContext: Context): void {
    try {
      if (!this._isRootSpan(span, parentContext)) {
        return;
      }

      const spanContext = span.spanContext();
      if (!spanContext) return;

      const traceId = spanContext.traceId;
      const spanId = spanContext.spanId;

      this._rootSpansByTrace.set(traceId, span);
      this._rootSpanIdsByTrace.set(traceId, spanId);
    } catch (e) {
      console.warn("Error processing span start:", e);
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      const spanContext = span.spanContext();
      if (!spanContext) return;

      const traceId = spanContext.traceId;

      if (this._isRootSpanEnding(traceId, spanContext.spanId)) {
        this._cleanupTrace(traceId);
        return;
      }

      if (this._isTraceMarked(traceId)) {
        return;
      }

      if (!this._isLlmSpan(span)) {
        return;
      }

      this._markRootSpan(traceId);
    } catch (e) {
      console.warn("Error processing span end:", e);
    }
  }

  shutdown(): Promise<void> {
    this._rootSpansByTrace.clear();
    this._rootSpanIdsByTrace.clear();
    this._markedTraces.clear();
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private _isRootSpan(span: Span, context: Context): boolean {
    const parentSpan = trace.getSpan(context);
    return !parentSpan || !parentSpan.spanContext().spanId;
  }

  private _isRootSpanEnding(traceId: string, spanId: string): boolean {
    const rootSpanId = this._rootSpanIdsByTrace.get(traceId);
    return rootSpanId !== undefined && spanId === rootSpanId;
  }

  private _isTraceMarked(traceId: string): boolean {
    return this._markedTraces.has(traceId);
  }

  private _isLlmSpan(span: ReadableSpan): boolean {
    const attributes = span.attributes;
    if (!attributes) return false;

    const hasRequestModel = Object.prototype.hasOwnProperty.call(
      attributes,
      this._requestModelKey,
    );
    const hasResponseModel = Object.prototype.hasOwnProperty.call(
      attributes,
      this._responseModelKey,
    );

    return hasRequestModel || hasResponseModel;
  }

  private _markRootSpan(traceId: string): void {
    const rootSpan = this._rootSpansByTrace.get(traceId);
    this._markedTraces.add(traceId);

    if (!rootSpan) return;

    if (!rootSpan.isRecording()) {
      console.warn("Root span is not recording, cannot mark it.");
      return;
    }

    try {
      rootSpan.setAttribute(this._rootMarkerKey, true);
    } catch (e) {
      console.warn(`Failed to mark root span for trace_id=${traceId}:`, e);
    }
  }

  private _cleanupTrace(traceId: string): void {
    this._rootSpansByTrace.delete(traceId);
    this._rootSpanIdsByTrace.delete(traceId);
    this._markedTraces.delete(traceId);
  }
}
