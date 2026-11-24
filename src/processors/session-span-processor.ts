import { context, Context, createContextKey, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Config } from "../config";
import { NetraLogger } from "../netraLogger";
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
 * Binds newContext as the active context for the current async resource.
 */
function safeEnterWith(newContext: Context): boolean {
  const contextManager = getContextManager();

  if (!contextManager) {
    return false;
  }

  // AsyncLocalStorageContextManager v2.x has no direct enterWith — go through _asyncLocalStorage
  if (typeof contextManager._asyncLocalStorage?.enterWith === 'function') {
    contextManager._asyncLocalStorage.enterWith(newContext);
    return true;
  }

  // Future-proof: some managers may expose enterWith directly
  if (typeof contextManager.enterWith === 'function') {
    contextManager.enterWith(newContext);
    return true;
  }

  NetraLogger.warn("SessionSpanProcessor: enterWith not available on context manager; session values will not be applied.");
  return false;
}

export type SessionKey = "session_id" | "user_id" | "tenant_id";
export type SessionValues = Readonly<Partial<Record<SessionKey, string>>>;

// Not baggage: only NetraBaggagePropagator moves identity on or off the wire, per its policy.
const NETRA_SESSION_CONTEXT_KEY = createContextKey("netra.session");

export function getSessionValues(ctx: Context = context.active()): SessionValues {
  return (ctx.getValue(NETRA_SESSION_CONTEXT_KEY) as SessionValues | undefined) ?? {};
}

export function contextWithSessionValues(ctx: Context, values: SessionValues): Context {
  const merged: Partial<Record<SessionKey, string>> = { ...getSessionValues(ctx) };
  for (const [key, value] of Object.entries(values) as [SessionKey, string | undefined][]) {
    if (value) merged[key] = value;
  }
  return ctx.setValue(NETRA_SESSION_CONTEXT_KEY, Object.freeze(merged));
}

// Uses enterWith: outside a per-request scope, later work started by the caller inherits the value.
export function setSessionValue(key: SessionKey, value: string): boolean {
  try {
    return safeEnterWith(contextWithSessionValues(context.active(), { [key]: value }));
  } catch (e) {
    NetraLogger.debug("SessionSpanProcessor: failed to set session value:", e);
    return false;
  }
}

export function getSessionValue(key: SessionKey): string | undefined {
  try {
    return getSessionValues()[key];
  } catch {
    return undefined;
  }
}

/**
 * Clear the session values of the current async context.
 */
export function clearSessionValues(): void {
  try {
    safeEnterWith(context.active().deleteValue(NETRA_SESSION_CONTEXT_KEY));
  } catch (e) {
    NetraLogger.warn("SessionSpanProcessor: Failed to clear session values:", e);
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

      const session = getSessionValues(parentContext || context.active());

      if (session.session_id) {
        span.setAttribute(`${Config.LIBRARY_NAME}.session_id`, session.session_id);
      }
      if (session.user_id) {
        span.setAttribute(`${Config.LIBRARY_NAME}.user_id`, session.user_id);
      }
      if (session.tenant_id) {
        span.setAttribute(`${Config.LIBRARY_NAME}.tenant_id`, session.tenant_id);
      }

      // Add entity attributes from SessionManager (workflow, task, agent context)
      const entityAttributes = SessionManager.getCurrentEntityAttributes();
      for (const [attrKey, attrValue] of Object.entries(entityAttributes)) {
        span.setAttribute(attrKey, attrValue);
      }
    } catch (e) {
      NetraLogger.error("SessionSpanProcessor: Error setting span attributes:", e);
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
