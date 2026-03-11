/**
 * Session Manager for tracking user sessions and context
 *
 * Uses AsyncLocalStorage for entity stacks (workflow, task, agent)
 * and OpenTelemetry's baggage API for session context (session_id, user_id, tenant_id).
 * This provides proper concurrency support for multi-request environments.
 */

import { Span, context, trace } from "@opentelemetry/api";
import { AsyncLocalStorage } from "async_hooks";
import { Config } from "./config";

export enum ConversationType {
  INPUT = "input",
  OUTPUT = "output",
}

/**
 * Context for entity tracking (workflow, task, agent, span hierarchies)
 * This is request-scoped via AsyncLocalStorage and does NOT propagate across process boundaries
 */
interface EntityContext {
  currentSpan?: Span;
  rootSpan?: Span;
  workflowStack: string[];
  taskStack: string[];
  agentStack: string[];
  spanStack: string[];
  spansByName: Map<string, Span[]>;
  activeSpans: Span[];
  conversations: Map<Span, any[]>;
}

// AsyncLocalStorage for entity context (internal SDK state)
const entityStorage = new AsyncLocalStorage<EntityContext>();

// Global fallback context for single-threaded applications
const globalFallbackContext: EntityContext = {
  workflowStack: [],
  taskStack: [],
  agentStack: [],
  spanStack: [],
  spansByName: new Map(),
  activeSpans: [],
  conversations: new Map(),
};

/**
 * Get or create entity context for the current async scope
 */
function getOrCreateEntityContext(): EntityContext {
  let ctx = entityStorage.getStore();
  if (!ctx) {
    // Fallback to global context for backwards compatibility
    ctx = globalFallbackContext;
  }
  return ctx;
}

/**
 * Run a function with an isolated entity context
 * This is useful for concurrent operations that need separate entity tracking
 */
export function runWithEntityContext<T>(fn: () => T): T {
  const newContext: EntityContext = {
    workflowStack: [],
    taskStack: [],
    agentStack: [],
    spanStack: [],
    spansByName: new Map(),
    activeSpans: [],
    conversations: new Map(),
  };
  return entityStorage.run(newContext, fn);
}

export class SessionManager {
  static setCurrentSpan(span: Span | undefined): void {
    const ctx = getOrCreateEntityContext();
    ctx.currentSpan = span;
  }

  static getCurrentSpan(): Span | undefined {
    const ctx = getOrCreateEntityContext();
    return ctx.currentSpan;
  }

  static setRootSpan(span: Span | undefined): void {
    const ctx = getOrCreateEntityContext();
    ctx.rootSpan = span;
  }

  static getRootSpan(): Span | undefined {
    const ctx = getOrCreateEntityContext();
    return ctx.rootSpan;
  }

  static registerSpan(name: string, span: Span): void {
    try {
      const ctx = getOrCreateEntityContext();
      const stack = ctx.spansByName.get(name) || [];
      stack.push(span);
      ctx.spansByName.set(name, stack);
      ctx.activeSpans.push(span);
    } catch (e) {
      console.error(`Failed to register span '${name}':`, e);
    }
  }

  static unregisterSpan(name: string, span: Span): void {
    try {
      const ctx = getOrCreateEntityContext();
      const stack = ctx.spansByName.get(name);
      if (!stack) {
        return;
      }

      // Remove the last matching instance
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === span) {
          stack.splice(i, 1);
          break;
        }
      }

      if (stack.length === 0) {
        ctx.spansByName.delete(name);
      }

