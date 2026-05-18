/**
 * Session Span Processor
 *
 * OpenTelemetry span processor that automatically adds session attributes to spans.
 * This includes session_id, user_id, tenant_id from OpenTelemetry baggage, and entity context
 * (workflow, task, agent names) from SessionManager.
 *
 * Uses OpenTelemetry's baggage API for automatic context propagation across async boundaries.
 */

import { context, Context, propagation, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Config } from "../config";
import { SessionManager } from "../session-manager";

/**
 * Get the global context manager if it's available
 * Tries multiple methods to find the effective ContextManager
 */
function getContextManager(): any {
  try {
    // 1. Try standard internal property
    if ((context as any)._getContextManager) {
      return (context as any)._getContextManager();
    }
    
    // 2. Try global symbols (Node.js standard location)
    const globalSymbols = Object.getOwnPropertySymbols(global);
    const otelSymbol = globalSymbols.find(s => s.toString().includes('opentelemetry.js.api'));
    if (otelSymbol) {
      const globalState = (global as any)[otelSymbol];
      if (globalState && globalState.contextManager) {
        return globalState.contextManager;
      }
    }
    
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Helper to execute enterWith on the context manager
 * Handles standard AsyncLocalStorage and OTel wrappers
 */
function safeEnterWith(newContext: Context): void {
  const contextManager = getContextManager();
  
  if (!contextManager) {
    console.warn("ContextManager not found. Baggage may not propagate correctly.");
    return;
  }

  // 1. Direct enterWith (AsyncLocalStorage directly or compatible manager)
  if (typeof contextManager.enterWith === 'function') {
    contextManager.enterWith(newContext);
    return;
  }

  // 2. OTel AsyncHooksContextManager (wraps AsyncLocalStorage in private _asyncLocalStorage)
  if (contextManager._asyncLocalStorage && typeof contextManager._asyncLocalStorage.enterWith === 'function') {
    contextManager._asyncLocalStorage.enterWith(newContext);
    return;
  }
  
  // 3. Fallback: Check for other common wrapping patterns or fail
  console.warn("ContextManager available but enterWith not found. Baggage propagation might fail.");
}

/**
 * Set a session baggage value using OpenTelemetry's baggage API
 * This automatically propagates across async boundaries via AsyncLocalStorage
 */
export function setSessionBaggage(key: string, value: string): void {
  try {
    const currentBaggage = propagation.getBaggage(context.active()) || propagation.createBaggage();
    const newBaggage = currentBaggage.setEntry(key, { value });
    const newContext = propagation.setBaggage(context.active(), newBaggage);

    // Bind the new context to the current async resource
    safeEnterWith(newContext);
  } catch (e) {
    console.error(`SessionSpanProcessor: Failed to set baggage key=${key}:`, e);
  }
}

/**
 * Get a session baggage value using OpenTelemetry's baggage API
 */
export function getSessionBaggage(key: string): string | undefined {
  try {
    const baggage = propagation.getBaggage(context.active());
    return baggage?.getEntry(key)?.value;
  } catch (e) {
    console.error(`SessionSpanProcessor: Failed to get baggage key=${key}:`, e);
    return undefined;
  }
}

/**
 * Clear all session baggage from the current context
 */
export function clearSessionBaggage(): void {
  try {
    const emptyBaggage = propagation.createBaggage();
    const newContext = propagation.setBaggage(context.active(), emptyBaggage);

    safeEnterWith(newContext);
  } catch (e) {
    console.error("SessionSpanProcessor: Failed to clear baggage:", e);
  }
}

export class SessionSpanProcessor implements SpanProcessor {
  /**
   * Called when a span starts. Adds session and entity context attributes.
   */
  onStart(span: Span, parentContext: Context): void {
    try {
      // Add library metadata
      span.setAttribute("library.name", Config.LIBRARY_NAME);
      span.setAttribute("library.version", Config.LIBRARY_VERSION);
      span.setAttribute("sdk.name", Config.SDK_NAME);

      // Get baggage from the parent context (or current if not provided)
      const ctxToUse = parentContext || context.active();
      const baggage = propagation.getBaggage(ctxToUse);

      // Add session context from OpenTelemetry baggage
      const sessionId = baggage?.getEntry("session_id")?.value;
      const userId = baggage?.getEntry("user_id")?.value;
      const tenantId = baggage?.getEntry("tenant_id")?.value;

      if (sessionId) {
        span.setAttribute(`${Config.LIBRARY_NAME}.session_id`, sessionId);
      }
      if (userId) {
        span.setAttribute(`${Config.LIBRARY_NAME}.user_id`, userId);
      }
      if (tenantId) {
        span.setAttribute(`${Config.LIBRARY_NAME}.tenant_id`, tenantId);
      }

      // Add custom attributes from baggage
      const customKeys = baggage?.getEntry("custom_keys")?.value;
      if (customKeys) {
        for (const key of customKeys.split(",")) {
          const value = baggage?.getEntry(`custom.${key}`)?.value;
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
