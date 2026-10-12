/**
 * Session Manager — entity stack tracking and span annotation utilities.
 *
 * Uses AsyncLocalStorage for per-async-scope entity stacks (workflow, task,
 * agent, span) so concurrent requests stay isolated. All span resolution and
 * attribute writes delegate to OpenTelemetry's native APIs; no shadow copies
 * of spans are kept here.
 */

import { Span, context, trace } from "@opentelemetry/api";
import { AsyncLocalStorage } from "async_hooks";
import { Config } from "./config";
import { Logger } from "./logger";
import { RootSpanProcessor } from "./processors/root-span-processor";
import { ConversationType } from "./types";
import { safeStringify } from "./utils/serialization";

export { ConversationType };

const MODULE_NAME = "netra.session-manager";

/**
 * A single frame on an entity stack. `name` is mutable so that
 * `SessionManager.updateSpanName` can rename an entity in-place and every
 * async scope that shares this frame (via AsyncLocalStorage) sees the new
 * name immediately — no need to rebind the store.
 */
export class EntityFrame {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

/**
 * Maps each entity type to the `netra.<suffix>` attribute key that carries
 * its name onto spans. Single source of truth shared by
 * `getCurrentEntityAttributes` (stamps at span start) and
 * `SessionManager.updateSpanName` (re-stamps on a live span).
 *
 * Exported so `SpanWrapper` can look up the suffix for a given entity type
 * without duplicating the map.
 */
export const ENTITY_ATTR_SUFFIXES: Record<string, string> = {
  workflow: "workflow.name",
  task: "task.name",
  agent: "agent.name",
  span: "span.name",
};

/**
 * Process-wide mapping from a span to the entity frame it owns.
 * Weak keys ensure entries are garbage-collected when the span is.
 */
const spanEntityFrames = new WeakMap<Span, { entityType: string; frame: EntityFrame }>();

/**
 * Per-async-scope state: entity name stacks and a name→span registry.
 * Deliberately minimal — live span references belong to OTel's context, not here.
 */
interface EntityContext {
  workflowStack: EntityFrame[];
  taskStack: EntityFrame[];
  agentStack: EntityFrame[];
  spanStack: EntityFrame[];
  spansByName: Map<string, Span[]>;
}

type ConversationEntry = {
  type: string;
  role: string;
  content: string | Record<string, any>;
  format: string;
};

const entityStorage = new AsyncLocalStorage<EntityContext>();

const globalFallbackContext: EntityContext = {
  workflowStack: [],
  taskStack: [],
  agentStack: [],
  spanStack: [],
  spansByName: new Map(),
};

function getEntityContext(): EntityContext {
  return entityStorage.getStore() ?? globalFallbackContext;
}

/**
 * Return the entity stack for `entityType` from the given context,
 * or `undefined` for unknown types.
 */
function stackFor(ctx: EntityContext, entityType: string): EntityFrame[] | undefined {
  switch (entityType) {
    case "workflow": return ctx.workflowStack;
    case "task":     return ctx.taskStack;
    case "agent":    return ctx.agentStack;
    case "span":     return ctx.spanStack;
    default:         return undefined;
  }
}

/**
 * Run `fn` with a fresh, isolated entity context.
 * Use this when spawning concurrent async operations that should have
 * independent entity stacks.
 */
export function runWithEntityContext<T>(fn: () => T): T {
  const ctx: EntityContext = {
    workflowStack: [],
    taskStack: [],
    agentStack: [],
    spanStack: [],
    spansByName: new Map(),
  };
  return entityStorage.run(ctx, fn);
}

/**
 * Run `fn` with `frame` pushed onto the entity stack for `entityType`.
 *
 * Creates a shallow copy of the current entity context so the frame is
 * visible to child spans started inside `fn` (via `SessionSpanProcessor`)
 * without mutating the caller's context. Because the same `EntityFrame`
 * object is shared, renames via `SessionManager.updateSpanName` propagate
 * to every async scope that inherited it.
 *
 * This is the `startSpan`-level equivalent of what decorators achieve with
 * `pushEntity` + `startActiveSpan`: it scopes the entity name to the
 * `withActive` callback rather than the global stack.
 */
export function runWithEntityFrame<T>(
  entityType: string,
  frame: EntityFrame,
  fn: () => T,
): T {
  const cur = getEntityContext();
  const next: EntityContext = {
    workflowStack: [...cur.workflowStack],
    taskStack: [...cur.taskStack],
    agentStack: [...cur.agentStack],
    spanStack: [...cur.spanStack],
    spansByName: cur.spansByName,
  };

  stackFor(next, entityType)?.push(frame);
  return entityStorage.run(next, fn);
}

// SessionManager

export class SessionManager {

  // Span registry (name → stack)

  static registerSpan(name: string, span: Span): void {
    try {
      const ctx = getEntityContext();
      const stack = ctx.spansByName.get(name) ?? [];
      stack.push(span);
      ctx.spansByName.set(name, stack);
    } catch (e) {
      Logger.error(`Failed to register span '${name}':`, e);
    }
  }

