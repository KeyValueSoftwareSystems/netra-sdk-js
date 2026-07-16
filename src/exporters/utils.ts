import { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { SpanContext } from "@opentelemetry/api";
import { Config } from "../config";
import { Logger } from "../logger";
import {
  getRootBlockCandidates,
  isRootBlockCandidate,
  rootBlockCandidatesContains,
} from "../processors/root-instrument-filter-processor";

export const INVALID_SPAN_ID = "0000000000000000";

let trialBlockedAt: number | null = null;
const blockedTraceIds = new Set<string>();

export function setTrialBlocked(blocked: boolean) {
  if (blocked) {
    if (!trialBlockedAt) {
      trialBlockedAt = Date.now();
      Logger.warn(
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

/** Return a span's own span id, or `null` when unavailable. */
export function getSpanId(span: ReadableSpan): string | null {
  try {
    const spanId = span.spanContext().spanId;
    return typeof spanId === "string" && spanId ? spanId : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a span's parent link, collapsing an invalid/sentinel parent to
 * `undefined` (= trace root). Mirrors the processor's `_getParentSpanContext`
 * so the in-batch overlay and the registry store parents identically.
 */
export function normalizeParent(
  parent: SpanContext | undefined,
): SpanContext | undefined {
  if (!parent) {
    return undefined;
  }
  if (!parent.spanId || parent.spanId === INVALID_SPAN_ID) {
    return undefined;
  }
  return parent;
}

/**
 * Resolve which root-block candidates in `spans` must be dropped.
 *
 * A candidate is dropped when it is *root-connected*: it is a trace root (no
 * local parent), or its parent is itself a dropped span. The peel stops at the
 * first surviving ancestor and never crosses a remote (cross-process) parent
 * link.
 *
 * `extraDroppedAncestors` are spans dropped for other reasons (global/local
 * name blocks). Folding them in lets the peel "see through" them: a candidate
 * whose only surviving ancestor was a name-blocked span becomes root-connected
 * once that span is dropped, and so must be dropped too rather than promoted to
 * a root it is not allowed to be.
 *
 * @returns `{ dropped, droppedParentMap }` — the dropped span ids and a map of
 *   each dropped span id to its parent `SpanContext` (`undefined` for a true
 *   root) for reparenting.
 */
export function resolveRootDropped(
  spans: ReadableSpan[],
  extraDroppedAncestors?: Map<string, SpanContext | undefined>,
): { dropped: Set<string>; droppedParentMap: Map<string, SpanContext | undefined> } {
  const candidates = collectCandidates(spans);
  // Only genuine root-block candidates trigger a peel; name/local drops alone
  // (with no candidate in play) are handled by the exporter directly.
  if (candidates.size === 0) {
    return { dropped: new Set<string>(), droppedParentMap: new Map() };
  }

  if (extraDroppedAncestors) {
    for (const [spanId, parentCtx] of extraDroppedAncestors) {
      if (!candidates.has(spanId)) {
        candidates.set(spanId, parentCtx);
      }
    }
  }

  const dropped = peelRootConnected(spans, candidates);
  const droppedParentMap = new Map<string, SpanContext | undefined>();
  for (const spanId of dropped) {
    droppedParentMap.set(spanId, candidates.get(spanId));
  }
  return { dropped, droppedParentMap };
}

/**
 * Merge in-batch candidacy markers with the cross-batch registry snapshot.
 *
 * In-batch markers let a marked span be recognised even if its registry entry
 * was evicted or cleared before export. The registry is only consulted for
 * cross-batch ancestry (a batch parent recorded in an earlier batch); when no
 * batch parent references such an entry, the full snapshot is skipped.
 */
function collectCandidates(
  spans: ReadableSpan[],
): Map<string, SpanContext | undefined> {
  const inBatch = new Map<string, SpanContext | undefined>();
  const parentIds = new Set<string>();

  for (const span of spans) {
    const spanId = getSpanId(span);
    if (isRootBlockCandidate(span) && spanId !== null && spanId !== INVALID_SPAN_ID) {
      inBatch.set(spanId, normalizeParent(span.parentSpanContext));
    }
    const parent = span.parentSpanContext;
    const parentId = parent?.spanId;
    if (parentId && parentId !== INVALID_SPAN_ID) {
      parentIds.add(parentId);
    }
  }

  // A registry entry is only walked if it is the parent of some batch span
  // (every in-batch candidate contributes its own parent id here too, covering
  // multi-hop cross-batch chains). Parents resolvable in-batch never need it.
  const unresolvedParents = new Set<string>();
  for (const parentId of parentIds) {
    if (!inBatch.has(parentId)) {
      unresolvedParents.add(parentId);
    }
  }
  if (!rootBlockCandidatesContains(unresolvedParents)) {
    return inBatch;
  }

  const candidates = getRootBlockCandidates();
  for (const [spanId, parentCtx] of inBatch) {
    candidates.set(spanId, parentCtx);
  }
  return candidates;
}

/**
 * Return the candidate span ids that are root-connected (and so dropped).
 * Iterative + memoized (no recursion, so a deep trace cannot blow the stack).
 * Seeded only from batch spans and their parents, so unrelated registry entries
 * are never walked.
 */
function peelRootConnected(
  spans: ReadableSpan[],
  candidates: Map<string, SpanContext | undefined>,
): Set<string> {
  const memo = new Map<string, boolean>();
  const dropped = new Set<string>();

  const isDropped = (startId: string): boolean => {
    const path: string[] = [];
    const onPath = new Set<string>();
    let node = startId;
    let result = false;

    while (true) {
      const memoized = memo.get(node);
      if (memoized !== undefined) {
        result = memoized;
        break;
      }
      if (!candidates.has(node)) {
        // Surviving ancestor — stops the peel.
        result = false;
        break;
      }
      if (onPath.has(node)) {
        // Cycle guard: treat as non-dropped to avoid looping forever.
        result = false;
        break;
      }

      // Fresh candidate node: it shares the chain's terminal verdict.
      path.push(node);
      onPath.add(node);

      const parentCtx = candidates.get(node);
      if (!parentCtx) {
        result = true; // candidate is a true trace root
        break;
      }
      if (parentCtx.isRemote) {
        result = false; // do not peel across a process boundary
        break;
      }
      const parentId = parentCtx.spanId;
      if (!parentId || parentId === INVALID_SPAN_ID) {
        result = true;
        break;
      }
      node = parentId;
    }

    for (const spanId of path) {
      memo.set(spanId, result);
      if (result) {
        dropped.add(spanId);
      }
    }
    return result;
  };

  for (const span of spans) {
    const spanId = getSpanId(span);
    if (spanId !== null && spanId !== INVALID_SPAN_ID) {
      isDropped(spanId);
    }
    const parentId = span.parentSpanContext?.spanId;
    if (parentId && parentId !== INVALID_SPAN_ID) {
      isDropped(parentId);
    }
  }

  return dropped;
}
