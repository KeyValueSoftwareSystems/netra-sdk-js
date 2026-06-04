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


const MODULE_NAME = "netra.session-manager";

export enum ConversationType {
  INPUT = "input",
  OUTPUT = "output",
}

/**
 * Per-async-scope state: entity name stacks and a name→span registry.
 * Deliberately minimal — live span references belong to OTel's context, not here.
 */
interface EntityContext {
  workflowStack: string[];
  taskStack: string[];
  agentStack: string[];
  spanStack: string[];
  spansByName: Map<string, Span[]>;
}

const entityStorage = new AsyncLocalStorage<EntityContext>();

// Global fallback for single-threaded / non-async entry points
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

// Internal serialization

function serializeValue(value: any): string {
  if (typeof value === "string") {
    return value.substring(0, Config.ATTRIBUTE_MAX_LEN);
  }
  return JSON.stringify(value).substring(0, Config.ATTRIBUTE_MAX_LEN);
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

  static pushEntity(entityType: string, entityName: string): void {
    const ctx = getEntityContext();
    switch (entityType) {
      case "workflow": ctx.workflowStack.push(entityName); break;
      case "task":     ctx.taskStack.push(entityName);     break;
      case "agent":    ctx.agentStack.push(entityName);    break;
      case "span":     ctx.spanStack.push(entityName);     break;
    }
  }

  static popEntity(entityType: string): string | undefined {
    const ctx = getEntityContext();
    switch (entityType) {
      case "workflow": return ctx.workflowStack.pop();
      case "task":     return ctx.taskStack.pop();
      case "agent":    return ctx.agentStack.pop();
      case "span":     return ctx.spanStack.pop();
      default:         return undefined;
    }
  }

  static getCurrentEntityAttributes(): Record<string, string> {
    const ctx = getEntityContext();
    const attrs: Record<string, string> = {};
    const last = <T>(arr: T[]) => arr[arr.length - 1];
    if (ctx.workflowStack.length) attrs[`${Config.LIBRARY_NAME}.workflow.name`] = last(ctx.workflowStack)!;
    if (ctx.taskStack.length)     attrs[`${Config.LIBRARY_NAME}.task.name`]     = last(ctx.taskStack)!;
    if (ctx.agentStack.length)    attrs[`${Config.LIBRARY_NAME}.agent.name`]    = last(ctx.agentStack)!;
    if (ctx.spanStack.length)     attrs[`${Config.LIBRARY_NAME}.span.name`]     = last(ctx.spanStack)!;
    return attrs;
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
        span.setAttribute(key, typeof value === "string" ? value : JSON.stringify(value));
      } else {
        Logger.warn(`setAttributeOnActiveSpan: no recording span for key '${key}'`);
      }
    } catch (e) {
      Logger.error(`Failed to set attribute '${key}' on active span:`, e);
    }
  }

  /**
   * Set input on the currently active span.
   */
  static setInput(value: any): void {
    try {
      SessionManager.setAttributeOnActiveSpan("input", serializeValue(value));
    } catch (e) {
      Logger.error("setInput failed:", e);
    }
  }

  /**
   * Set output on the currently active span.
   */
  static setOutput(value: any): void {
    try {
      SessionManager.setAttributeOnActiveSpan("output", serializeValue(value));
    } catch (e) {
      Logger.error("setOutput failed:", e);
    }
  }

  /**
   * Set input on the root span of the current trace.
   * Delegates to RootSpanProcessor which owns root span bookkeeping.
   */
  static setRootInput(value: any): void {
    try {
      RootSpanProcessor.setAttributeOnRootSpan("input", serializeValue(value));
    } catch (e) {
      Logger.error("setRootInput failed:", e);
    }
  }

  /**
   * Set output on the root span of the current trace.
   * Delegates to RootSpanProcessor which owns root span bookkeeping.
   */
  static setRootOutput(value: any): void {
    try {
      RootSpanProcessor.setAttributeOnRootSpan("output", serializeValue(value));
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
   * Writes directly to the span's internal attribute store to bypass OTel's
   * per-attribute length truncation on the final payload.
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

      // Read existing entries from the span's internal attribute store
      let existing: Array<{
        type: string;
        role: string;
        content: string | Record<string, any>;
        format: string;
      }> = [];
      try {
        const raw = (span as any)._attributes?.["conversation"];
        if (typeof raw === "string") {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) existing = parsed;
        }
      } catch (e) {
        Logger.warn("addConversation: failed to parse existing conversation, starting fresh:", e);
      }

      const maxLen = Config.CONVERSATION_MAX_LEN;
      const processedContent =
        typeof content === "string" ? content.substring(0, maxLen) : content;

      existing.push({
        type: conversationType,
        role,
        content: processedContent,
        format: typeof processedContent === "string" ? "text" : "json",
      });

      const payload = JSON.stringify(existing);

      // Bypass per-attribute truncation by writing to the internal store directly
      const internalAttrs = (span as any)._attributes;
      if (internalAttrs && typeof internalAttrs === "object") {
        internalAttrs["conversation"] = payload;
      } else {
        span.setAttribute("conversation", payload);
      }
    } catch (e) {
      Logger.error("addConversation failed:", e);
    }
  }
}
