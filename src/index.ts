/**
 * Netra SDK - Main entry point
 * A comprehensive TypeScript/JavaScript SDK for AI application observability
 * Built on top of OpenTelemetry and Traceloop
 */

import { context, Span, SpanKind, trace } from "@opentelemetry/api";
import { createRequire } from "module";
import { Dashboard } from "./api/dashboard";
import { Evaluation } from "./api/evaluation";
import { Usage } from "./api/usage";
import { Config, NetraConfig } from "./config";
import { instrumentationsReady, uninstrumentAll } from "./instrumentation";
import { Tracer } from "./tracer";
import { withBlockedSpansLocal } from "./processors/localfiltering-span-processor";
import { setSessionBaggage } from "./processors/session-span-processor";
import { ConversationType, SessionManager } from "./session-manager";
import { Simulation } from "./simulation";
import { SpanWrapper } from "./span-wrapper";
import { SpanType } from "./types";
import { Prompts } from "./api";

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
  // Prompts API
  Prompts,
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
  GetPromptParams,
  PromptResponse,
} from "./api";

// Export simulation types and classes
export { BaseTask, Simulation } from "./simulation";
export type {
  ConversationResponse,
  ConversationResult,
  CreateRunResult,
  SimulationItem,
  SimulationOptions,
  SimulationResult,
  TaskResult,
} from "./simulation";
export * from "./exporters";

type SpanCallback<T> = (span: SpanWrapper) => T;

export class Netra {
  private static _initialized = false;
  private static _config: Config | undefined;
  private static _tracer: any;
  private static _rootSpan: Span | undefined;
  private static _metricsEnabled = false;

  static usage: Usage;
  static evaluation: Evaluation;
  static dashboard: Dashboard;
  static simulation: Simulation;
  static prompts: Prompts;

  static getConfig(): Config {
    if (!this._config) {
      throw new Error("Netra SDK not initialized. Call Netra.init() first.");
    }
    return this._config;
  }

  static isInitialized(): boolean {
    return this._initialized;
  }

