/**
 * Session Span Processor
 *
 * OpenTelemetry span processor that automatically adds session attributes to spans.
 * This includes session_id, user_id, tenant_id from the context store, and entity context
 * (workflow, task, agent names) from SessionManager.
 *
 * Uses ContextStore for concurrency-safe session management - each concurrent request
 * has its own isolated session context.
 */

import { Context, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Config } from "../config";
import { SessionManager } from "../session-manager";
import { ContextStore } from "../context-store";

/**
 * Sets a session baggage value in the current context.
 * This is concurrency-safe - each request has its own isolated context.
 */
export function setSessionBaggage(key: string, value: string): void {
  const ctx = ContextStore.getOrCreateContext();
  switch (key) {
    case "session_id":
      ctx.sessionId = value;
      break;
    case "user_id":
      ctx.userId = value;
      break;
    case "tenant_id":
      ctx.tenantId = value;
      break;
    default:
      // Store as custom attribute
      if (key.startsWith("custom.")) {
        ctx.customAttributes.set(key.substring(7), value);
      } else {
        ctx.customAttributes.set(key, value);
      }
  }
}

/**
 * Gets a session baggage value from the current context.
 * Returns undefined if the value is not set or no context exists.
 */
export function getSessionBaggage(key: string): string | undefined {
  const ctx = ContextStore.getContext();
  if (!ctx) {
    return undefined;
  }

  switch (key) {
    case "session_id":
      return ctx.sessionId;
    case "user_id":
      return ctx.userId;
    case "tenant_id":
      return ctx.tenantId;
    case "custom_keys":
      // Return comma-separated list of custom attribute keys
      return ctx.customAttributes.size > 0
        ? Array.from(ctx.customAttributes.keys()).join(",")
        : undefined;
    default:
      // Check custom attributes
      if (key.startsWith("custom.")) {
        return ctx.customAttributes.get(key.substring(7));
      }
      return ctx.customAttributes.get(key);
  }
}

/**
 * Clears all session baggage from the current context.
 */
export function clearSessionBaggage(): void {
  const ctx = ContextStore.getContext();
  if (ctx) {
    ctx.sessionId = undefined;
    ctx.userId = undefined;
    ctx.tenantId = undefined;
    ctx.customAttributes.clear();
  }
}

export class SessionSpanProcessor implements SpanProcessor {
  /**
   * Called when a span starts. Adds session and entity context attributes.
   */
  onStart(span: Span, parentContext: Context): void {
    try {
      // Store the current span in SessionManager
      SessionManager.setCurrentSpan(span);

      // Add library metadata
      span.setAttribute("library.name", Config.LIBRARY_NAME);
      span.setAttribute("library.version", Config.LIBRARY_VERSION);
      span.setAttribute("sdk.name", Config.SDK_NAME);

      // Add session context from context store
      const sessionId = getSessionBaggage("session_id");
      const userId = getSessionBaggage("user_id");
      const tenantId = getSessionBaggage("tenant_id");

      if (sessionId) {
        span.setAttribute(`${Config.LIBRARY_NAME}.session_id`, sessionId);
      }
      if (userId) {
        span.setAttribute(`${Config.LIBRARY_NAME}.user_id`, userId);
      }
      if (tenantId) {
        span.setAttribute(`${Config.LIBRARY_NAME}.tenant_id`, tenantId);
      }

      // Add custom attributes from context store
      const customKeys = getSessionBaggage("custom_keys");
      if (customKeys) {
        for (const key of customKeys.split(",")) {
          const value = getSessionBaggage(`custom.${key}`);
          if (value) {
            span.setAttribute(`${Config.LIBRARY_NAME}.custom.${key}`, value);
          }
        }
      }

      // Add entity attributes from SessionManager (workflow, task, agent context)
      const entityAttributes = SessionManager.getCurrentEntityAttributes();
      for (const [attrKey, attrValue] of Object.entries(entityAttributes)) {
        span.setAttribute(attrKey, attrValue);
      }
    } catch (e) {
      console.error("SessionSpanProcessor: Error setting span attributes:", e);
    }
  }

  /**
   * Called when a span ends. No-op for this processor.
   */
  onEnd(span: ReadableSpan): void {
    // No-op
  }

  /**
   * Shuts down the processor.
   */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Forces a flush of any pending spans.
   */
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
