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
 */
const ENTITY_ATTR_SUFFIXES: Record<string, string> = {
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
    const frame = new EntityFrame(entityName);
    switch (entityType) {
      case "workflow": ctx.workflowStack.push(frame); break;
      case "task":     ctx.taskStack.push(frame);     break;
      case "agent":    ctx.agentStack.push(frame);    break;
      case "span":     ctx.spanStack.push(frame);     break;
      default:         return undefined;
    }
    return frame;
  }

  static popEntity(entityType: string, token?: EntityFrame): string | undefined {
    const ctx = getEntityContext();
    let stack: EntityFrame[] | undefined;
    switch (entityType) {
      case "workflow": stack = ctx.workflowStack; break;
      case "task":     stack = ctx.taskStack;     break;
      case "agent":    stack = ctx.agentStack;    break;
      case "span":     stack = ctx.spanStack;     break;
    }
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
      let stack: EntityFrame[] | undefined;
      switch (entityType) {
        case "workflow": stack = ctx.workflowStack; break;
        case "task":     stack = ctx.taskStack;     break;
        case "agent":    stack = ctx.agentStack;    break;
        case "span":     stack = ctx.spanStack;     break;
      }
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
   */
  static updateSpanName(span: Span, newName: string): void {
    const entry = spanEntityFrames.get(span);
    if (entry) {
      const suffix = ENTITY_ATTR_SUFFIXES[entry.entityType];
      entry.frame.name = newName;
      if (suffix) {
        span.setAttribute(`${Config.LIBRARY_NAME}.${suffix}`, newName);
      }
    }
    span.updateName(newName);
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
