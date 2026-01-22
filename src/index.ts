/**
 * Netra SDK - Main entry point
 * A comprehensive TypeScript/JavaScript SDK for AI application observability
 * Built on top of OpenTelemetry and Traceloop
 *
 * This SDK now supports concurrency-safe session management using AsyncLocalStorage.
 * Each concurrent request gets its own isolated session context, preventing
 * data leakage between parallel operations (e.g., in LangGraph apps).
 */

import { context, Span, SpanKind, trace } from "@opentelemetry/api";
import { Config, NetraConfig } from "./config";
import {
  initInstrumentations,
  instrumentationsReady,
  uninstrumentAll,
} from "./instrumentation";
import { setSessionBaggage } from "./processors/session-span-processor";
import { ConversationType, SessionManager } from "./session-manager";
import { SpanWrapper } from "./span-wrapper";
import { SpanType, RunInContextOptions } from "./types";
import { ContextStore, SessionContext } from "./context-store";

export { NetraInstruments } from "./config";
export { agent, span, task, workflow } from "./decorators";
export {
  InstrumentationSpanProcessor,
  ScrubbingSpanProcessor,
  SessionSpanProcessor,
} from "./processors";
export { ConversationType } from "./session-manager";
export { SpanType } from "./types";
export type { ActionModel, UsageModel, RunInContextOptions } from "./types";
export { ContextStore, SessionContext } from "./context-store";
// Expose provider instrumentors for advanced usage/testing
export { mistralAIInstrumentor } from "./instrumentation/mistralai";

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
   * Note: Custom instrumentations (OpenAI, Groq, MistralAI) are initialized
   * asynchronously. Use initAsync() or await Netra.ready() to ensure
   * instrumentations are complete before using instrumented modules.
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

    // Ensure cleanup at process exit (like Python SDK's atexit.register)
    // Use both 'exit' (sync) and 'beforeExit' (async) for comprehensive coverage
    let shutdownRegistered = false;
    const registerShutdown = () => {
      if (!shutdownRegistered) {
        shutdownRegistered = true;
        this.shutdown();
      }
    };
    process.on("exit", registerShutdown);
    process.on("beforeExit", registerShutdown);
    process.on("SIGINT", () => {
      registerShutdown();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      registerShutdown();
      process.exit(0);
    });

    // Create root span if enabled
    if (cfg.enableRootSpan) {
      const tracer = trace.getTracer("netra.root.span");
      const rootName = `${Config.LIBRARY_NAME}.root.span`;

      // Create the root span
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
        // Also store the root span in SessionManager for access by SpanWrapper/decorators
        SessionManager.setRootSpan(_rootSpan);
      } catch (e) {
        // Ignore
      }

      console.info("Netra root span created.");
    }
  }

  /**
   * Initialize the Netra SDK and wait for all instrumentations to be ready.
   * This is the recommended way to initialize Netra when using ES modules,
   * as it ensures all async instrumentations (OpenAI, Groq, MistralAI) are
   * complete before the application starts using the instrumented modules.
   *
   * @example
   * await Netra.initAsync({ appName: 'my-app', instruments: new Set([NetraInstruments.OPENAI]) });
   * // Now OpenAI is fully instrumented
   * const openai = new OpenAI();
   */
  static async initAsync(config: NetraConfig = {}): Promise<void> {
    this.init(config);
    await instrumentationsReady;
  }

  /**
   * Returns a promise that resolves when all async instrumentations are ready.
   * Can be called after init() to wait for instrumentations.
   *
   * @example
   * Netra.init({ appName: 'my-app' });
   * await Netra.ready();
   * // Now all instrumentations are complete
   */
  static async ready(): Promise<void> {
    await instrumentationsReady;
  }

  /**
   * Optional cleanup to end the root span and uninstrument all
   */
  static shutdown(): void {
    // Unpatch any monkey-patched instrumentations first
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

  // ============================================================================
  // Context Management APIs (for concurrency-safe session handling)
  // ============================================================================

  /**
   * Run a synchronous function with an isolated session context.
   * Use this as the entry point for each concurrent request to ensure
   * session data (sessionId, userId, entity stacks) doesn't leak between requests.
   *
   * Note: When using decorators (@workflow, @task, etc.), context is
   * automatically established, so you typically don't need to call this.
   *
   * @param fn The function to run within an isolated context
   * @returns The result of the function
   *
   * @example
   * // Manual context isolation (usually not needed with decorators)
   * Netra.runInContext(() => {
   *   Netra.setSessionId('session-123');
   *   const span = Netra.startSpan('my-span');
   *   // ... do work
   *   span.end();
   * });
   */
  static runInContext<T>(fn: () => T): T {
    return ContextStore.runWithNewContext(fn);
  }

  /**
   * Run an async function with an isolated session context.
   * Async version of runInContext().
   *
   * @param fn The async function to run within an isolated context
   * @returns A promise that resolves with the result of the function
   *
   * @example
   * await Netra.runInContextAsync(async () => {
   *   Netra.setSessionId('session-123');
   *   const result = await myWorkflow();
   *   return result;
   * });
   */
  static async runInContextAsync<T>(fn: () => Promise<T>): Promise<T> {
    return ContextStore.runWithNewContext(fn);
  }

  /**
   * Run an async function with isolated context AND session setup.
   * This is a convenience method that combines context isolation with
   * session ID/user ID/tenant ID setup.
   *
   * @param options Session options (sessionId, userId, tenantId)
   * @param fn The async function to run
   * @returns A promise that resolves with the result of the function
   *
   * @example
   * // In an Express/Fastify request handler:
   * app.post('/api/agent', async (req, res) => {
   *   const result = await Netra.runWithSession(
   *     { sessionId: req.body.sessionId, userId: req.user.id },
   *     () => myAgentWorkflow(req.body.input)
   *   );
   *   res.json(result);
   * });
   */
  static async runWithSession<T>(
    options: RunInContextOptions,
    fn: () => Promise<T>
  ): Promise<T> {
    return ContextStore.runWithNewContext(async () => {
      // Set session context
      if (options.sessionId) {
        this.setSessionId(options.sessionId);
      }
      if (options.userId) {
        this.setUserId(options.userId);
      }
      if (options.tenantId) {
        this.setTenantId(options.tenantId);
      }

      // Set custom attributes if provided
      if (options.customAttributes) {
        for (const [key, value] of Object.entries(options.customAttributes)) {
          setSessionBaggage(`custom.${key}`, value);
        }
      }

      // Optionally run within root span context
      if (this._config?.enableRootSpan) {
        return this.runWithRootSpanAsync(fn);
      }

      return fn();
    });
  }

  /**
   * Check if the current code is running within an isolated context.
   * Returns true if inside runInContext/runWithSession, or if a decorator
   * has established context.
   */
  static hasContext(): boolean {
    return ContextStore.hasContext();
  }

  // ============================================================================
  // Root Span Management
  // ============================================================================

  /**
   * Run a function with the root span as the active parent context.
   * All spans created within this function will be children of the root span.
   *
   * @param fn The function to run within the root span context
   * @returns The result of the function
   */
  static runWithRootSpan<T>(fn: () => T): T {
    const rootSpan = SessionManager.getRootSpan();
    if (!rootSpan) {
      console.warn("runWithRootSpan: No root span available. Running function without parent context.");
      return fn();
    }

    // Create a context with the root span and run the function within it
    const ctxWithRoot = trace.setSpan(context.active(), rootSpan);
    return context.with(ctxWithRoot, fn);
  }

  /**
   * Run an async function with the root span as the active parent context.
   * All spans created within this function will be children of the root span.
   *
   * @param fn The async function to run within the root span context
   * @returns A promise that resolves with the result of the function
   */
  static async runWithRootSpanAsync<T>(fn: () => Promise<T>): Promise<T> {
    const rootSpan = SessionManager.getRootSpan();
    if (!rootSpan) {
      console.warn("runWithRootSpanAsync: No root span available. Running function without parent context.");
      return fn();
    }

    // Create a context with the root span and run the function within it
    const ctxWithRoot = trace.setSpan(context.active(), rootSpan);
    return context.with(ctxWithRoot, fn);
  }

  // ============================================================================
  // Session Context Setters
  // ============================================================================

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
      // Store in baggage for span processors to pick up
      setSessionBaggage("session_id", sessionId);
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
      // Store in baggage for span processors to pick up
      setSessionBaggage("user_id", userId);
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
      // Store in baggage for span processors to pick up
      setSessionBaggage("tenant_id", tenantId);
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
