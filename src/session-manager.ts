/**
 * Session Manager for tracking user sessions and context
 */

import { Span, context, trace } from "@opentelemetry/api";
import { Config } from "./config";

export enum ConversationType {
  INPUT = "input",
  OUTPUT = "output",
}

export class SessionManager {
  private static _currentSpan: Span | undefined;
  private static _workflowStack: string[] = [];
  private static _taskStack: string[] = [];
  private static _agentStack: string[] = [];
  private static _spanStack: string[] = [];
  private static _spansByName: Map<string, Span[]> = new Map();
  private static _activeSpans: Span[] = [];

  static setCurrentSpan(span: Span | undefined): void {
    this._currentSpan = span;
  }

  static getCurrentSpan(): Span | undefined {
    return this._currentSpan;
  }

  static registerSpan(name: string, span: Span): void {
    try {
      const stack = this._spansByName.get(name) || [];
      stack.push(span);
      this._spansByName.set(name, stack);
      this._activeSpans.push(span);
    } catch (e) {
      console.error(`Failed to register span '${name}':`, e);
    }
  }

  static unregisterSpan(name: string, span: Span): void {
    try {
      const stack = this._spansByName.get(name);
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
        this._spansByName.delete(name);
      }

      // Remove from global active list
      for (let i = this._activeSpans.length - 1; i >= 0; i--) {
        if (this._activeSpans[i] === span) {
          this._activeSpans.splice(i, 1);
          break;
        }
      }
    } catch (e) {
      console.error(`Failed to unregister span '${name}':`, e);
    }
  }

  static getSpanByName(name: string): Span | undefined {
    const stack = this._spansByName.get(name);
    return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
  }

  static pushEntity(entityType: string, entityName: string): void {
    switch (entityType) {
      case "workflow":
        this._workflowStack.push(entityName);
        break;
      case "task":
        this._taskStack.push(entityName);
        break;
      case "agent":
        this._agentStack.push(entityName);
        break;
      case "span":
        this._spanStack.push(entityName);
        break;
    }
  }

  static popEntity(entityType: string): string | undefined {
    switch (entityType) {
      case "workflow":
        return this._workflowStack.pop();
      case "task":
        return this._taskStack.pop();
      case "agent":
        return this._agentStack.pop();
      case "span":
        return this._spanStack.pop();
      default:
        return undefined;
    }
  }

  static getCurrentEntityAttributes(): Record<string, string> {
    const attributes: Record<string, string> = {};

    if (this._workflowStack.length > 0) {
      attributes[`${Config.LIBRARY_NAME}.workflow.name`] =
        this._workflowStack[this._workflowStack.length - 1];
    }

    if (this._taskStack.length > 0) {
      attributes[`${Config.LIBRARY_NAME}.task.name`] =
        this._taskStack[this._taskStack.length - 1];
    }

    if (this._agentStack.length > 0) {
      attributes[`${Config.LIBRARY_NAME}.agent.name`] =
        this._agentStack[this._agentStack.length - 1];
    }

    if (this._spanStack.length > 0) {
      attributes[`${Config.LIBRARY_NAME}.span.name`] =
        this._spanStack[this._spanStack.length - 1];
    }

    return attributes;
  }

  static clearEntityStacks(): void {
    this._workflowStack = [];
    this._taskStack = [];
    this._agentStack = [];
    this._spanStack = [];
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

      // Get existing conversation
      const existing: Array<{
        type: string;
        role: string;
        content: string | Record<string, any>;
        format: string;
      }> = [];

      // Try to get existing conversation from span attributes
      // Note: This is a simplified version - in production you'd need to access span internals
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


