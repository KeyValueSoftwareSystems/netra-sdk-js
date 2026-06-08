/**
 * Netra SDK - Main entry point
 * A comprehensive TypeScript/JavaScript SDK for AI application observability
 * Built on top of OpenTelemetry and Traceloop
 */

import { context, Span, SpanKind, trace } from "@opentelemetry/api";
import { createRequire } from "module";
import { Prompts, Dashboard, Evaluation, Usage } from "./api";
import { Config, NetraConfig } from "./config";
import { initInstrumentations, instrumentationsReady, uninstrumentAll } from "./instrumentation";
import { Logger } from "./logger";
import { setSessionBaggage, withBlockedSpansLocal } from "./processors";
import { ConversationType, SessionManager } from "./session-manager";
import { Simulation } from "./simulation";
import { SpanWrapper } from "./span-wrapper";
import { Tracer } from "./tracer";
import { SpanType, SpanCallback, SpanOptions, SpanAttributes } from "./types";

export {
  Config,
  DEFAULT_INSTRUMENTS,
  DEFAULT_INSTRUMENTS_FOR_ROOT,
  NetraInstruments,
} from "./config";
export { agent, span, task, workflow } from "./decorators";
export {
  InstrumentationSpanProcessor,
  ScrubbingSpanProcessor,
  SessionSpanProcessor,
  SpanIOProcessor,
} from "./processors";
export { ConversationType } from "./session-manager";
export { SpanType } from "./types";
export type { ActionModel, UsageModel, SpanOptions } from "./types";
// Expose provider instrumentors for advanced usage/testing
export { mistralAIInstrumentor } from "./instrumentation/mistralai";
export {
  NetraOpenAIAgentsInstrumentor,
  openaiAgentsInstrumentor,
  NetraAgentsTracingProcessor,
} from "./instrumentation/openai-agents";

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

