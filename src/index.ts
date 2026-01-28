/**
 * Netra SDK - Main entry point
 * A comprehensive TypeScript/JavaScript SDK for AI application observability
 * Built on top of OpenTelemetry and Traceloop
 */

import {
  context,
  Span,
  SpanKind,
  trace,
  propagation,
} from "@opentelemetry/api";
import { Dashboard } from "./api/dashboard";
import { Evaluation } from "./api/evaluation";
import { Usage } from "./api/usage";
import { Config, NetraConfig } from "./config";
import {
  initInstrumentations,
  instrumentationsReady,
  uninstrumentAll,
} from "./instrumentation";
import { setSessionBaggage } from "./processors/session-span-processor";
import {
  ConversationType,
  runWithEntityContext,
  SessionManager,
} from "./session-manager";
import { SpanWrapper } from "./span-wrapper";
import { SpanType } from "./types";
import { withBlockedSpansLocal } from "./processors/localfiltering-span-processor";

export { Config, NetraInstruments } from "./config";
export { agent, span, task, workflow } from "./decorators";
export {
  InstrumentationSpanProcessor,
  ScrubbingSpanProcessor,
  SessionSpanProcessor,
} from "./processors";
export { ConversationType } from "./session-manager";
export { SpanType } from "./types";
export type { ActionModel, UsageModel } from "./types";
// Expose provider instrumentors for advanced usage/testing
export { mistralAIInstrumentor } from "./instrumentation/mistralai";

// Export API types and classes
export {
  Aggregation,
  ChartType,
  // Dashboard API
  Dashboard,
  DimensionField,
  EntryStatus,
  // Evaluation API
  Evaluation,
  FilterField,
  FilterType,
  GroupBy,
  Measure,
  metadataField,
  Operator,
  RunEntryContext,
  RunStatus,
  Scope,
  // Usage API
  Usage,
} from "./api";

export type {
  // Dashboard API
  CategoricalDataPoint,
  // Evaluation API
  CreateDatasetParams,
  DashboardData,
  Dataset,
  DatasetEntry,
  DatasetItem,
  Dimension,
  DimensionValue,
  EvaluationScore,
  EvaluatorFunction,
  Filter,
  FilterConfig,
  // Usage API
  ListSpansParams,
  ListTracesParams,
  Metrics,
  NumberResponse,
  QueryDataParams,
  QueryResponse,
  Run,
  SessionUsageData,
  SpansPage,
  TaskFunction,
  TenantUsageData,
  TestSuiteResult,
  TimeRange,
  TimeSeriesDataPoint,
  TimeSeriesResponse,
  TimeSeriesWithDimension,
  TracesPage,
  TraceSpan,
  TraceSummary,
} from "./api";
export * from "./exporters";

let _initialized = false;
let _rootSpan: Span | undefined;
let _config: Config | undefined;

export class Netra {
  private static _initialized = false;
  private static _config: Config | undefined;

  private static _tracer: any;

  /**
   * Usage API client for usage and traces
   * Available after calling Netra.init()
   */
  static usage: Usage;

  /**
   * Evaluation API client for datasets, runs, and test suites
   * Available after calling Netra.init()
   */
  static evaluation: Evaluation;

