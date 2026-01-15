/**
 * Session Span Processor
 *
 * OpenTelemetry span processor that automatically adds session attributes to spans.
 * This includes session_id, user_id, tenant_id from baggage, and entity context
 * (workflow, task, agent names) from SessionManager.
 */

import { Context, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Config } from "../config";
import { SessionManager } from "../session-manager";

// Simple baggage access - we store session context in a module-level store
// since JS OTel baggage API is more complex to use correctly
const sessionStore: Record<string, string> = {};

export function setSessionBaggage(key: string, value: string): void {
  sessionStore[key] = value;
}

export function getSessionBaggage(key: string): string | undefined {
  return sessionStore[key];
}

export function clearSessionBaggage(): void {
  Object.keys(sessionStore).forEach((key) => delete sessionStore[key]);
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

      // Add session context from our session store
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

      // Add custom attributes from session store
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
