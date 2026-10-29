/**
 * Netra SDK - Main entry point
 * A comprehensive TypeScript/JavaScript SDK for AI application observability
 * Built on top of OpenTelemetry and Traceloop
 */

import { trace } from "@opentelemetry/api";
import { createRequire } from "module";
import { Prompts, Dashboard, Evaluation, Usage, Models } from "./api";
import { Config, NetraConfig } from "./config";
import { initInstrumentations, instrumentationsReady, uninstrumentAll } from "./instrumentation";
import { Logger } from "./logger";
import { setSessionBaggage, withBlockedSpansLocal } from "./processors";
import {
  FLUSH_TIMEOUT_MS,
  registerExitTask,
  settleOtherExitTasks,
  type ExitTask,
} from "./shutdown-registry";
import { ConversationType, SessionManager } from "./session-manager";
import { Simulation } from "./simulation";
import { SpanWrapper } from "./span-wrapper";
import { Tracer } from "./tracer";
import { SpanType, SpanCallback, SpanOptions, SpanAttributes } from "./types";
import { wrapResponse } from "./utils/response-handler";

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
  SerializationSpanProcessor,
  SessionSpanProcessor,
  SpanIOProcessor,
} from "./processors";
export { safeStringify, TruncatingSerializer } from "./utils/serialization";
export type { SafeStringifyOptions } from "./utils/serialization";
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
  PROMPT_CACHE_TTL_SECONDS,
  // Models API
  Models,
  MODEL_PRICING_CACHE_TTL_SECONDS,
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
  SessionDetailsResponse,
  SessionDetailsToolCall,
  SessionDetailsTrace,
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
  // Models API
  GetModelPricingParams,
  ModelPrice,
  ModelPricing,
} from "./api";

// Export simulation types and classes
export { BaseTask, Simulation } from "./simulation";
export type {
  AfterAllFn,
  AfterFn,
  BeforeAllFn,
  BeforeFn,
  ConversationResponse,
  ConversationResult,
  InitializeRunResult,
  ProcessedFile,
  SimulationHooks,
  SimulationItem,
  SimulationOptions,
  SimulationResult,
  TaskResult,
} from "./simulation";
export * from "./exporters";

// Context propagation helpers for distributed tracing
export {
  netraExpressMiddleware,
  runWithExtractedContext,
} from "./utils/context-propagation";

export class Netra {
  private static _SDK_NAME = "netra_sdk";

  private static _initialized = false;
  private static _config: Config | undefined;
  private static _tracer: any;
  private static _metricsEnabled = false;
  private static _shutdownPromise: Promise<void> | undefined;
  private static _unregisterFlush: (() => void) | undefined;
  private static readonly _flushTask: ExitTask = () => this.shutdown();
  private static _beforeExit: (() => void) | undefined;

  static usage: Usage;
  static evaluation: Evaluation;
  static dashboard: Dashboard;
  static simulation: Simulation;
  static prompts: Prompts;
  static models: Models;

  static getConfig(): Config {
    if (!this._config) {
      throw new Error("Netra SDK not initialized. Call Netra.init() first.");
    }
    return this._config;
  }

