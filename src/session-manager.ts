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
import { NetraLogger } from "./netraLogger";
import { RootSpanProcessor } from "./processors/root-span-processor";
import { ConversationType } from "./types";
import { safeStringify } from "./utils/serialization";

export { ConversationType };

const MODULE_NAME = "netra.session-manager";

/**
 * Per-async-scope state: entity name stacks and a name→span registry.
 * Deliberately minimal — live span references belong to OTel's context, not here.
 *
 * A scope is never mutated by a nested call: entering an entity copies the
 * scope (`runWithEntity`), and the registry is copy-on-write. Each decorated
 * call therefore sees only its own ancestors, concurrent requests cannot
 * interleave their stacks (JS-SEC-018), and a scope's state is released with
 * the scope instead of living in a module global (JS-MEM-005).
 */
interface EntityContext {
  readonly workflowStack: readonly string[];
  readonly taskStack: readonly string[];
  readonly agentStack: readonly string[];
  readonly spanStack: readonly string[];
  readonly spansByName: Map<string, readonly Span[]>;
}

type EntityStackKey = "workflowStack" | "taskStack" | "agentStack" | "spanStack";

const STACK_FOR_ENTITY: Record<string, EntityStackKey> = {
  workflow: "workflowStack",
  task: "taskStack",
  agent: "agentStack",
  span: "spanStack",
};

type ConversationEntry = {
  type: string;
  role: string;
  content: string | Record<string, any>;
  format: string;
};

const entityStorage = new AsyncLocalStorage<EntityContext>();

// Read-only state for code running outside any entity scope. Never mutated.
const EMPTY_ENTITY_CONTEXT: EntityContext = Object.freeze({
  workflowStack: Object.freeze([]),
  taskStack: Object.freeze([]),
  agentStack: Object.freeze([]),
  spanStack: Object.freeze([]),
  spansByName: new Map<string, readonly Span[]>(),
});

function getEntityContext(): EntityContext {
  return entityStorage.getStore() ?? EMPTY_ENTITY_CONTEXT;
}

function copyEntityContext(ctx: EntityContext): EntityContext {
  return {
    workflowStack: ctx.workflowStack,
    taskStack: ctx.taskStack,
    agentStack: ctx.agentStack,
    spanStack: ctx.spanStack,
    spansByName: new Map(ctx.spansByName),
  };
}

/**
 * Run `fn` with a fresh, isolated entity context.
 * Use this when spawning concurrent async operations that should have
 * independent entity stacks.
 */
export function runWithEntityContext<T>(fn: () => T): T {
  return entityStorage.run(copyEntityContext(EMPTY_ENTITY_CONTEXT), fn);
}

/**
 * Run `fn` in a new entity scope: a copy of the caller's scope with
 * `entityName` pushed onto the `entityType` stack. Spans started inside `fn`
 * (synchronously or in its async continuations) see it; the caller's scope
 * and concurrent calls never do. Unknown entity types get a plain copy.
 */
export function runWithEntity<T>(entityType: string, entityName: string, fn: () => T): T {
  const next = copyEntityContext(getEntityContext()) as {
    -readonly [K in keyof EntityContext]: EntityContext[K];
  };
  const key = STACK_FOR_ENTITY[entityType];
  if (key) next[key] = [...next[key], entityName];
  return entityStorage.run(next, fn);
}

// SessionManager

export class SessionManager {

  // Span registry (name → stack), scoped to the current entity scope

  static registerSpan(name: string, span: Span): void {
    try {
      // Outside any entity scope there is nowhere request-local to keep it;
      // a module-level registry would retain spans that never end (JS-MEM-005).
      const ctx = entityStorage.getStore();
      if (!ctx) return;
      ctx.spansByName.set(name, [...(ctx.spansByName.get(name) ?? []), span]);
    } catch (e) {
      NetraLogger.error(`Failed to register span '${name}':`, e);
    }
  }

  static unregisterSpan(name: string, span: Span): void {
    try {
      const ctx = entityStorage.getStore();
      const stack = ctx?.spansByName.get(name);
      if (!ctx || !stack) return;
      const idx = stack.lastIndexOf(span);
      if (idx === -1) return;
      const next = [...stack.slice(0, idx), ...stack.slice(idx + 1)];
      if (next.length === 0) ctx.spansByName.delete(name);
      else ctx.spansByName.set(name, next);
    } catch (e) {
      NetraLogger.error(`Failed to unregister span '${name}':`, e);
    }
  }

  static getSpanByName(name: string): Span | undefined {
    const ctx = getEntityContext();
    const stack = ctx.spansByName.get(name);
    return stack?.length ? stack[stack.length - 1] : undefined;
  }

  // Entity stacks (workflow / task / agent / span)

  static getCurrentEntityAttributes(): Record<string, string> {
    const ctx = getEntityContext();
    const attrs: Record<string, string> = {};
    const last = <T>(arr: readonly T[]) => arr[arr.length - 1];
    if (ctx.workflowStack.length) attrs[`${Config.LIBRARY_NAME}.workflow.name`] = last(ctx.workflowStack)!;
    if (ctx.taskStack.length)     attrs[`${Config.LIBRARY_NAME}.task.name`]     = last(ctx.taskStack)!;
    if (ctx.agentStack.length)    attrs[`${Config.LIBRARY_NAME}.agent.name`]    = last(ctx.agentStack)!;
    if (ctx.spanStack.length)     attrs[`${Config.LIBRARY_NAME}.span.name`]     = last(ctx.spanStack)!;
    return attrs;
  }

  /**
   * Clear the entity stacks for the rest of the current async flow. The
   * caller's enclosing scope is not modified.
   */
  static clearEntityStacks(): void {
    const ctx = entityStorage.getStore();
    if (!ctx) return;
    entityStorage.enterWith({ ...copyEntityContext(ctx), workflowStack: [], taskStack: [], agentStack: [], spanStack: [] });
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
        NetraLogger.warn(`setAttributeOnActiveSpan: no recording span for key '${key}'`);
      }
    } catch (e) {
      NetraLogger.error(`Failed to set attribute '${key}' on active span:`, e);
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
      NetraLogger.error("setInput failed:", e);
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
      NetraLogger.error("setOutput failed:", e);
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
      NetraLogger.error("setRootInput failed:", e);
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
      NetraLogger.error("setRootOutput failed:", e);
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
      NetraLogger.error(`setCustomEvent '${name}' failed:`, e);
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
      NetraLogger.notice("error", "addConversation: role and content must be provided");
      return;
    }

    try {
      const span = trace.getActiveSpan();
      if (!span?.isRecording()) {
        NetraLogger.warn("addConversation: no active recording span");
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
        NetraLogger.warn("addConversation: failed to parse existing conversation, starting fresh:", e);
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
      NetraLogger.error("addConversation failed:", e);
    }
  }
}
