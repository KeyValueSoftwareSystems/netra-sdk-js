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
import { Logger } from "../logger";
import { SessionManager } from "../session-manager";

/**
 * Get the registered OTel context manager.
 * Skips NOOP_CONTEXT_MANAGER (returned when nothing is registered) and falls back
 * to inspecting the OTel global state to handle multiple @opentelemetry/api instances.
 */
function getContextManager(): any {
  try {
    // 1. Try the ContextAPI's delegate — but only if it's a real manager (has _asyncLocalStorage)
    if ((context as any)._getContextManager) {
      const manager = (context as any)._getContextManager();
      if (manager?._asyncLocalStorage != null) {
        return manager;
      }
    }

    // 2. Fallback: read from OTel's globalThis symbol — handles multiple @opentelemetry/api copies.
    // OTel stores { context: ContextAPI, ... } keyed by Symbol('opentelemetry.js.api.<version>').
    // The registered context manager lives at ContextAPI._delegate.
    const globalSymbols = Object.getOwnPropertySymbols(globalThis);
    const otelSymbol = globalSymbols.find(s => s.toString().includes('opentelemetry.js.api'));
    if (otelSymbol) {
      const delegate = (globalThis as any)[otelSymbol]?.context?._delegate;
      if (delegate?._asyncLocalStorage != null) {
        return delegate;
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Binds newContext as the active context for the current async resource,
 * equivalent to Python's otel_context.attach(ctx).
 */
function safeEnterWith(newContext: Context): void {
  const contextManager = getContextManager();

  if (!contextManager) {
    return;
  }

  // AsyncLocalStorageContextManager v2.x has no direct enterWith — go through _asyncLocalStorage
  if (typeof contextManager._asyncLocalStorage?.enterWith === 'function') {
    contextManager._asyncLocalStorage.enterWith(newContext);
    return;
  }

  // Future-proof: some managers may expose enterWith directly
  if (typeof contextManager.enterWith === 'function') {
    contextManager.enterWith(newContext);
    return;
  }

  Logger.warn("SessionSpanProcessor: enterWith not available on context manager; baggage will not propagate.");
}

/**
 * Persistent store for session values (session_id, user_id, tenant_id, etc.).
 *
 * OTel's context.with() / asyncLocalStorage.run() creates isolated scopes — enterWith()
 * inside a span's callback does not propagate to sibling spans started after it. This map
 * lives outside any async scope so values set anywhere (pre-init, inside a span, etc.)
 * are visible to all subsequent spans. OTel baggage from parentContext still takes
 * precedence in onStart to honour cross-process propagated values.
 */
const sessionValues = new Map<string, string>();

/**
 * Set a session baggage value using OpenTelemetry's baggage API
 * This automatically propagates across async boundaries via AsyncLocalStorage
 */
export function setSessionBaggage(key: string, value: string): void {
  // Always persist in the module-level store — survives run() scope boundaries
  sessionValues.set(key, value);

  // Best-effort: also push into OTel baggage for cross-process propagation
  try {
    const currentBaggage = propagation.getBaggage(context.active()) || propagation.createBaggage();
    const newBaggage = currentBaggage.setEntry(key, { value });
    const newContext = propagation.setBaggage(context.active(), newBaggage);
    safeEnterWith(newContext);
  } catch (e) {
    // non-fatal — sessionValues is the primary in-process store
  }
}

/**
 * Get a session baggage value — checks OTel baggage first, then the persistent store.
 */
export function getSessionBaggage(key: string): string | undefined {
  try {
    return propagation.getBaggage(context.active())?.getEntry(key)?.value ?? sessionValues.get(key);
  } catch (e) {
    return sessionValues.get(key);
  }
}

/**
 * Clear all session baggage from the current context
 */
export function clearSessionBaggage(): void {
  sessionValues.clear();
  try {
    const emptyBaggage = propagation.createBaggage();
    const newContext = propagation.setBaggage(context.active(), emptyBaggage);
    safeEnterWith(newContext);
  } catch (e) {
    Logger.warn("SessionSpanProcessor: Failed to clear baggage:", e);
  }
}

export class SessionSpanProcessor implements SpanProcessor {
  private readonly environment: string;

  constructor(environment: string = "local") {
    this.environment = environment;
  }

  /**
   * Called when a span starts. Adds session and entity context attributes.
   */
  onStart(span: Span, parentContext: Context): void {
    try {
      // Add library metadata
      span.setAttribute("library.name", Config.LIBRARY_NAME);
      span.setAttribute("library.version", Config.LIBRARY_VERSION);
      span.setAttribute("sdk.name", Config.SDK_NAME);
      span.setAttribute("deployment.environment", this.environment);

      // Get baggage from the parent context (or current if not provided)
      const ctxToUse = parentContext || context.active();
      const baggage = propagation.getBaggage(ctxToUse);

      // Add session context — OTel baggage (cross-process) takes precedence, then persistent store
      const sessionId = baggage?.getEntry("session_id")?.value ?? sessionValues.get("session_id");
      const userId = baggage?.getEntry("user_id")?.value ?? sessionValues.get("user_id");
      const tenantId = baggage?.getEntry("tenant_id")?.value ?? sessionValues.get("tenant_id");

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
      Logger.error("SessionSpanProcessor: Error setting span attributes:", e);
    }
  }

  /**
   * Called when a span ends. No-op for this processor.
   */
  onEnd(_span: ReadableSpan): void {
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