      // Remove from global active list
      for (let i = ctx.activeSpans.length - 1; i >= 0; i--) {
        if (ctx.activeSpans[i] === span) {
          ctx.activeSpans.splice(i, 1);
          break;
        }
      }
    } catch (e) {
      console.error(`Failed to unregister span '${name}':`, e);
    }
  }

  static getSpanByName(name: string): Span | undefined {
    const ctx = getOrCreateEntityContext();
    const stack = ctx.spansByName.get(name);
    return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
  }

  static pushEntity(entityType: string, entityName: string): void {
    const ctx = getOrCreateEntityContext();
    switch (entityType) {
      case "workflow":
        ctx.workflowStack.push(entityName);
        break;
      case "task":
        ctx.taskStack.push(entityName);
        break;
      case "agent":
        ctx.agentStack.push(entityName);
        break;
      case "span":
        ctx.spanStack.push(entityName);
        break;
    }
  }

  static popEntity(entityType: string): string | undefined {
    const ctx = getOrCreateEntityContext();
    switch (entityType) {
      case "workflow":
        return ctx.workflowStack.pop();
      case "task":
        return ctx.taskStack.pop();
      case "agent":
        return ctx.agentStack.pop();
      case "span":
        return ctx.spanStack.pop();
      default:
        return undefined;
    }
  }

  static getCurrentEntityAttributes(): Record<string, string> {
    const ctx = getOrCreateEntityContext();
    const attributes: Record<string, string> = {};

    if (ctx.workflowStack.length > 0) {
      attributes[`${Config.LIBRARY_NAME}.workflow.name`] =
        ctx.workflowStack[ctx.workflowStack.length - 1];
    }

    if (ctx.taskStack.length > 0) {
      attributes[`${Config.LIBRARY_NAME}.task.name`] =
        ctx.taskStack[ctx.taskStack.length - 1];
    }

    if (ctx.agentStack.length > 0) {
      attributes[`${Config.LIBRARY_NAME}.agent.name`] =
        ctx.agentStack[ctx.agentStack.length - 1];
    }

    if (ctx.spanStack.length > 0) {
      attributes[`${Config.LIBRARY_NAME}.span.name`] =
        ctx.spanStack[ctx.spanStack.length - 1];
    }

    return attributes;
  }

  static clearEntityStacks(): void {
    const ctx = getOrCreateEntityContext();
    ctx.workflowStack = [];
    ctx.taskStack = [];
    ctx.agentStack = [];
    ctx.spanStack = [];
  }

  static setSessionContext(
    sessionKey: string,
    value: string | Record<string, string>
  ): void {
    try {
      if (typeof value === "string" && value) {
        // Set session context as span attributes on the active span
        const span = trace.getActiveSpan();
        if (span && span.isRecording()) {
          span.setAttribute(`${Config.LIBRARY_NAME}.${sessionKey}`, value);
        }
      }
    } catch (e) {
      console.error(`Failed to set session context for key=${sessionKey}:`, e);
    }
  }

  static setCustomEvent(name: string, attributes: Record<string, any>): void {
    try {
      const currentSpan = this.getCurrentSpan();
      const timestamp = Date.now();

      if (currentSpan && currentSpan.isRecording()) {
        currentSpan.addEvent(name, attributes, timestamp);
      } else {
        const ctx = context.active();
        const tracer = trace.getTracer(__filename);
        tracer.startActiveSpan(
          `${Config.LIBRARY_NAME}.${name}`,
          { attributes },
          ctx,
          (span: Span) => {
            span.addEvent(name, attributes, timestamp);
            span.end();
          }
        );
      }
    } catch (e) {
      console.error(`Failed to add custom event: ${name} -`, e);
    }
  }

  static addConversation(
    conversationType: ConversationType,
    role: string,
    content: string | Record<string, any>
  ): void {
    if (!role || !content) {
      console.error("add_conversation: role and content must be provided");
      return;
    }

    try {
      const span = trace.getActiveSpan();
      if (!span || !span.isRecording()) {
        console.warn("No active span to add conversation attribute.");
        return;
      }

      // Get or create conversation history for this span in the current context
      const ctx = getOrCreateEntityContext();
      const existing = ctx.conversations.get(span) || [];

      const maxLen = Config.CONVERSATION_MAX_LEN;
      const processedContent =
        typeof content === "string"
          ? content.substring(0, maxLen)
          : content;

      const entry = {
        type: conversationType,
        role,
        content: processedContent,
        format: typeof processedContent === "string" ? "text" : "json",
      };

      existing.push(entry);
      ctx.conversations.set(span, existing);

      // Set conversation attribute
      span.setAttribute("conversation", JSON.stringify(existing));
    } catch (e) {
      console.error("Failed to add conversation attribute:", e);
    }
  }

  static setAttributeOnActiveSpan(
    attrKey: string,
    attrValue: any
  ): void {
    try {
      const span = trace.getActiveSpan();
      if (span && span.isRecording()) {
        const value =
          typeof attrValue === "string"
            ? attrValue
            : JSON.stringify(attrValue);
        span.setAttribute(attrKey, value);
      } else {
        console.warn(`No active span to set attribute '${attrKey}'`);
      }
    } catch (e) {
      console.error(`Failed to set attribute '${attrKey}' on active span:`, e);
    }
  }
}