  static unregisterSpan(name: string, span: Span): void {
    try {
      const ctx = getEntityContext();
      const stack = ctx.spansByName.get(name);
      if (!stack) return;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === span) {
          stack.splice(i, 1);
          break;
        }
      }
      if (stack.length === 0) ctx.spansByName.delete(name);
    } catch (e) {
      Logger.error(`Failed to unregister span '${name}':`, e);
    }
  }

  static getSpanByName(name: string): Span | undefined {
    const ctx = getEntityContext();
    const stack = ctx.spansByName.get(name);
    return stack?.length ? stack[stack.length - 1] : undefined;
  }

  // Entity stacks (workflow / task / agent / span)

  static pushEntity(entityType: string, entityName: string): EntityFrame | undefined {
    const ctx = getEntityContext();
    const stack = stackFor(ctx, entityType);
    if (!stack) return undefined;
    const frame = new EntityFrame(entityName);
    stack.push(frame);
    return frame;
  }

  static popEntity(entityType: string, token?: EntityFrame): string | undefined {
    const stack = stackFor(getEntityContext(), entityType);
    if (!stack?.length) return undefined;
    if (!token) {
      return stack.pop()?.name;
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] === token) {
        const [removed] = stack.splice(i, 1);
        return removed.name;
      }
    }
    return undefined;
  }

  static getCurrentEntityAttributes(): Record<string, string> {
    const ctx = getEntityContext();
    const attrs: Record<string, string> = {};
    for (const [entityType, suffix] of Object.entries(ENTITY_ATTR_SUFFIXES)) {
      const stack = stackFor(ctx, entityType);
      if (stack?.length) {
        attrs[`${Config.LIBRARY_NAME}.${suffix}`] = stack[stack.length - 1].name;
      }
    }
    return attrs;
  }

  /**
   * Record that `span` owns the entity frame pushed with `frame`.
   * Lets `updateSpanName` rename the span's own entity frame. No-op when
   * `frame` is undefined (pushEntity got an unknown entity type).
   */
  static bindSpanToEntity(span: Span, entityType: string, frame: EntityFrame | undefined): void {
    if (!frame) return;
    spanEntityFrames.set(span, { entityType, frame });
  }

  /**
   * Rename `span`, keeping its entity name in sync.
   *
   * Always updates the OpenTelemetry span name. If the span is an entity span
   * (bound via `bindSpanToEntity`), also re-stamps its `netra.<entity>.name`
   * attribute and renames the entity frame so child spans started after this
   * call inherit the new name. Already-started child spans keep the old name.
   *
   * `netra.span.name` is only updated for unbound spans (plain SPAN with no
   * entity binding). For entity spans (agent/task/workflow/span-entity),
   * `netra.span.name` reflects the enclosing `@span` context they are inside
   * and must not be overwritten by the entity rename.
   *
   * Clears `netra.local_blocked` so a span whose old name matched a blocking
   * pattern is not silently dropped after being renamed to a non-blocked name.
   * Also removes the span from any injected `_blockedParentMap` so children
   * are not reparented past the now-unblocked span.
   */
  static updateSpanName(span: Span, newName: string): void {
    try {
      const entry = spanEntityFrames.get(span);
      if (entry) {
        const suffix = ENTITY_ATTR_SUFFIXES[entry.entityType];
        entry.frame.name = newName;
        if (suffix) {
          span.setAttribute(`${Config.LIBRARY_NAME}.${suffix}`, newName);
        }
      } else {
        // Only update netra.span.name for unbound spans (no entity binding).
        // Entity spans get their name via the entity-specific attribute above.
        span.setAttribute(`${Config.LIBRARY_NAME}.span.name`, newName);
      }
      // Clear the local-blocked flag so a span renamed away from a blocked
      // pattern is not silently dropped at export time.
      span.setAttribute("netra.local_blocked", false);
      // Remove from blockedParentMap so children are not reparented past this
      // now-unblocked span.
      SessionManager._removeFromBlockedParentMap(span.spanContext().spanId);
      span.updateName(newName);
    } catch (e) {
      Logger.error("updateSpanName failed:", e);
    }
  }

  /**
   * Injected reference to the `LocalFilteringSpanProcessor`'s blocked parent
   * map. Set once during initialization so `updateSpanName` can remove entries
   * when a span is renamed away from a blocked pattern.
   */
  private static _blockedParentMap?: Map<string, any>;

  /**
   * Inject the `LocalFilteringSpanProcessor`'s mutable blocked parent map.
   * Called once during SDK initialization.
   */
  static setBlockedParentMap(map: Map<string, any>): void {
    SessionManager._blockedParentMap = map;
  }

  /**
   * Remove a span id from the injected blocked parent map.
   */
  static _removeFromBlockedParentMap(spanId: string): void {
    SessionManager._blockedParentMap?.delete(spanId);
  }

  static clearEntityStacks(): void {
    const ctx = getEntityContext();
    ctx.workflowStack = [];
    ctx.taskStack     = [];
    ctx.agentStack    = [];
    ctx.spanStack     = [];
  }

  // OTel context helpers

  /**
   * Returns the trace ID of the currently active span, or undefined if none.
   */
  static getTraceId(): string | undefined {
    const ctx = trace.getActiveSpan()?.spanContext();
    return ctx && trace.isSpanContextValid(ctx) ? ctx.traceId : undefined;
  }

  // Span attribute writers

  /**
   * Set an attribute on the currently active OTel span.
   */
  static setAttributeOnActiveSpan(key: string, value: any): void {
    try {
      const span = trace.getActiveSpan();
      if (span?.isRecording()) {
        span.setAttribute(key, typeof value === "string" ? value : safeStringify(value));
      } else {
        Logger.warn(`setAttributeOnActiveSpan: no recording span for key '${key}'`);
      }
    } catch (e) {
      Logger.error(`Failed to set attribute '${key}' on active span:`, e);
    }
  }

  /**
   * Set input on the currently active span.
   * Writes to `netra.user.input` which SpanIOProcessor intercepts inline
   * and writes directly to `input`, taking priority over decorator/instrumentation.
   */
  static setInput(value: any): void {
    try {
      SessionManager.setAttributeOnActiveSpan(
        "netra.user.input",
        safeStringify(value),
      );
    } catch (e) {
      Logger.error("setInput failed:", e);
    }
  }

  /**
   * Set output on the currently active span.
   * Writes to `netra.user.output` which SpanIOProcessor intercepts inline
   * and writes directly to `output`, taking priority over decorator/instrumentation.
   */
  static setOutput(value: any): void {
    try {
      SessionManager.setAttributeOnActiveSpan(
        "netra.user.output",
        safeStringify(value),
      );
    } catch (e) {
      Logger.error("setOutput failed:", e);
    }
  }

  /**
   * Set input on the root span of the current trace.
   * Delegates to RootSpanProcessor which owns root span bookkeeping.
   * Uses `netra.root.input` for highest priority (overrides even setInput).
   */
  static setRootInput(value: any): void {
    try {
      RootSpanProcessor.setAttributeOnRootSpan(
        "netra.root.input",
        safeStringify(value),
      );
    } catch (e) {
      Logger.error("setRootInput failed:", e);
    }
  }

  /**
   * Set output on the root span of the current trace.
   * Delegates to RootSpanProcessor which owns root span bookkeeping.
   * Uses `netra.root.output` for highest priority (overrides even setOutput).
   */
  static setRootOutput(value: any): void {
    try {
      RootSpanProcessor.setAttributeOnRootSpan(
        "netra.root.output",
        safeStringify(value),
      );
    } catch (e) {
      Logger.error("setRootOutput failed:", e);
    }
  }

  // Events and conversations

  static setCustomEvent(name: string, attributes: Record<string, any>): void {
    try {
      const span = trace.getActiveSpan();
      const timestamp = Date.now();
      if (span?.isRecording()) {
        span.addEvent(name, attributes, timestamp);
      } else {
        // Fallback: create a short-lived span to carry the event
        trace.getTracer(MODULE_NAME).startActiveSpan(
          `${Config.LIBRARY_NAME}.${name}`,
          { attributes },
          context.active(),
          (newSpan: Span) => {
            newSpan.addEvent(name, attributes, timestamp);
            newSpan.end();
          },
        );
      }
    } catch (e) {
      Logger.error(`setCustomEvent '${name}' failed:`, e);
    }
  }

  /**
   * Append a conversation entry to the active span's `conversation` attribute.
   *
   * Reads and re-serialises the existing JSON array so entries accumulate
   * rather than overwrite — matching the Python SDK's behaviour.
   * Uses span.setAttribute so the value flows through the processor pipeline
   * including the SerializationSpanProcessor for proper truncation.
   */
  static addConversation(
    conversationType: ConversationType,
    role: string,
    content: string | Record<string, any>,
  ): void {
    if (!role || !content) {
      Logger.error("addConversation: role and content must be provided");
      return;
    }

    try {
      const span = trace.getActiveSpan();
      if (!span?.isRecording()) {
        Logger.warn("addConversation: no active recording span");
        return;
      }

      let existing: ConversationEntry[] = [];
      try {
        const raw = (span as any).attributes?.["conversation"];
        if (typeof raw === "string") {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            // Filter out truncation markers injected by the serialization processor
            existing = parsed.filter(
              (entry: any) =>
                !(entry && typeof entry === "object" && entry.__truncated__ === true &&
                  Object.keys(entry).length === 1),
            );
          }
        }
      } catch (e) {
        Logger.warn("addConversation: failed to parse existing conversation, starting fresh:", e);
      }

      existing.push({
        type: conversationType,
        role,
        content,
        format: typeof content === "string" ? "text" : "json",
      });

      const payload = JSON.stringify(existing);
      span.setAttribute("conversation", payload);
    } catch (e) {
      Logger.error("addConversation failed:", e);
    }
  }
}
