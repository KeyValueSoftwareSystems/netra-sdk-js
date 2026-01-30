import { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { Config } from "../config";

let trialBlockedAt: number | null = null;
const blockedTraceIds = new Set<string>();

export function setTrialBlocked(blocked: boolean) {
  if (blocked) {
    if (!trialBlockedAt) {
      trialBlockedAt = Date.now();
      console.warn(
        `Trial/quota exhausted: blocking span export for ${Config.TRIAL_BLOCK_DURATION_SECONDS}s`,
      );
    }
  } else {
    trialBlockedAt = null;
  }
}

export function isTrialBlocked(): boolean {
  if (trialBlockedAt === null) return false;

  const elapsed = (Date.now() - trialBlockedAt) / 1000;

  if (elapsed >= Config.TRIAL_BLOCK_DURATION_SECONDS) {
    trialBlockedAt = null;
    return false;
  }

  return true;
}

export function addBlockedTraceId(traceId: string) {
  blockedTraceIds.add(traceId);
}

export function isTraceIdBlocked(traceId: string): boolean {
  return blockedTraceIds.has(traceId);
}

export function getTraceId(span: ReadableSpan): string {
  try {
    return span.spanContext().traceId;
  } catch {
    return "";
  }
}
