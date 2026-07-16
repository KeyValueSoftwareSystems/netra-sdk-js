import { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { SpanContext } from "@opentelemetry/api";
import { Config } from "../config";
import { Logger } from "../logger";
import {
  getRootBlockCandidatesFor,
  isRootBlockCandidate,
  rootBlockCandidatesContains,
  INVALID_SPAN_ID,
} from "../processors/root-instrument-filter-processor";

export { INVALID_SPAN_ID };

let trialBlockedAt: number | null = null;
const blockedTraceIds = new Set<string>();

/**
 * Set the trial-blocked status, with automatic expiration.
 *
 * When called with `blocked=true`, starts a timer: all span exports are blocked
 * for `Config.TRIAL_BLOCK_DURATION_SECONDS`. After that window, exports resume
 * automatically even if this function is never called again. Calling with
 * `blocked=false` clears the block immediately.
 */
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

/**
 * Check whether the trial is currently blocked.
 *
 * Returns `false` automatically once `Config.TRIAL_BLOCK_DURATION_SECONDS` have
 * elapsed since the block started, even if `setTrialBlocked(true)` was never
 * called again.
 */
export function isTrialBlocked(): boolean {
  if (trialBlockedAt === null) return false;

  const elapsed = (Date.now() - trialBlockedAt) / 1000;

  if (elapsed >= Config.TRIAL_BLOCK_DURATION_SECONDS) {
    trialBlockedAt = null;
    return false;
  }

  return true;
}

/**
 * Add a trace ID to the blocked list.
 *
 * Trace IDs seen during a block are remembered so their later spans are dropped
 * too — even after the block window expires. Only trace IDs created after the
 * block clears will be exported again.
 */
export function addBlockedTraceId(traceId: string) {
  blockedTraceIds.add(traceId);
}

/** Check whether a trace ID is in the blocked list. */
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
 * Find the root-block candidates in `spans` that must be dropped.
 *
 * A candidate is dropped when it is *root-connected*: it is a trace root (no
 * local parent), or every ancestor between it and the trace root is itself
 * dropped. Walking up the ancestor chain stops at the first surviving ancestor
 * — an allowed instrument, a netra/manual span, or a non-instrumentation span —
 * and never crosses a remote (cross-process) parent link.
 *
 * `parentsOfSpansBlockedByName` are spans dropped for *other* reasons (a global
 * or per-span local name block) that are removed from the exported tree just
 * like candidates. Folding them in lets the walk "see through" them: a candidate
 * whose only surviving ancestor was a name-blocked span becomes root-connected
 * once that span is dropped, and so must be dropped too rather than promoted to
 * a root it is not allowed to be.
 *
 * The candidate set is the registry snapshot overlaid with any span in the
 * current batch that carries the durable candidacy marker. The overlay makes
 * the decision robust: a blocked root still in the batch is dropped even if its
 * registry entry was evicted (TTL/overflow) or cleared, because the marker
 * travels with the span. Only ancestor chains reachable from this batch are
 * evaluated, so the cost is proportional to the batch (plus its ancestry)
 * rather than to the whole registry.
 *
 * @returns `{ rootConnectedIds, parentsOfRootSpansBlocked }` — the dropped span
 *   ids and a map of each dropped span id to its parent `SpanContext`
 *   (`undefined` for a true root) for reparenting.
 */
export function findRootSpansBlocked(
  spans: ReadableSpan[],
  parentsOfSpansBlockedByName?: Map<string, SpanContext | undefined>,
): {
  rootConnectedIds: Set<string>;
  parentsOfRootSpansBlocked: Map<string, SpanContext | undefined>;
} {
  const candidates = collectRootBlockCandidates(spans);
  // Only genuine root-block candidates trigger a chain walk; name/local drops
  // alone (with no candidate in play) are handled by the caller directly.
  if (candidates.size === 0) {
    return { rootConnectedIds: new Set<string>(), parentsOfRootSpansBlocked: new Map() };
  }

  if (parentsOfSpansBlockedByName) {
    for (const [spanId, parentCtx] of parentsOfSpansBlockedByName) {
      if (!candidates.has(spanId)) {
        candidates.set(spanId, parentCtx);
      }
    }
  }

  const rootConnectedIds = findRootConnectedCandidates(spans, candidates);
  const parentsOfRootSpansBlocked = new Map<string, SpanContext | undefined>();
  for (const spanId of rootConnectedIds) {
    parentsOfRootSpansBlocked.set(spanId, candidates.get(spanId));
  }
  return { rootConnectedIds, parentsOfRootSpansBlocked };
}

/**
 * Merge in-batch candidacy markers with the cross-batch registry.
 *
 * The in-batch markers let a marked span be recognised even if its registry
 * entry was evicted or cleared before export. The registry is only consulted
 * for *cross-batch* ancestry — a batch parent whose candidacy was recorded in
 * an earlier batch. When no batch parent references such an entry, the full
 * registry snapshot is skipped entirely, and otherwise only the reachable
 * ancestry is walked.
 *
 * @returns A `{spanId -> parentSpanContext}` map of every relevant candidate,
 *   with in-batch markers overriding the registry snapshot.
 */
function collectRootBlockCandidates(
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

  // Walk only the ancestry reachable from the batch's unresolved parents rather
  // than copying the whole registry.
  const candidates = getRootBlockCandidatesFor(unresolvedParents);
  for (const [spanId, parentCtx] of inBatch) {
    candidates.set(spanId, parentCtx);
  }
  return candidates;
}

/**
 * Return the candidate span ids that are root-connected (and so dropped).
 *
 * Walks each candidate's ancestry chain iteratively and memoized — no recursion,
 * so a deeply nested trace cannot blow the stack. Every node on a linear
 * candidate chain shares the terminal verdict (the chain is dropped iff it walks
 * all the way up to a true root), so the resolved result is written back to the
 * whole walked path in one pass. The walk is seeded only from batch spans and
 * their parents, so unrelated registry entries are never walked.
 */
function findRootConnectedCandidates(
  spans: ReadableSpan[],
  candidates: Map<string, SpanContext | undefined>,
): Set<string> {
  const memo = new Map<string, boolean>();
  const rootConnectedIds = new Set<string>();

  const resolvesToRoot = (startId: string): boolean => {
    const walkedIds: string[] = [];
    const seenIds = new Set<string>();
    let currentId = startId;
    let reachesRoot = false;

    while (true) {
      const memoized = memo.get(currentId);
      if (memoized !== undefined) {
        reachesRoot = memoized;
        break;
      }
      if (!candidates.has(currentId)) {
        // Not a candidate -> a surviving ancestor. Stops the walk.
        reachesRoot = false;
        break;
      }
      if (seenIds.has(currentId)) {
        // Cycle guard: treat as non-dropped to avoid looping forever.
        reachesRoot = false;
        break;
      }

      // Fresh candidate node: it shares the chain's terminal verdict.
      walkedIds.push(currentId);
      seenIds.add(currentId);

      const parentCtx = candidates.get(currentId);
      if (!parentCtx) {
        reachesRoot = true; // candidate is a true trace root
        break;
      }
      if (parentCtx.isRemote) {
        reachesRoot = false; // do not walk across a process boundary
        break;
      }
      const parentId = parentCtx.spanId;
      if (!parentId || parentId === INVALID_SPAN_ID) {
        reachesRoot = true;
        break;
      }
      currentId = parentId;
    }

    for (const spanId of walkedIds) {
      memo.set(spanId, reachesRoot);
      if (reachesRoot) {
        rootConnectedIds.add(spanId);
      }
    }
    return reachesRoot;
  };

  for (const span of spans) {
    const spanId = getSpanId(span);
    if (spanId !== null && spanId !== INVALID_SPAN_ID) {
      resolvesToRoot(spanId);
    }
    const parentId = span.parentSpanContext?.spanId;
    if (parentId && parentId !== INVALID_SPAN_ID) {
      resolvesToRoot(parentId);
    }
  }

  return rootConnectedIds;
}
