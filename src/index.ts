/**
 * Netra SDK - Main entry point
 * A comprehensive TypeScript/JavaScript SDK for AI application observability
 * Built on top of OpenTelemetry and Traceloop
 */

import { Span, SpanKind, trace } from "@opentelemetry/api";
import { Config, NetraConfig } from "./config";
import { initInstrumentations, uninstrumentAll } from "./instrumentation";
import { ConversationType, SessionManager } from "./session-manager";
import { SpanWrapper } from "./span-wrapper";
import { SpanType } from "./types";

// Re-export decorators
export { agent, span, task, workflow } from "./decorators";

// Re-export types
export { NetraInstruments } from "./config";
export { ConversationType, SpanType } from "./types";

let _initialized = false;
let _rootSpan: Span | undefined;
let _config: Config | undefined;

export class Netra {
  private static _initialized = false;
  private static _config: Config | undefined;

  /**
   * Check if Netra has been initialized
   */
  static isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Initialize the Netra SDK
   */
  static init(config: NetraConfig = {}): void {
    if (this._initialized) {
      console.warn(
        "Netra.init() called more than once; ignoring subsequent calls."
      );
      return;
    }

    // Build Config
    const cfg = new Config(config);
    this._config = cfg;

    // Initialize instrumentations
    initInstrumentations(cfg, config.instruments, config.blockInstruments);

    this._initialized = true;
    console.info("Netra successfully initialized.");

    // Create root span if enabled
    if (cfg.enableRootSpan) {
      const tracer = trace.getTracer("netra.root.span");
      const rootName = `${Config.LIBRARY_NAME}.root.span`;
      _rootSpan = tracer.startSpan(rootName, {
        kind: SpanKind.INTERNAL,
      });

      if (cfg.appName) {
        _rootSpan.setAttribute("service.name", cfg.appName);
      }
      _rootSpan.setAttribute("netra.environment", cfg.environment);
      _rootSpan.setAttribute("netra.library.version", Config.LIBRARY_VERSION);

      try {
        SessionManager.setCurrentSpan(_rootSpan);
      } catch (e) {
        // Ignore
      }

      console.info("Netra root span created and attached to context.");

      // Ensure cleanup at process exit
      process.on("exit", () => {
        this.shutdown();
      });
    }
  }

  /**
   * Optional cleanup to end the root span and uninstrument all
   */
  static shutdown(): void {
    // Uninstrument all active instrumentations
    try {
      uninstrumentAll();
    } catch (e) {
      // Ignore
    }

    if (_rootSpan) {
      try {
        _rootSpan.end();
      } catch (e) {
      } finally {
        _rootSpan = undefined;
      }
    }

    // Try to flush and shutdown the tracer provider
    try {
      const provider = trace.getTracerProvider();
      if (
        "forceFlush" in provider &&
        typeof provider.forceFlush === "function"
      ) {
        provider.forceFlush();
      }
      if ("shutdown" in provider && typeof provider.shutdown === "function") {
        provider.shutdown();
      }
    } catch (e) {
      // Ignore
    }

    this._initialized = false;
  }

  /**
   * Set session_id context attributes for all spans
   */
  static setSessionId(sessionId: string): void {
    if (typeof sessionId !== "string") {
      console.error(
        `setSessionId: sessionId must be a string, got ${typeof sessionId}`
      );
      return;
    }
    if (sessionId) {
      SessionManager.setSessionContext("session_id", sessionId);
    } else {
      console.warn(
        "setSessionId: Session ID must be provided for setting session_id."
      );
    }
  }

  /**
   * Set user_id context attributes for all spans
   */
  static setUserId(userId: string): void {
    if (typeof userId !== "string") {
      console.error(`setUserId: userId must be a string, got ${typeof userId}`);
      return;
    }
    if (userId) {
      SessionManager.setSessionContext("user_id", userId);
    } else {
      console.warn("setUserId: User ID must be provided for setting user_id.");
    }
  }

  /**
   * Set tenant_id context attributes for all spans
   */
  static setTenantId(tenantId: string): void {
    if (typeof tenantId !== "string") {
      console.error(
        `setTenantId: tenantId must be a string, got ${typeof tenantId}`
      );
      return;
    }
    if (tenantId) {
      SessionManager.setSessionContext("tenant_id", tenantId);
    } else {
      console.warn(
        "setTenantId: Tenant ID must be provided for setting tenant_id."
      );
    }
  }

  /**
   * Set a custom attribute on the current active span
   */
  static setCustomAttributes(key: string, value: any): void {
    if (key && value !== undefined && value !== null) {
      SessionManager.setAttributeOnActiveSpan(
        `${Config.LIBRARY_NAME}.custom.${key}`,
        value
      );
    } else {
      console.warn(
        "Both key and value must be provided for custom attributes."
      );
    }
  }

  /**
   * Set custom event in the current active span
   */
  static setCustomEvent(
    eventName: string,
    attributes: Record<string, any>
  ): void {
    if (eventName && attributes) {
      SessionManager.setCustomEvent(eventName, attributes);
    } else {
      console.warn(
        "Both eventName and attributes must be provided for custom events."
      );
    }
  }

  /**
   * Append a conversation entry to the current active span
   */
  static addConversation(
    conversationType: ConversationType,
    role: string,
    content: string | Record<string, any>
  ): void {
    SessionManager.addConversation(conversationType, role, content);
  }

  /**
   * Start a new span
   */
  static startSpan(
    name: string,
    attributes: Record<string, string> = {},
    moduleName: string = "netra_sdk",
    asType: SpanType = SpanType.SPAN
  ): SpanWrapper {
    return new SpanWrapper(name, attributes, moduleName, asType);
  }
}

// Default export
export default Netra;