  static isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Initialize the Netra SDK.
   */
  static async init(config: NetraConfig = {}): Promise<void> {
    // Let an in-flight shutdown finish so it can't tear down this new init.
    if (this._shutdownPromise) {
      await this._shutdownPromise;
    }
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

    try {
      this.models = new Models(cfg);
    } catch (e) {
      Logger.warn("Netra: failed to initialize models client:", e);
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

    if (config.registerShutdownHooks !== false) {
      this._registerShutdownHooks();
    }

    // Wait for all async instrumentations to be ready
    await instrumentationsReady;
  }

  /**
   * Flush spans when the host process is going away, without taking over
   * the process lifecycle: the SDK never decides when (or with which code)
   * the process exits. Once flushed, if no other listener is handling the
   * event, Node's default behaviour is restored (the signal is re-raised so
   * the exit code is 128+n; an uncaught exception exits with code 1).
   */
  private static _registerShutdownHooks(): void {
    if (this._unregisterFlush) {
      return;
    }

    // The signal / crash paths are arbitrated by the shutdown registry, which
    // owns the listeners for every part of the SDK so that no two of them race
    // each other to re-raise.
    this._unregisterFlush = registerExitTask(this._flushTask);

    // `beforeExit` stays here deliberately. It fires on a benign loop drain and
    // makes no exit-code decision, so it is not part of what the registry
    // arbitrates; routing it through there would also let a normal idle moment
    // consume tasks that are meant to run only when the process is dying.
    const beforeExit = () => {
      void this.shutdown();
    };
    this._beforeExit = beforeExit;
    process.once("beforeExit", beforeExit);
  }

  private static _removeShutdownHooks(): void {
    this._unregisterFlush?.();
    this._unregisterFlush = undefined;
    if (this._beforeExit) {
      process.removeListener("beforeExit", this._beforeExit);
      this._beforeExit = undefined;
    }
  }

  /**
   * Flush pending spans and release SDK resources. Safe to call more than
   * once and from several places at the same time (e.g. the app's own SIGTERM
   * handler while the SDK's hook is also flushing): concurrent callers share
   * the same in-flight shutdown and all resolve once it has finished.
   */
  static shutdown(): Promise<void> {
    if (this._shutdownPromise) {
      return this._shutdownPromise;
    }
    if (!this._initialized) {
      return Promise.resolve();
    }
    this._shutdownPromise = this._shutdown().finally(() => {
      this._shutdownPromise = undefined;
    });
    return this._shutdownPromise;
  }

  private static async _shutdown(): Promise<void> {
    this._removeShutdownHooks();

    // Unpatch any monkey-patched instrumentations first
    try {
      await uninstrumentAll();
    } catch (e) {
      Logger.error("Error during uninstrumentAll:", e);
    }

    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The global provider is OTel's ProxyTracerProvider, which has neither
      // forceFlush nor shutdown; the real provider is its delegate.
      const globalProvider = trace.getTracerProvider() as any;
      const traceProvider =
        typeof globalProvider.getDelegate === "function"
          ? globalProvider.getDelegate()
          : globalProvider;
      // Flush only, never shut the provider down: Traceloop's initialize() is
      // one-shot per process, so a later Netra.init() reuses this provider and
      // would otherwise export nothing.
      const flushPromise = (async () => {
        if (typeof traceProvider?.forceFlush === "function") {
          await traceProvider.forceFlush();
        }
      })();

      await Promise.race([
        flushPromise,
        new Promise((resolve) => {
          flushTimer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
          // Don't let the budget itself hold the process open after the flush.
          flushTimer.unref?.();
        }),
      ]);
    } catch (e) {
      Logger.error("Error during Netra trace shutdown:", e);
    } finally {
      clearTimeout(flushTimer);
    }

    try {
      this.prompts?.clearCache();
      this.models?.clearCache();
    } catch (e) {
      Logger.error("Error clearing SDK API caches:", e);
    }

    // Wait for the other registered exit tasks (e.g. a simulation marking its
    // run failed) before resolving. Applications shut down with
    // `await Netra.shutdown(); process.exit(0)`, so resolving early would let
    // them exit while a sibling task is still mid-request.
    try {
      await settleOtherExitTasks(this._flushTask);
    } catch (e) {
      Logger.error("Error awaiting pending shutdown tasks:", e);
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

      return wrapResponse(result, {
        withContext: (fn) => spanWrapper.withActive(fn),
        onError: (e) =>
          spanWrapper.setError(e instanceof Error ? e.message : String(e)),
        finalize: () => spanWrapper.end(),
      }) as T;
    });
  }

  static withBlockedSpansLocal = withBlockedSpansLocal;
}

export default Netra;
