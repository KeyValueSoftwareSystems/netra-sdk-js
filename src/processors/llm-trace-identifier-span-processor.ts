import { Context, Span, trace } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { RootSpanProcessor } from "./root-span-processor";

/**
 * Marks the root span of any trace that contains at least one LLM call with
 * `netra.trace.llm.call = true`.
 *
 * Root span resolution is delegated to RootSpanProcessor, which must be
 * registered AFTER this processor in the chain so that its on_end cleanup
 * runs after this processor has finished annotating the root span.
 */
export class LlmTraceIdentifierSpanProcessor implements SpanProcessor {
  static DEFAULT_REQUEST_MODEL_KEY = "gen_ai.request.model";
  static DEFAULT_RESPONSE_MODEL_KEY = "gen_ai.response.model";
  static DEFAULT_ROOT_MARKER_KEY = "netra.trace.llm.call";

  private readonly _requestModelKey: string;
  private readonly _responseModelKey: string;
  private readonly _rootMarkerKey: string;

  // Tracks which traces have already been marked to avoid redundant writes
  private readonly _markedTraces = new Set<string>();

  constructor(
    requestModelAttributeKey = LlmTraceIdentifierSpanProcessor.DEFAULT_REQUEST_MODEL_KEY,
    responseModelAttributeKey = LlmTraceIdentifierSpanProcessor.DEFAULT_RESPONSE_MODEL_KEY,
    rootMarkerAttributeKey = LlmTraceIdentifierSpanProcessor.DEFAULT_ROOT_MARKER_KEY,
  ) {
    if (!requestModelAttributeKey || !responseModelAttributeKey || !rootMarkerAttributeKey) {
      throw new Error("Attribute keys cannot be empty");
    }
    this._requestModelKey  = requestModelAttributeKey;
    this._responseModelKey = responseModelAttributeKey;
    this._rootMarkerKey    = rootMarkerAttributeKey;
  }

  onStart(_span: Span, _parentContext: Context): void {
    // Root span tracking is owned by RootSpanProcessor
  }

  onEnd(span: ReadableSpan): void {
    try {
      const spanCtx = span.spanContext();
      if (!spanCtx || !trace.isSpanContextValid(spanCtx)) return;

      const { traceId, spanId } = spanCtx;

      // When the root span ends, clean up local state and stop processing
      if (RootSpanProcessor.isRootSpanForTrace(traceId, spanId)) {
        this._markedTraces.delete(traceId);
        return;
      }

      if (this._markedTraces.has(traceId)) return;
      if (!this._isLlmSpan(span)) return;

      this._markRootSpan(traceId);
    } catch (e) {
      console.warn("LlmTraceIdentifierSpanProcessor: error in onEnd:", e);
    }
  }

  shutdown(): Promise<void> {
    this._markedTraces.clear();
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  private _isLlmSpan(span: ReadableSpan): boolean {
    const attrs = span.attributes;
    if (!attrs) return false;
    return (
      Object.prototype.hasOwnProperty.call(attrs, this._requestModelKey) ||
      Object.prototype.hasOwnProperty.call(attrs, this._responseModelKey)
    );
  }

  private _markRootSpan(traceId: string): void {
    const root = RootSpanProcessor.getRootSpanByTraceId(traceId);
    this._markedTraces.add(traceId);
    if (!root) return;
    if (!root.isRecording()) {
      console.warn(`LlmTraceIdentifierSpanProcessor: root span for trace ${traceId} is not recording`);
      return;
    }
    try {
      root.setAttribute(this._rootMarkerKey, true);
    } catch (e) {
      console.warn(`LlmTraceIdentifierSpanProcessor: failed to mark root span for trace ${traceId}:`, e);
    }
  }
}
