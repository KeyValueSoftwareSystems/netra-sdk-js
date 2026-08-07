import { Span } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { RootSpanProcessor } from "../processors/root-span-processor";
import { SpanAttributes } from "../instrumentation/span-attributes";
import { Logger } from "../logger";

function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1e6;
}

function recordTimeToFirstToken(
  span: Span,
  nowMs: number,
  startTimeMs: number,
): void {
  span.setAttribute(
    SpanAttributes.LLM_TIME_TO_FIRST_TOKEN,
    (nowMs - startTimeMs) / 1000,
  );
  span.setAttribute(
    SpanAttributes.LLM_TIME_TO_FIRST_TOKEN_TIMESTAMP,
    new Date(nowMs).toISOString(),
  );
}

function recordRelativeTimeToFirstToken(span: Span, nowMs: number): void {
  try {
    const rootSpan = RootSpanProcessor.getRootSpan(span);
    if (!rootSpan) return;
    const hrStart = (rootSpan as unknown as ReadableSpan).startTime;
    if (!hrStart) return;
    const rootStartMs = hrTimeToMs(hrStart);
    span.setAttribute(
      SpanAttributes.LLM_RELATIVE_TIME_TO_FIRST_TOKEN,
      (nowMs - rootStartMs) / 1000,
    );
  } catch (e) {
    Logger.warn("span-timing: failed to compute RTTFT", e);
  }
}

/**
 * Tracks the first content token in a streaming LLM response and records
 * TTFT, RTTFT, and the absolute first-token timestamp on the span.
 *
 * `markFirstToken()` is idempotent — only the first call writes attributes.
 */
export class FirstTokenTracker {
  private _recorded = false;

  constructor(
    private readonly span: Span,
    private readonly startTimeMs: number,
  ) {}

  markFirstToken(): void {
    if (this._recorded || !this.span.isRecording()) return;
    this._recorded = true;

    const now = Date.now();

    recordTimeToFirstToken(this.span, now, this.startTimeMs);
    recordRelativeTimeToFirstToken(this.span, now);
  }
}

/**
 * Record TTFT + RTTFT for non-streaming LLM calls.
 * For non-streaming, "first token" = full response arrival,
 * so TTFT equals response duration.
 */
export function recordNonStreamingTimingAttributes(
  span: Span,
  startTimeMs: number,
  endTimeMs: number,
): void {
  if (!span.isRecording()) return;

  recordTimeToFirstToken(span, endTimeMs, startTimeMs);
  recordRelativeTimeToFirstToken(span, endTimeMs);
}
