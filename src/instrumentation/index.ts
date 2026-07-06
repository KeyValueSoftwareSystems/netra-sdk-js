/**
 * Instrumentation setup for Netra SDK
 */

import { context, trace } from "@opentelemetry/api";
import {
  ConsoleSpanExporter,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { initialize, InitializeOptions } from "@traceloop/node-server-sdk";
import { createRequire } from "module";
import {
  Config,
  DEFAULT_INSTRUMENTS,
  DEFAULT_INSTRUMENTS_FOR_ROOT,
  NetraInstruments,
} from "../config";
import { Logger } from "../logger";
import {
  AttributeSizeLimitProcessor,
  InstrumentationSpanProcessor,
  LlmTraceIdentifierSpanProcessor,
  RootSpanProcessor,
  RootInstrumentFilterProcessor,
  ScrubbingSpanProcessor,
  SessionSpanProcessor,
  SpanIOProcessor,
} from "../processors";
import { anthropicInstrumentor } from "./anthropic";
import { googleGenAIInstrumentor } from "./google-genai";
import { googleGenerativeAIInstrumentor } from "./google-generative-ai";
import { groqInstrumentor } from "./groq";
import { langgraphInstrumentor } from "./langgraph";
import { mistralAIInstrumentor } from "./mistralai";
import { openAIInstrumentor } from "./openai";
import { openaiAgentsInstrumentor } from "./openai-agents";
import { typeORMInstrumentor } from "./typeorm";
import { FilteringSpanExporter, TrialAwareOTLPExporter } from "../exporters";
import { LocalFilteringSpanProcessor } from "../processors/localfiltering-span-processor";
import { propagation } from "@opentelemetry/api";
import {
  CompositePropagator,
  W3CBaggagePropagator as BaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

// Interface for TracerProvider with addSpanProcessor method
interface TracerProviderWithProcessors {
  addSpanProcessor(processor: SpanProcessor): void;
}

// Re-export shared utilities for use across instrumentations
export {
  modelAsDict,
  setRequestAttributes,
  setResponseAttributes,
  shouldSuppressInstrumentation,
} from "./utils";

const require = createRequire(import.meta.url);

let _httpInstrumentation: any = null;
let _undiciInstrumentation: any = null;

/**
 * Check if a package is installed and resolvable.
 * Equivalent to Python SDK's `is_package_installed()`.
 */
function isPackageInstalled(packageName: string): boolean {
  try {
    require.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

/**
 * Promise that resolves when custom instrumentations are initialized.
 * Can be awaited after calling initInstrumentations() to ensure
 * all async instrumentations are complete.
 */
export let instrumentationsReady: Promise<void> = Promise.resolve();

propagation.setGlobalPropagator(
  new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new BaggagePropagator()],
  }),
);

function patchTraceloopLangchainCallbackHandler(): void {
  const applyPatch = (mod: any, sourceLabel: string) => {
    const Handler = mod?.TraceloopCallbackHandler;
    if (!Handler || Handler.__netra_patched) return;

    const wrapWithParentContext = (methodName: string) => {
      const original = Handler.prototype[methodName];
      if (typeof original !== "function") return;
      Handler.prototype[methodName] = function (...args: any[]) {
        const parentRunId = args[3];
        const parentSpan = parentRunId
          ? this?.spans?.get(parentRunId)?.span
          : undefined;
        const active = trace.getSpan(context.active());
  Logger.debug(
          `Traceloop ${methodName}: runId=${args[2]} parentRunId=${parentRunId} parentSpan=${parentSpan ? "yes" : "no"} activeSpanId=${active?.spanContext().spanId}`,
        );
        // Always bind the current active context (or explicit parent) for this callback.
        const ctx = parentSpan
          ? trace.setSpan(context.active(), parentSpan)
          : context.active();
        return context.with(ctx, () => original.apply(this, args));
      };
    };

    wrapWithParentContext("handleChainStart");
    wrapWithParentContext("handleLLMStart");
    wrapWithParentContext("handleChatModelStart");
    wrapWithParentContext("handleToolStart");

    Handler.__netra_patched = true;
    Logger.debug(`Patched TraceloopCallbackHandler for parent context (${sourceLabel}).`);
  };

  try {
    const mod = require("@traceloop/instrumentation-langchain");
    Logger.debug(`Loaded @traceloop/instrumentation-langchain via require from ${require.resolve("@traceloop/instrumentation-langchain")}`);
    applyPatch(mod, "require");
    return;
  } catch (e) {
    Logger.debug("require() for traceloop langchain failed, falling back to import().");
  }

  import("@traceloop/instrumentation-langchain")
    .then((mod: any) => {
      applyPatch(mod, "import");
    })
    .catch(() => {
      // No-op: langchain instrumentation not installed or not in use
    });
}

function disableTraceloopLangchainCallbackHandler(): void {
  try {
    const callbackManagerModule = require("@langchain/core/callbacks/manager");
    const CallbackManager = callbackManagerModule?.CallbackManager;
    if (!CallbackManager || (CallbackManager as any).__netra_disable_traceloop) {
      return;
    }
    const originalConfigureSync = (CallbackManager as any)._configureSync;
    if (typeof originalConfigureSync !== "function") return;

    (CallbackManager as any)._configureSync = function (
      inheritableHandlers: any,
      localHandlers: any,
      inheritableTags: any,
      localTags: any,
      inheritableMetadata: any,
      localMetadata: any,
      options?: any,
    ) {
      const filterHandlers = (handlers: any) => {
        if (!handlers) return handlers;
        if (Array.isArray(handlers)) {
          return handlers.filter(
            (h) => h?.name !== "traceloop_callback_handler",
          );
        }
        return handlers;
      };
      const filteredInheritable = filterHandlers(inheritableHandlers);
      const filteredLocal = filterHandlers(localHandlers);
      return originalConfigureSync.call(
        this,
        filteredInheritable,
        filteredLocal,
        inheritableTags,
        localTags,
        inheritableMetadata,
        localMetadata,
        options,
      );
    };
    (CallbackManager as any).__netra_disable_traceloop = true;
    Logger.debug("Disabled Traceloop LangChain callback injection.");
  } catch {
    // no-op
  }
}

/**
 * Resolve the effective root instrument allow-list.
 *
 * `rootInstruments` is resolved independently of the non-root `instruments`
 * set. `blockInstruments` is subtracted from the resolved root set.
 *
 * When `NetraInstruments.ALL` is in `rootInstruments`, returns `null` (no
 * root filtering — all instrumentations may create root spans) unless
 * `blockInstruments` restricts the set.
 *
 * Returns a set of instrumentation-name strings, or `null` when no filtering
 * should be applied.
 */
function resolveRootInstrumentNames(
  rootInstruments?: Set<NetraInstruments>,
  blockInstruments?: Set<NetraInstruments>,
): Set<string> | null {
  const allSentinel = NetraInstruments.ALL;
  const rootHasAll = rootInstruments != null && rootInstruments.has(allSentinel);
  const blockHasAll = blockInstruments != null && blockInstruments.has(allSentinel);

  if (blockHasAll) {
    if (rootHasAll) {
      Logger.error(
        "Netra: rootInstruments=ALL is contradicted by blockInstruments=ALL; " +
          "all root instrumentation is disabled.",
      );
    } else {
      Logger.warn(
        "Netra: blockInstruments contains ALL; all instrumentation will be disabled.",
      );
    }
  }

  // All instrument values (excluding the ALL sentinel)
  const allInstrumentValues = new Set<string>(
    Object.values(NetraInstruments).filter((v) => v !== allSentinel),
  );

  // Compute blocked values
  let blockedValues: Set<string>;
  if (blockHasAll) {
    blockedValues = new Set(allInstrumentValues);
  } else if (blockInstruments && blockInstruments.size > 0) {
    blockedValues = new Set(
      [...blockInstruments]
        .filter((m) => m !== allSentinel)
        .map((m) => m.valueOf()),
    );
  } else {
    blockedValues = new Set();
  }

  // Resolve root set
  if (rootHasAll) {
    if (blockedValues.size > 0) {
      const resolved = new Set<string>();
      for (const v of allInstrumentValues) {
        if (!blockedValues.has(v)) {
          resolved.add(v);
        }
      }
      return resolved;
    }
    return null; // No filtering — all roots allowed
  }

  // Use explicit rootInstruments or fall back to DEFAULT_INSTRUMENTS_FOR_ROOT
  const effectiveRoot =
    rootInstruments && rootInstruments.size > 0
      ? rootInstruments
      : DEFAULT_INSTRUMENTS_FOR_ROOT;

  const resolved = new Set<string>();
  for (const m of effectiveRoot) {
    if (m === allSentinel) continue;
    const val = m.valueOf();
    if (!blockedValues.has(val)) {
      resolved.add(val);
    }
  }

  return resolved;
}

export function initInstrumentations(
  config: Config,
  instruments?: Set<NetraInstruments>,
  blockInstruments?: Set<NetraInstruments>,
  rootInstruments?: Set<NetraInstruments>,
): TracerProviderWithProcessors | null {
  // Resolve effective instruments: use DEFAULT_INSTRUMENTS when not provided
  const enableAll = instruments != null && instruments.has(NetraInstruments.ALL);

  // Resolve root instrument names (independent of `instruments`).
  // blockInstruments is subtracted from the resolved root set.
  const resolvedRootNames: Set<string> | null = resolveRootInstrumentNames(
    rootInstruments,
    blockInstruments,
  );

  // Map Netra instruments to Traceloop instrument modules
  const instrumentModules: InitializeOptions["instrumentModules"] = {};

  // Track whether to use custom instrumentors
  const customInstrumentModules: Record<string, boolean> = {
    openai: false,
    groq: false,
    mistral: false,
    langgraph: false,
    googleGenAI: false,
    googleGenerativeAI: false,
    anthropic: false,
    openAiAgents: false,
  };

  // Resolve effective instrument set (Python parity):
  // ALL → enable everything; otherwise fall back to DEFAULT_INSTRUMENTS
  const resolved: Set<NetraInstruments> = enableAll
    ? new Set(Object.values(NetraInstruments).filter((v) => v !== NetraInstruments.ALL) as NetraInstruments[])
    : (instruments && instruments.size > 0) ? instruments : DEFAULT_INSTRUMENTS;

  // Explicitly disable all Traceloop modules, then selectively enable
  instrumentModules.google_vertexai = false;
  instrumentModules.langchain = false;
  instrumentModules.llamaIndex = false;
  instrumentModules.pinecone = false;
  instrumentModules.qdrant = false;
  instrumentModules.chromadb = false;
  instrumentModules.together = false;

  if (resolved.has(NetraInstruments.OPENAI)) {
    customInstrumentModules.openai = true;
  }
  if (resolved.has(NetraInstruments.MISTRAL)) {
    customInstrumentModules.mistral = true;
  }
  if (resolved.has(NetraInstruments.GROQ)) {
    customInstrumentModules.groq = true;
  }
  if (resolved.has(NetraInstruments.GOOGLE_GENAI)) {
    customInstrumentModules.googleGenAI = true;
  }
  if (resolved.has(NetraInstruments.GOOGLE_GENERATIVE_AI)) {
    customInstrumentModules.googleGenerativeAI = true;
  }
  if (resolved.has(NetraInstruments.VERTEX_AI) && isPackageInstalled("@google-cloud/vertexai")) {
    instrumentModules.google_vertexai = require("@google-cloud/vertexai");
  }
  if (resolved.has(NetraInstruments.LANGCHAIN)) {
    instrumentModules.langchain = true;
  }
  if (resolved.has(NetraInstruments.LANGGRAPH)) {
    customInstrumentModules.langgraph = true;
  }
  if (resolved.has(NetraInstruments.LLAMA_INDEX) && isPackageInstalled("llamaindex")) {
    instrumentModules.llamaIndex = require("llamaindex");
  }
  if (resolved.has(NetraInstruments.PINECONE) && isPackageInstalled("@pinecone-database/pinecone")) {
    instrumentModules.pinecone = require("@pinecone-database/pinecone");
  }
  if (resolved.has(NetraInstruments.QDRANT) && isPackageInstalled("@qdrant/js-client-rest")) {
    instrumentModules.qdrant = require("@qdrant/js-client-rest");
  }
  if (resolved.has(NetraInstruments.CHROMADB) && isPackageInstalled("chromadb")) {
    instrumentModules.chromadb = require("chromadb");
  }
  if (resolved.has(NetraInstruments.TOGETHER) && isPackageInstalled("together-ai")) {
    instrumentModules.together = require("together-ai");
  }
  if (resolved.has(NetraInstruments.ANTHROPIC)) {
    customInstrumentModules.anthropic = true;
  }
  if (resolved.has(NetraInstruments.OPENAI_AGENTS)) {
    customInstrumentModules.openAiAgents = true;
  }

  // Apply blockInstruments to Traceloop and Netra custom modules
  if (blockInstruments && blockInstruments.size > 0) {
    const blockAll = blockInstruments.has(NetraInstruments.ALL);
    if (blockAll || blockInstruments.has(NetraInstruments.OPENAI)) customInstrumentModules.openai = false;
    if (blockAll || blockInstruments.has(NetraInstruments.GROQ)) customInstrumentModules.groq = false;
    if (blockAll || blockInstruments.has(NetraInstruments.MISTRAL)) customInstrumentModules.mistral = false;
    if (blockAll || blockInstruments.has(NetraInstruments.LANGGRAPH)) customInstrumentModules.langgraph = false;
    if (blockAll || blockInstruments.has(NetraInstruments.GOOGLE_GENAI)) customInstrumentModules.googleGenAI = false;
    if (blockAll || blockInstruments.has(NetraInstruments.GOOGLE_GENERATIVE_AI)) customInstrumentModules.googleGenerativeAI = false;
    if (blockAll || blockInstruments.has(NetraInstruments.ANTHROPIC)) customInstrumentModules.anthropic = false;
    if (blockAll || blockInstruments.has(NetraInstruments.OPENAI_AGENTS)) customInstrumentModules.openAiAgents = false;
    if (blockAll || blockInstruments.has(NetraInstruments.VERTEX_AI)) instrumentModules.google_vertexai = false;
    if (blockAll || blockInstruments.has(NetraInstruments.LANGCHAIN)) instrumentModules.langchain = false;
    if (blockAll || blockInstruments.has(NetraInstruments.LLAMA_INDEX)) instrumentModules.llamaIndex = false;
    if (blockAll || blockInstruments.has(NetraInstruments.PINECONE)) instrumentModules.pinecone = false;
    if (blockAll || blockInstruments.has(NetraInstruments.QDRANT)) instrumentModules.qdrant = false;
    if (blockAll || blockInstruments.has(NetraInstruments.CHROMADB)) instrumentModules.chromadb = false;
    if (blockAll || blockInstruments.has(NetraInstruments.TOGETHER)) instrumentModules.together = false;
  }

  // Set Traceloop environment variables before initializing
  // This ensures the SDK picks up our configuration
  config.setTraceloopEnv();

  // Debug: Log configuration being used
  Logger.debug("Netra SDK Configuration:");
  Logger.debug(`  App Name: ${config.appName}`);
  Logger.debug(`  OTLP Endpoint: ${config.otlpEndpoint || "(default - localhost:3002)"}`);
  Logger.debug(`  API Key: ${config.apiKey ? "***" + config.apiKey.slice(-4) : "(not set)"}`);
  Logger.debug(`  Trace Content: ${config.traceContent}`);
  Logger.debug(`  Enable Scrubbing: ${config.enableScrubbing}`);

  // Initialize Traceloop SDK
  const traceloopOptions: InitializeOptions = {
    appName: config.appName,
    apiKey: config.apiKey,
    baseUrl: config.otlpEndpoint,
    disableBatch: config.disableBatch,
    traceContent: config.traceContent,
    headers: config.headers,
    instrumentModules,
    silenceInitializationMessage: !config.debugMode,
  };
  // ---- updated exporter setup (Python-equivalent) ----

  // 1) Pick base exporter (Console fallback OR TrialAware(OTLP))
  let exporter: SpanExporter;

  if (!traceloopOptions.baseUrl || traceloopOptions.baseUrl == undefined) {
    exporter = new ConsoleSpanExporter();
  } else {
    const formattedEndpoint = config.formatOtlpEndpoint();

    // In TS, we pass the config directly to our custom class
    // because it handles the HTTP transport itself to catch the error body.
    exporter = new TrialAwareOTLPExporter({
      url: formattedEndpoint,
      headers: config.headers,
    });
  }

  // 2) Always attempt filtering (even for Console fallback)
  //    The LocalFilteringSpanProcessor is instantiated below and its
  //    blockedParentMap is injected into FilteringSpanExporter so the
  //    two can share reparenting state without module-level globals.
  const globalBlockedPatterns = config.blockedSpans ?? [];
  const localFilteringSpanProcessor = new LocalFilteringSpanProcessor(globalBlockedPatterns);
  const originalExporter = exporter;

  try {
    exporter = new FilteringSpanExporter(
      exporter,
      globalBlockedPatterns,
      localFilteringSpanProcessor.blockedParentMap,
    );
  } catch {
    exporter = originalExporter;
  }

  traceloopOptions.exporter = exporter;

  initialize(traceloopOptions);

  if (instrumentModules.langchain) {
    patchTraceloopLangchainCallbackHandler();
  } else {
    disableTraceloopLangchainCallbackHandler();
  }

  // ---- rest stays same ----
  const tracerProvider = trace.getTracerProvider();

  // Add custom span processors to the TracerProvider
  // The Traceloop SDK creates a BasicTracerProvider internally
  const effectiveProvider = addCustomSpanProcessors(
    tracerProvider,
    config,
    resolvedRootNames,
  );

  // Initialize custom instrumentations asynchronously
  // We use async initialization to ensure we get the same ES module instances
  // that the application uses (important for ESM/CJS dual package handling)
  instrumentationsReady = initCustomInstrumentationsAsync(
    config,
    tracerProvider,
    customInstrumentModules,
    blockInstruments,
  );

  // Initialize additional OpenTelemetry instrumentations (uses resolved set)
  initOpenTelemetryInstrumentations(config, resolved, blockInstruments);

  return effectiveProvider;
}

/**
 * Returns true if the given instrument should be blocked.
 * Handles the ALL sentinel (blocks everything).
 */
function isBlocked(
  instrument: NetraInstruments,
  blockInstruments?: Set<NetraInstruments>,
): boolean {
  if (!blockInstruments || blockInstruments.size === 0) return false;
  return (
    blockInstruments.has(NetraInstruments.ALL) ||
    blockInstruments.has(instrument)
  );
}

/**
 * Initialize custom instrumentations asynchronously
 * This uses dynamic import() to ensure we patch the same ES module instances
 * that the application uses.
 */
async function initCustomInstrumentationsAsync(
  config: Config,
  tracerProvider: ReturnType<typeof trace.getTracerProvider>,
  customInstrumentModules: Record<string, boolean>,
  blockInstruments?: Set<NetraInstruments>,
): Promise<void> {
  if (customInstrumentModules.mistral) {
    try {
      await mistralAIInstrumentor.instrumentAsync({ tracerProvider });
      Logger.debug("Custom MistralAI instrumentation enabled");
    } catch (e) {
      Logger.debug("Failed to initialize custom MistralAI instrumentation:", e);
    }
  }

  if (customInstrumentModules.openai) {
    try {
      await openAIInstrumentor.instrument({ tracerProvider });
      Logger.debug("Custom OpenAI instrumentation enabled");
    } catch (e) {
      Logger.debug("Failed to initialize custom OpenAI instrumentation:", e);
    }
  }

  if (customInstrumentModules.groq) {
    try {
      await groqInstrumentor.instrumentAsync({ tracerProvider });
      Logger.debug("Custom Groq instrumentation enabled");
    } catch (e) {
      Logger.debug("Failed to initialize custom Groq instrumentation:", e);
    }
  }

  if (customInstrumentModules.googleGenAI) {
    try {
      await googleGenAIInstrumentor.instrument({ tracerProvider });
      Logger.debug("Custom Google GenAI instrumentation enabled");
    } catch (e) {
      Logger.debug(
        "Failed to initialize custom Google GenAI instrumentation:",
        e,
      );
    }
  }

  if (customInstrumentModules.googleGenerativeAI) {
    try {
      await googleGenerativeAIInstrumentor.instrumentAsync({ tracerProvider });
      Logger.debug("Custom Google Generative AI instrumentation enabled");
    } catch (e) {
      Logger.debug("Failed to initialize custom Google Generative AI instrumentation:", e);
    }
  }

  if (customInstrumentModules.langgraph) {
    try {
      await langgraphInstrumentor.instrument({ tracerProvider });
      Logger.debug("Custom Langgraph instrumentation enabled");
    } catch (e) {
      Logger.debug("Failed to initialize custom Langgraph instrumentation:", e);
    }
  }

  if (customInstrumentModules.anthropic) {
    try {
      await anthropicInstrumentor.instrument({ tracerProvider });
      Logger.debug("Custom Anthropic instrumentation enabled");
    } catch (e) {
      Logger.debug("Failed to initialize custom Anthropic instrumentation:", e);
    }
  }

  // Initialize OpenAI Agents SDK instrumentation
  if (
    customInstrumentModules.openAiAgents &&
    !blockInstruments?.has(NetraInstruments.OPENAI_AGENTS)
  ) {
    try {
      await openaiAgentsInstrumentor.instrument({ tracerProvider });
      Logger.debug("Custom OpenAI Agents SDK instrumentation enabled");
    } catch (e) {
      Logger.debug("Failed to initialize custom OpenAI Agents SDK instrumentation:", e);
    }
  }
}

function initOpenTelemetryInstrumentations(
  config: Config,
  resolved: Set<NetraInstruments>,
  blockInstruments?: Set<NetraInstruments>,
): void {
  // HTTP/HTTPS instrumentation
  // Also auto-enabled when Express is requested (Express needs HTTP for traceparent propagation)
  // Shared URL exclusion — mirrors Python's OTEL_PYTHON_EXCLUDED_URLS global.
  // Always skips internal Netra egress; OTEL_NODE_EXCLUDED_URLS adds user patterns.
  let netraHost = "";
  try {
    if (config.otlpEndpoint) {
      netraHost = new URL(config.otlpEndpoint).host;
    }
  } catch {
    Logger.debug(`OTEL_NODE_EXCLUDED_URLS: malformed otlpEndpoint '${config.otlpEndpoint}', skipping host-based exclusion`);
  }

  // Comma-separated regex patterns (unanchored search). Precompiled once;
  // invalid patterns are skipped so a bad entry never breaks instrumentation.
  const excludeRegexes = (process.env.OTEL_NODE_EXCLUDED_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch {
        if (config.debugMode) {
          Logger.debug(
            `Invalid OTEL_NODE_EXCLUDED_URLS pattern skipped: ${pattern}`,
          );
        }
        return null;
      }
    })
    .filter((re): re is RegExp => re !== null);

  const isExcludedUrl = (url: string): boolean => {
    if (netraHost && url.includes(netraHost)) return true;
    return excludeRegexes.some((re) => re.test(url));
  };

  if (
    !isBlocked(NetraInstruments.HTTP, blockInstruments) &&
    (resolved.has(NetraInstruments.HTTP) || resolved.has(NetraInstruments.EXPRESS))
  ) {
    try {
      const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
      const { registerInstrumentations } = require("@opentelemetry/instrumentation");
      _httpInstrumentation = new HttpInstrumentation({
        ignoreOutgoingRequestHook: (request: { host?: string; hostname?: string; path?: string }) => {
          const url = `${request.host ?? request.hostname ?? ""}${request.path ?? ""}`;
          return isExcludedUrl(url);
        },
      });
      registerInstrumentations({ instrumentations: [_httpInstrumentation] });
      if (config.debugMode) {
        Logger.debug("HTTP instrumentation enabled");
      }
    } catch (e) {
      Logger.debug("HTTP instrumentation not available:", e);
    }
  }

  // undici / native fetch instrumentation. instrumentation-http does NOT cover
  // Node's global fetch (Node 18+) — it is backed by undici and bypasses the
  // http module. This is the primary egress path for OpenAI/Anthropic/AI-SDK.
  const fetchEnabled =
    !isBlocked(NetraInstruments.HTTP, blockInstruments) &&
    resolved.has(NetraInstruments.HTTP);

  if (fetchEnabled) {
    try {
      const { UndiciInstrumentation } = require("@opentelemetry/instrumentation-undici");
      const { registerInstrumentations } = require("@opentelemetry/instrumentation");

      _undiciInstrumentation = new UndiciInstrumentation({
        ignoreRequestHook: (request: { origin?: string; path?: string }) => {
          const url = `${request.origin ?? ""}${request.path ?? ""}`;
          return isExcludedUrl(url);
        },
      });
      registerInstrumentations({ instrumentations: [_undiciInstrumentation] });
      if (config.debugMode) {
        Logger.debug("Undici/fetch instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        Logger.debug("Undici/fetch instrumentation not available:", e);
      }
    }
  }

  // Prisma instrumentation
  if (
    !isBlocked(NetraInstruments.PRISMA, blockInstruments) &&
    resolved.has(NetraInstruments.PRISMA) &&
    isPackageInstalled("@prisma/instrumentation")
  ) {
    try {
      const { PrismaInstrumentation } = require("@prisma/instrumentation");
      // Note: This would need to be registered with the SDK
    } catch (e) {
      Logger.debug("Prisma instrumentation not available:", e);
    }
  }

  if (
    !isBlocked(NetraInstruments.TYPEORM, blockInstruments) &&
    resolved.has(NetraInstruments.TYPEORM) &&
    isPackageInstalled("typeorm")
  ) {
    typeORMInstrumentor
      .instrument()
      .then(() => {
        Logger.debug("TypeORM instrumentation successfully initialized");
      })
      .catch((e) => {
        Logger.debug("TypeORM instrumentation error:", e);
      });
  }

  // Express instrumentation
  if (
    !isBlocked(NetraInstruments.EXPRESS, blockInstruments) &&
    resolved.has(NetraInstruments.EXPRESS)
  ) {
    try {
      const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
      const { registerInstrumentations } = require("@opentelemetry/instrumentation");
      registerInstrumentations({ instrumentations: [new ExpressInstrumentation()] });
      if (config.debugMode) {
        Logger.debug("Express instrumentation enabled");
      }
    } catch (e) {
      Logger.debug("Express instrumentation not available:", e);
    }
  }
}

/**
 * Add custom span processors to the TracerProvider
 * These processors add session context, instrumentation metadata, and scrubbing
 *
 * Returns the effective TracerProvider that processors were added to.
 */
function addCustomSpanProcessors(
  tracerProvider: ReturnType<typeof trace.getTracerProvider>,
  config: Config,
  rootInstrumentNames: Set<string> | null,
): TracerProviderWithProcessors | null {
  try {
    // The TracerProvider from Traceloop is a ProxyTracerProvider
    // We need to find the actual provider with addSpanProcessor method
    let provider: TracerProviderWithProcessors | null = null;

    // Try to access the delegate/underlying provider
    const providerAny = tracerProvider as any;

    // Check if it's a ProxyTracerProvider with a delegate
    if (
      providerAny._delegate &&
      typeof providerAny._delegate.addSpanProcessor === "function"
    ) {
      provider = providerAny._delegate as TracerProviderWithProcessors;
    }
    // Check if it has getDelegate method
    else if (typeof providerAny.getDelegate === "function") {
      const delegate = providerAny.getDelegate();
      if (delegate) {
        if (typeof delegate.addSpanProcessor === "function") {
          provider = delegate as TracerProviderWithProcessors;
        } else if (
          delegate._activeSpanProcessor &&
          delegate._activeSpanProcessor.constructor.name ===
            "MultiSpanProcessor" &&
          Array.isArray(delegate._activeSpanProcessor._spanProcessors)
        ) {
          // Fallback for OTel SDKs where addSpanProcessor is removed/protected
          // and MultiSpanProcessor is used (e.g. created by Traceloop)
          provider = {
            addSpanProcessor: (processor: SpanProcessor) => {
              delegate._activeSpanProcessor._spanProcessors.push(processor);
            },
            getTracer: (name: string, version?: string) => {
              return delegate.getTracer(name, version);
            },
          } as TracerProviderWithProcessors;
        }
      }
    }
    // Check if it directly has addSpanProcessor
    else if (typeof providerAny.addSpanProcessor === "function") {
      provider = providerAny as TracerProviderWithProcessors;
    }
    // Try accessing via global registry (NodeTracerProvider stores itself)
    else {
      try {
        // Try to get the active provider from the SDK
        const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
        // The provider might be accessible via other means
      } catch {
        // SDK not available
      }
    }

    if (!provider) {
      Logger.debug(
        "Could not access TracerProvider for adding span processors. " +
          "Session context will still be propagated via baggage.",
      );
      return null;
    }

    // ─── Processor registration order matters ───
    // Processors that wrap span.setAttribute form an implicit call chain:
    //   InstrumentationSpanProcessor (#1) wraps setAttribute for truncation,
    //   then SpanIOProcessor (#3) wraps the already-wrapped setAttribute for
    //   IO normalisation. Reordering these will break the chain silently.
    //
    // onEnd runs in registration order: SpanIOProcessor (#3) promotes
    // netra.user.input/output → input/output BEFORE RootSpanProcessor (#5)
    // cleans up its root span map.

    // 0. Local Filtering Span Processor - filters spans based on local context
    const localFilteringSpanProcessor = new LocalFilteringSpanProcessor();
    provider.addSpanProcessor(localFilteringSpanProcessor);

    // 0.5. Root Instrument Filter Processor - blocks root spans from non-allowed instrumentations
    // When rootInstrumentNames is null, all instrumentations may produce root spans (no filtering).
    if (rootInstrumentNames !== null) {
      const rootFilterProcessor = new RootInstrumentFilterProcessor(
        rootInstrumentNames,
      );
      provider.addSpanProcessor(rootFilterProcessor);
    }

    // 1. Instrumentation Span Processor - truncates attributes and adds instrumentation name.
    //    MUST run before SpanIOProcessor so the IO processor's setAttribute wrapper
    //    captures the truncation wrapper in its call chain.
    const instrumentationProcessor = new InstrumentationSpanProcessor();
    provider.addSpanProcessor(instrumentationProcessor);

    // 2. Session Span Processor - adds session context (session_id, user_id, etc.)
    const sessionProcessor = new SessionSpanProcessor(config.environment);
    provider.addSpanProcessor(sessionProcessor);

    // 3. Span I/O Processor - normalises input/output from gen_ai.prompt/completion
    //    and traceloop.entity attributes; remaps traceloop.* → netra.*
    //    MUST run after InstrumentationSpanProcessor (captures its setAttribute wrapper).
    //    MUST run before RootSpanProcessor (promotes netra.user.* in onEnd first).
    const spanIOProcessor = new SpanIOProcessor();
    provider.addSpanProcessor(spanIOProcessor);

    // 4. LLM Trace Identifier Span Processor - marks root spans that contain LLM calls
    const llmTraceProcessor = new LlmTraceIdentifierSpanProcessor();
    provider.addSpanProcessor(llmTraceProcessor);

    // 5. Root Span Processor - tracks the root span per trace by traceId.
    //    Registered AFTER LlmTraceIdentifierSpanProcessor so that on_end cleanup
    //    happens after the LLM processor has finished annotating the root span.
    //    Registered AFTER SpanIOProcessor so root spans have setAttribute wrapped
    //    before being stored in the root span map.
    const rootSpanProcessor = new RootSpanProcessor();
    provider.addSpanProcessor(rootSpanProcessor);

    // 6. Scrubbing Span Processor - scrubs sensitive data (if enabled)
    if (config.enableScrubbing) {
      const scrubbingProcessor = new ScrubbingSpanProcessor();
      provider.addSpanProcessor(scrubbingProcessor);
    }

    // 7. Attribute Size Limit Processor - enforces hard size limits on span
    //    attributes before export to prevent "entity too large" errors.
    //    MUST be last so it acts as final gate after all other processors.
    const sizeLimitProcessor = new AttributeSizeLimitProcessor(
      Config.SPAN_ATTRIBUTE_MAX_SIZE,
    );
    provider.addSpanProcessor(sizeLimitProcessor);

    Logger.debug("Custom span processors registered successfully");

    return provider;
  } catch (e) {
    Logger.debug("Failed to add custom span processors:", e);
    return null;
  }
}

/**
 * Uninstrument all active instrumentations
 * Should be called during shutdown
 */
export async function uninstrumentAll(): Promise<void> {
  // Uninstrument custom OpenAI instrumentation
  try {
    if (openAIInstrumentor.isInstrumented()) {
      await openAIInstrumentor.uninstrument();
      Logger.debug("Custom OpenAI instrumentation disabled");
    }
  } catch (e) {
    Logger.debug("Failed to uninstrument OpenAI:", e);
  }

  // Uninstrument custom MistralAI instrumentation
  try {
    if (mistralAIInstrumentor.isInstrumented()) {
      mistralAIInstrumentor.uninstrument();
      Logger.debug("Custom MistralAI instrumentation disabled");
    }
  } catch (e) {
    Logger.debug("Failed to uninstrument MistralAI:", e);
  }

  // Uninstrument custom Groq instrumentation
  try {
    if (groqInstrumentor.isInstrumented()) {
      groqInstrumentor.uninstrument();
      Logger.debug("Custom Groq instrumentation disabled");
    }
  } catch (e) {
    Logger.debug("Failed to uninstrument Groq:", e);
  }

  // Uninstrument custom Anthropic instrumentation
  try {
    if (anthropicInstrumentor.isInstrumented()) {
      anthropicInstrumentor.uninstrument();
      Logger.debug("Custom Anthropic instrumentation disabled");
    }
  } catch (e) {
    Logger.debug("Failed to uninstrument Anthropic:", e);
  }

  // Uninstrument custom Google GenAI instrumentation
  try {
    if (googleGenAIInstrumentor.isInstrumented()) {
      googleGenAIInstrumentor.uninstrument();
      Logger.debug("Custom Google GenAI instrumentation disabled");
    }
  } catch (e) {
    Logger.debug("Failed to uninstrument Google GenAI:", e);
  }

  // Uninstrument custom Google Generative AI instrumentation
  try {
    if (googleGenerativeAIInstrumentor.isInstrumented()) {
      googleGenerativeAIInstrumentor.uninstrument();
      Logger.debug("Custom Google Generative AI instrumentation disabled");
    }
  } catch (e) {
    Logger.debug("Failed to uninstrument Google Generative AI:", e);
  }

  // Uninstrument custom Langgraph instrumentation
  try {
    if (langgraphInstrumentor.isInstrumented()) {
      await langgraphInstrumentor.uninstrument();
      Logger.debug("Custom Langgraph instrumentation disabled");
    }
  } catch (e) {
    Logger.debug("Failed to uninstrument Langgraph:", e);
  }

  // Uninstrument custom TypeORM instrumentation
  try {
    if (typeORMInstrumentor.isInstrumented()) {
      typeORMInstrumentor.uninstrument();
      Logger.debug("Custom TypeORM instrumentation disabled");
    }
  } catch (e) {
    Logger.debug("Failed to uninstrument TypeORM:", e);
  }

  // Uninstrument custom OpenAI Agents SDK instrumentation
  try {
    if (openaiAgentsInstrumentor.isInstrumented()) {
      openaiAgentsInstrumentor.uninstrument();
      Logger.debug("Custom OpenAI Agents SDK instrumentation disabled");
    }
  } catch (e) {
    Logger.debug("Failed to uninstrument OpenAI Agents SDK:", e);
  }

  // Uninstrument HTTP instrumentation
  try {
    if (_httpInstrumentation) {
      _httpInstrumentation.disable();
      _httpInstrumentation = null;
      Logger.debug("HTTP instrumentation disabled");
    }
  } catch (e) {
    Logger.debug("Failed to uninstrument HTTP:", e);
  }

  // Uninstrument undici/fetch instrumentation
  try {
    if (_undiciInstrumentation) {
      _undiciInstrumentation.disable();
      _undiciInstrumentation = null;
      Logger.debug("Undici/fetch instrumentation disabled");
    }
  } catch (e) {
    Logger.debug("Failed to uninstrument undici:", e);
  }
}