  static async init(config: NetraConfig = {}): Promise<void> {
    if (this._initialized) {
      console.warn(
        "Netra.init() called more than once; ignoring subsequent calls.",
      );
      return;
    }

    const cfg = new Config(config);
    this._config = cfg;

    // Extract Instruments and Block Instruments
    const { instruments, blockInstruments } = config;

    // Create the tracer
    const tracer = new Tracer(cfg, instruments, blockInstruments);
    this._tracer = tracer.tracer;

    try {
      this.usage = new Usage(cfg);
    } catch (e) {
      console.warn("Netra: failed to initialize usage client:", e);
    }

    try {
      this.evaluation = new Evaluation(cfg);
    } catch (e) {
      console.warn("Netra: failed to initialize evaluation client:", e);
    }

    try {
      this.dashboard = new Dashboard(cfg);
    } catch (e) {
      console.warn("Netra: failed to initialize dashboard client:", e);
    }

    try {
      this.simulation = new Simulation(cfg);
    } catch (e) {
      console.warn("Netra: failed to initialize simulation client:", e);
    }

    try {
      this.prompts = new Prompts(cfg);
    } catch (e) {
      console.warn("Netra: failed to initialize prompts client:", e);
    }

    this._initialized = true;
    console.info("Netra successfully initialized.");

    if (cfg.debugMode) {
      let pkgVersion = Config.LIBRARY_VERSION;
      let pkgPath = "unknown";
      try {
        const req = createRequire(import.meta.url);
        pkgPath = req.resolve("../package.json");
        const pkg = req("../package.json");
        pkgVersion = pkg?.version || pkgVersion;
      } catch {
        // keep defaults
      }
      console.debug(
        `[Netra Debug] SDK version=${pkgVersion} libraryVersion=${Config.LIBRARY_VERSION} build=langgraph-parenting-v3 packageJson=${pkgPath}`,
      );
    }

    // Graceful shutdown logic
    const handleSignal = async (signal: string) => {
      console.log(`\nReceived ${signal}. Shutting down Netra SDK...`);
      await this.shutdown(cfg);
      process.exit(0);
    };

    const handleUncaughtException = async (error: Error) => {
      console.error("Uncaught exception:", error);
      console.error("Shutting down Netra SDK due to crash...");
      try {
        await this.shutdown(cfg);
      } catch (err) {
        console.error("Error during crash shutdown:", err);
      }
      process.exit(1);
    };

    // Handle process running out of work
    process.once("beforeExit", async () => {
      // beforeExit can be called multiple times if the loop fills up again
      // but for our purpose, we just want to ensure flush happens if the script finishes
      await this.shutdown(cfg);
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
      this._rootSpan = tracer.startSpan(rootName, {
        kind: SpanKind.INTERNAL,
      });

      if (this._rootSpan) {
        if (cfg.appName) {
          this._rootSpan.setAttribute("service.name", cfg.appName);
        }
        this._rootSpan.setAttribute("netra.environment", cfg.environment);
        this._rootSpan.setAttribute(
          "netra.library.version",
          Config.LIBRARY_VERSION,
        );

        try {
          SessionManager.setCurrentSpan(this._rootSpan);
          // Also store the root span in SessionManager for access by SpanWrapper/decorators
          SessionManager.setRootSpan(this._rootSpan);
        } catch (e) {
          // ignore
        }

        console.info(
          "Netra root span created. Use Netra.runWithRootSpan() to parent spans under it.",
        );
      }
    }

    // Wait for all async instrumentations to be ready
    await instrumentationsReady;
  }

  static async shutdown(config: Config): Promise<void> {
    if (!this._initialized) {
      return;
    }

    // Unpatch any monkey-patched instrumentations first
    try {
      uninstrumentAll(config);
    } catch (e) {
      if (this._config?.debugMode) {
        console.error("Error during uninstrumentAll:", e);
      }
    }

    if (this._rootSpan) {
      try {
        this._rootSpan.end();
      } catch (e) {
      } finally {
        this._rootSpan = undefined;
      }
    }

    const FLUSH_TIMEOUT_MS = 5000;

    try {
      const traceProvider = trace.getTracerProvider();
      const flushPromise = (async () => {
        if (
          "forceFlush" in traceProvider &&
          typeof traceProvider.forceFlush === "function"
        ) {
          await traceProvider.forceFlush();
        }
        if (
          "shutdown" in traceProvider &&
          typeof traceProvider.shutdown === "function"
        ) {
          await traceProvider.shutdown();
        }
      })();

      await Promise.race([
        flushPromise,
        new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
      ]);
    } catch (e) {
      if (this._config?.debugMode) {
        console.error("Error during Netra trace shutdown:", e);
      }
    }

    this._initialized = false;
    this._tracer = undefined;
  }

  static getTraceId(): string | undefined {
    return SessionManager.getTraceId();
  }

  static setInput(value: any): void {
    SessionManager.setInput(value);
  }

  static setOutput(value: any): void {
    SessionManager.setOutput(value);
  }

  static setRootInput(value: any): void {
    SessionManager.setRootInput(value);
  }

  static setRootOutput(value: any): void {
    SessionManager.setRootOutput(value);
  }

  /**
   * Run a function with the root span as the active parent context.
   * All spans created within this function will be children of the root span.
   * Note: required in JS because OTel JS has no persistent context.attach()
   */
  static runWithRootSpan<T>(fn: () => T): T {
    const rootSpan = SessionManager.getRootSpan();
    if (!rootSpan) {
      console.warn(
        "runWithRootSpan: No root span available. Running function without parent context.",
      );
      return fn();
    }

    const ctxWithRoot = trace.setSpan(context.active(), rootSpan);
    return context.with(ctxWithRoot, fn);
  }

  static setSessionId(sessionId: string): void {
    if (typeof sessionId !== "string") {
      console.error(
        `setSessionId: sessionId must be a string, got ${typeof sessionId}`,
      );
      return;
    }
    if (sessionId) {
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

  static startActiveSpan<T>(name: string, fn: SpanCallback<T>): T;
  static startActiveSpan<T>(
    name: string,
    attributes: Record<string, string>,
    fn: SpanCallback<T>,
  ): T;
  static startActiveSpan<T>(
    name: string,
    attributes: Record<string, string>,
    asType: SpanType,
    fn: SpanCallback<T>,
  ): T;
  static startActiveSpan<T>(
    name: string,
    attributes: Record<string, string>,
    moduleName: string,
    asType: SpanType,
    fn: SpanCallback<T>,
  ): T;
  static startActiveSpan<T>(
    name: string,
    attributesOrFn: Record<string, string> | SpanCallback<T>,
    moduleNameOrAsTypeOrFn?: string | SpanCallback<T>,
    asTypeOrFn?: SpanType | SpanCallback<T>,
    fn?: SpanCallback<T>,
  ): T {
    let attributes: Record<string, string> = {};
    let moduleName = "netra_sdk";
    let spanType: SpanType = SpanType.SPAN;
    let callback: SpanCallback<T>;

    if (typeof attributesOrFn === "function") {
      // (name, fn)
      callback = attributesOrFn;
    } else if (typeof moduleNameOrAsTypeOrFn === "function") {
      // (name, attributes, fn)
      attributes = attributesOrFn;
      callback = moduleNameOrAsTypeOrFn;
    } else if (typeof asTypeOrFn === "function") {
      // (name, attributes, asType, fn)
      attributes = attributesOrFn;
      spanType = moduleNameOrAsTypeOrFn as SpanType;
      callback = asTypeOrFn;
    } else {
      // (name, attributes, moduleName, asType, fn)
      attributes = attributesOrFn;
      moduleName = moduleNameOrAsTypeOrFn as string;
      spanType = asTypeOrFn as SpanType;
      callback = fn!;
    }

    const spanWrapper = new SpanWrapper(
      name,
      attributes,
      moduleName,
      spanType,
      this._tracer,
    ).start();

    return spanWrapper.withActive(() => {
      let result: T;
      try {
        result = callback(spanWrapper);
      } catch (e) {
        spanWrapper.setError(e instanceof Error ? e.message : String(e));
        spanWrapper.end();
        throw e;
      }

      if (result instanceof Promise) {
        return (result as Promise<unknown>)
          .catch((e) => {
            spanWrapper.setError(e instanceof Error ? e.message : String(e));
            throw e;
          })
          .finally(() => spanWrapper.end()) as T;
      }

      spanWrapper.end();
      return result;
    });
  }

  static withBlockedSpansLocal = withBlockedSpansLocal;
}

export default Netra;