export class Netra {
  private static _SDK_NAME = "netra_sdk";

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
      Logger.warn("Netra.init() called more than once; ignoring subsequent calls.");
      return;
    }

    const cfg = new Config(config);
    this._config = cfg;

    // Wire the logger before anything else so all modules respect debugMode.
    Logger.setDebugMode(cfg.debugMode);

    // Initialize instrumentations and get effective provider
    const effectiveProvider = initInstrumentations(
      cfg,
      config.instruments,
      config.blockInstruments,
      config.rootInstruments,
    );

    // Create the tracer
    const tracer = new Tracer(cfg, effectiveProvider);
    this._tracer = tracer.tracer;

    try {
      this.usage = new Usage(cfg);
    } catch (e) {
      Logger.warn("Netra: failed to initialize usage client:", e);
    }

    try {
      this.evaluation = new Evaluation(cfg);
    } catch (e) {
      Logger.warn("Netra: failed to initialize evaluation client:", e);
    }

    try {
      this.dashboard = new Dashboard(cfg);
    } catch (e) {
      Logger.warn("Netra: failed to initialize dashboard client:", e);
    }

    try {
      this.simulation = new Simulation(cfg);
    } catch (e) {
      Logger.warn("Netra: failed to initialize simulation client:", e);
    }

    try {
      this.prompts = new Prompts(cfg);
    } catch (e) {
      Logger.warn("Netra: failed to initialize prompts client:", e);
    }

    this._initialized = true;
    Logger.info("Netra successfully initialized.");

    {
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
      Logger.debug(
        `SDK version=${pkgVersion} libraryVersion=${Config.LIBRARY_VERSION} build=langgraph-parenting-v3 packageJson=${pkgPath}`,
      );
    }

    // Graceful shutdown logic
    const handleSignal = async (signal: string) => {
      Logger.log(`\nReceived ${signal}. Shutting down Netra SDK...`);
      await this.shutdown();
      process.exit(0);
    };

    const handleUncaughtException = async (error: Error) => {
      Logger.error("Uncaught exception:", error);
      Logger.error("Shutting down Netra SDK due to crash...");
      try {
        await this.shutdown();
      } catch (err) {
        Logger.error("Error during crash shutdown:", err);
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

        Logger.info(
          "Netra root span created. Use Netra.runWithRootSpan() to parent spans under it.",
        );
      }
    }

    // Wait for all async instrumentations to be ready
    await instrumentationsReady;
  }

  static async shutdown(): Promise<void> {
    if (!this._initialized) {
      return;
    }

    // Unpatch any monkey-patched instrumentations first
    try {
      await uninstrumentAll();
    } catch (e) {
      Logger.error("Error during uninstrumentAll:", e);
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
      Logger.error("Error during Netra trace shutdown:", e);
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
    if (!this._rootSpan) {
      Logger.warn(
        "runWithRootSpan: No root span available. Running function without parent context.",
      );
      return fn();
    }
    return context.with(trace.setSpan(context.active(), this._rootSpan), fn);
  }

  static setSessionId(sessionId: string): void {
    if (typeof sessionId !== "string") {
      Logger.error(`setSessionId: sessionId must be a string, got ${typeof sessionId}`);
      return;
    }
    if (sessionId) {
      setSessionBaggage("session_id", sessionId);
      SessionManager.setAttributeOnActiveSpan(
        `${Config.LIBRARY_NAME}.session_id`,
        sessionId,
      );
    } else {
      Logger.warn("setSessionId: Session ID must be provided for setting session_id.");
    }
  }

  /**
   * Set user_id context attributes for all spans.
   * Uses OpenTelemetry baggage API for automatic context propagation.
   */
  static setUserId(userId: string): void {
    if (typeof userId !== "string") {
      Logger.error(`setUserId: userId must be a string, got ${typeof userId}`);
      return;
    }
    if (userId) {
      setSessionBaggage("user_id", userId);
      SessionManager.setAttributeOnActiveSpan(
        `${Config.LIBRARY_NAME}.user_id`,
        userId,
      );
    } else {
      Logger.warn("setUserId: User ID must be provided for setting user_id.");
    }
  }

  /**
   * Set tenant_id context attributes for all spans.
   * Uses OpenTelemetry baggage API for automatic context propagation.
   */
  static setTenantId(tenantId: string): void {
    if (typeof tenantId !== "string") {
      Logger.error(`setTenantId: tenantId must be a string, got ${typeof tenantId}`);
      return;
    }
    if (tenantId) {
      setSessionBaggage("tenant_id", tenantId);
      SessionManager.setAttributeOnActiveSpan(
        `${Config.LIBRARY_NAME}.tenant_id`,
        tenantId,
      );
    } else {
      Logger.warn("setTenantId: Tenant ID must be provided for setting tenant_id.");
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
      Logger.warn("Both key and value must be provided for custom attributes.");
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
      Logger.warn("Both eventName and attributes must be provided for custom events.");
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

  static startSpan(name: string): SpanWrapper;
  static startSpan(name: string, options: SpanOptions): SpanWrapper;
  static startSpan(name: string, options?: SpanOptions): SpanWrapper {
    const attributes = options?.attributes ?? {};
    const moduleName = options?.moduleName ?? this._SDK_NAME;
    const spanType = options?.asType ?? SpanType.SPAN;

    return new SpanWrapper(
      name,
      attributes,
      moduleName,
      spanType,
      this._tracer,
      options?.blockedSpans,
    ).start();
  }

  static startActiveSpan<T>(name: string, fn: SpanCallback<T>): T;
  static startActiveSpan<T>(name: string, options: SpanOptions, fn: SpanCallback<T>): T;
  static startActiveSpan<T>(
    name: string,
    optionsOrFn: SpanOptions | SpanCallback<T>,
    fn?: SpanCallback<T>,
  ): T {
    let attributes: SpanAttributes = {};
    let moduleName = this._SDK_NAME;
    let spanType: SpanType = SpanType.SPAN;
    let callback: SpanCallback<T>;

    if (typeof optionsOrFn === "function") {
      callback = optionsOrFn;
    } else {
      attributes = optionsOrFn.attributes ?? {};
      moduleName = optionsOrFn.moduleName ?? this._SDK_NAME;
      spanType = optionsOrFn.asType ?? SpanType.SPAN;
      callback = fn!;
    }

    const blockedSpans = typeof optionsOrFn === "function"
      ? undefined
      : optionsOrFn.blockedSpans;

    const spanWrapper = new SpanWrapper(
      name,
      attributes,
      moduleName,
      spanType,
      this._tracer,
      blockedSpans,
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