  /**
   * Dashboard API client for querying metrics and time-series data
   * Available after calling Netra.init()
   */
  static dashboard: Dashboard;

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
        "Netra.init() called more than once; ignoring subsequent calls.",
      );
      return;
    }

    // Build Config
    const cfg = new Config(config);
    this._config = cfg;

    // Initialize instrumentations and get effective provider
    const effectiveProvider = initInstrumentations(
      cfg,
      config.instruments,
      config.blockInstruments,
    );

    // If we found an effective provider (delegate), get a tracer from IT.
    // This ensures the tracer has the processors we added.
    if (
      effectiveProvider &&
      typeof (effectiveProvider as any).getTracer === "function"
    ) {
      this._tracer = (effectiveProvider as any).getTracer(
        Config.LIBRARY_NAME,
        Config.LIBRARY_VERSION,
      );
    } else {
      // Fallback
      this._tracer = trace.getTracer(
        Config.LIBRARY_NAME,
        Config.LIBRARY_VERSION,
      );
    }

    // Initialize API clients
    this.usage = new Usage(cfg);
    this.evaluation = new Evaluation(cfg);
    this.dashboard = new Dashboard(cfg);

    this._initialized = true;
    console.info("Netra successfully initialized.");
    this._initialized = true;
    console.info("Netra successfully initialized.");

    // Graceful shutdown logic
    const handleSignal = async (signal: string) => {
      console.log(`\nRecepived ${signal}. Shutting down Netra SDK...`);
      await this.shutdown();
      process.exit(0);
    };

    const handleUncaughtException = async (error: Error) => {
      console.error("Uncaught exception:", error);
      console.error("Shutting down Netra SDK due to crash...");
      try {
        await this.shutdown();
      } catch (err) {
        console.error("Error during crash shutdown:", err);
      }
      process.exit(1);
    };

    // Handle process running out of work
    process.once("beforeExit", async () => {
      // beforeExit can be called multiple times if the loop fills up again
      // but for our purpose, we just want to ensure flush happens if the script finishes
      await this.shutdown();
    });

    // Handle termination signals
    process.once("SIGINT", () => handleSignal("SIGINT"));
    process.once("SIGTERM", () => handleSignal("SIGTERM"));

    // Handle crashes
    process.once("uncaughtException", handleUncaughtException);

    // Create root span if enabled
    if (cfg.enableRootSpan) {
      // Use the effective tracer if available
      const tracer = this._tracer || trace.getTracer("netra.root.span");
      const rootName = `${Config.LIBRARY_NAME}.root.span`;

      // Create the root span
      _rootSpan = tracer.startSpan(rootName, {
        kind: SpanKind.INTERNAL,
      });

      if (_rootSpan) {
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

        console.info(
          "Netra root span created. Use Netra.runWithRootSpan() to parent spans under it.",
        );
      }
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
   * Optional cleanup to end the root span and uninstrument all.
   * Now async to ensure spans are flushed.
   */
  static async shutdown(): Promise<void> {
    if (!this._initialized) {
      return;
    }

    // Unpatch any monkey-patched instrumentations first
    try {
      uninstrumentAll();
    } catch (e) {
      // Ignore
      if (this._config?.debugMode) {
        console.error("Error during uninstrumentAll:", e);
      }
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

      // Define timeouts
      const FLUSH_TIMEOUT_MS = 5000;

      const flushPromise = (async () => {
        if (
          "forceFlush" in provider &&
          typeof provider.forceFlush === "function"
        ) {
          await provider.forceFlush();
        }
        if ("shutdown" in provider && typeof provider.shutdown === "function") {
          await provider.shutdown();
        }
      })();

      // Race against timeout
      await Promise.race([
        flushPromise,
        new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
      ]);
    } catch (e) {
      if (this._config?.debugMode) {
        console.error("Error during Netra shutdown flush:", e);
      }
    }

    this._initialized = false;
    this._tracer = undefined;
  }

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
      console.warn(
        "runWithRootSpan: No root span available. Running function without parent context.",
      );
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
      console.warn(
        "runWithRootSpanAsync: No root span available. Running function without parent context.",
      );
      return fn();
    }

    // Create a context with the root span and run the function within it
    const ctxWithRoot = trace.setSpan(context.active(), rootSpan);
    return context.with(ctxWithRoot, fn);
  }

  /**
   * Run a function within an isolated entity context.
   * This ensures that entity stacks (workflow, task, agent, span) are isolated
   * per request in concurrent environments.
   *
   * Note: Session context (session_id, user_id, tenant_id) is automatically
   * isolated via OpenTelemetry's baggage API and AsyncLocalStorage.
   * This method is primarily needed if you're using workflow/task/agent decorators
   * or span wrappers in concurrent environments.
   *
   * @param fn The function to run with isolated entity context
   * @returns The result of the function
   *
   */
  static runWithContext<T>(fn: () => T): T {
    return runWithEntityContext(fn);
  }

  /**
   * Set session_id context attributes for all spans.
   * Uses OpenTelemetry baggage API for automatic context propagation.
   *
   * Context automatically propagates across async boundaries in concurrent environments
   * thanks to AsyncLocalStorage in @opentelemetry/sdk-node.
   */
  static setSessionId(sessionId: string): void {
    if (typeof sessionId !== "string") {
      console.error(
        `setSessionId: sessionId must be a string, got ${typeof sessionId}`,
      );
      return;
    }
    if (sessionId) {
      // Store in OpenTelemetry baggage - automatically propagates across async boundaries
      setSessionBaggage("session_id", sessionId);
      SessionManager.setSessionContext("session_id", sessionId);
    } else {
      console.warn(
        "setSessionId: Session ID must be provided for setting session_id.",
      );
    }
  }

  /**
   * Set user_id context attributes for all spans.
   * Uses OpenTelemetry baggage API for automatic context propagation.
   */
  static setUserId(userId: string): void {
    if (typeof userId !== "string") {
      console.error(`setUserId: userId must be a string, got ${typeof userId}`);
      return;
    }
    if (userId) {
      // Store in OpenTelemetry baggage - automatically propagates across async boundaries
      setSessionBaggage("user_id", userId);
      SessionManager.setSessionContext("user_id", userId);
    } else {
      console.warn("setUserId: User ID must be provided for setting user_id.");
    }
  }

  /**
   * Set tenant_id context attributes for all spans.
   * Uses OpenTelemetry baggage API for automatic context propagation.
   */
  static setTenantId(tenantId: string): void {
    if (typeof tenantId !== "string") {
      console.error(
        `setTenantId: tenantId must be a string, got ${typeof tenantId}`,
      );
      return;
    }
    if (tenantId) {
      // Store in OpenTelemetry baggage - automatically propagates across async boundaries
      setSessionBaggage("tenant_id", tenantId);
      SessionManager.setSessionContext("tenant_id", tenantId);
    } else {
      console.warn(
        "setTenantId: Tenant ID must be provided for setting tenant_id.",
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
        value,
      );
    } else {
      console.warn(
        "Both key and value must be provided for custom attributes.",
      );
    }
  }

  /**
   * Set custom event in the current active span
   */
  static setCustomEvent(
    eventName: string,
    attributes: Record<string, any>,
  ): void {
    if (eventName && attributes) {
      SessionManager.setCustomEvent(eventName, attributes);
    } else {
      console.warn(
        "Both eventName and attributes must be provided for custom events.",
      );
    }
  }

  /**
   * Append a conversation entry to the current active span
   */
  static addConversation(
    conversationType: ConversationType,
    role: string,
    content: string | Record<string, any>,
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
    asType: SpanType = SpanType.SPAN,
  ): SpanWrapper {
    // Pass the effective tracer derived from the provider we control
    return new SpanWrapper(
      name,
      attributes,
      moduleName,
      asType,
      this._tracer,
    ).start();
  }

  static withBlockedSpansLocal = withBlockedSpansLocal;
}

// Default export
export default Netra;
