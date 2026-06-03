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
import { Config, NetraInstruments } from "../config";
import {
  InstrumentationSpanProcessor,
  LlmTraceIdentifierSpanProcessor,
  ScrubbingSpanProcessor,
  SessionSpanProcessor,
} from "../processors";
import { anthropicInstrumentor } from "./anthropic";
import { googleGenerativeAIInstrumentor } from "./google-genai";
import { groqInstrumentor } from "./groq";
import { langgraphInstrumentor } from "./langgraph";
import { mistralAIInstrumentor } from "./mistralai";
import { openAIInstrumentor } from "./openai";
import { typeORMInstrumentor } from "./typeorm";
import { FilteringSpanExporter, TrialAwareOTLPExporter } from "../exporters";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
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
        if (process.env.NETRA_DEBUG_LOGS) {
          console.log(
            `[Netra Debug] Traceloop ${methodName}: runId=${args[2]} parentRunId=${parentRunId} parentSpan=${parentSpan ? "yes" : "no"} activeSpanId=${active?.spanContext().spanId}`,
          );
        }
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
    if (process.env.NETRA_DEBUG_LOGS) {
      console.log(
        `[Netra Debug] Patched TraceloopCallbackHandler for parent context (${sourceLabel}).`,
      );
    }
  };

  try {
    const mod = require("@traceloop/instrumentation-langchain");
    if (process.env.NETRA_DEBUG_LOGS) {
      console.log(
        `[Netra Debug] Loaded @traceloop/instrumentation-langchain via require from ${require.resolve("@traceloop/instrumentation-langchain")}`,
      );
    }
    applyPatch(mod, "require");
    return;
  } catch (e) {
    if (process.env.NETRA_DEBUG_LOGS) {
      console.log("[Netra Debug] require() for traceloop langchain failed, falling back to import().");
    }
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
    if (process.env.NETRA_DEBUG_LOGS) {
      console.log(
        "[Netra Debug] Disabled Traceloop LangChain callback injection.",
      );
    }
  } catch {
    // no-op
  }
}

export function initInstrumentations(
  config: Config,
  instruments?: Set<NetraInstruments>,
  blockInstruments?: Set<NetraInstruments>,
): TracerProviderWithProcessors | null {
  // Map Netra instruments to Traceloop instrument modules
  const instrumentModules: InitializeOptions["instrumentModules"] = {};

  // Track whether to use custom instrumentors
  const customInstrumentModules: Record<string, boolean> = {
    openai: false,
    groq: false,
    mistral: false,
    langgraph: false,
    googleGenAI: false,
    anthropic: false,
  };

  if (!instruments || instruments.size === 0) {
    // Enable all by default
    customInstrumentModules.openai = true;
    customInstrumentModules.groq = true;
    customInstrumentModules.mistral = true;
    customInstrumentModules.langgraph = true;
    customInstrumentModules.googleGenAI = true;
    customInstrumentModules.anthropic = true;
  } else if (instruments.size) {
    // When specific instruments are provided, explicitly disable all Traceloop modules
    // to prevent default "enable all" behavior
    instrumentModules.google_vertexai = false;
    instrumentModules.langchain = false;
    instrumentModules.llamaIndex = false;
    instrumentModules.pinecone = false;
    instrumentModules.qdrant = false;
    instrumentModules.chromadb = false;
    instrumentModules.together = false;

    // Enable specific instruments
    if (instruments.has(NetraInstruments.OPENAI)) {
      customInstrumentModules.openai = true;
    }
    if (instruments.has(NetraInstruments.MISTRAL)) {
      customInstrumentModules.mistral = true;
    }
    if (instruments.has(NetraInstruments.GROQ)) {
      customInstrumentModules.groq = true;
    }
    if (instruments.has(NetraInstruments.GOOGLE_GENERATIVE_AI)) {
      customInstrumentModules.googleGenAI = true;
    }
    if (instruments.has(NetraInstruments.VERTEX_AI)) {
      // Vertex AI still uses Traceloop's vertexai module
      instrumentModules.google_vertexai = true;
    }
    if (instruments.has(NetraInstruments.LANGCHAIN)) {
      instrumentModules.langchain = true;
    }
    if (instruments.has(NetraInstruments.LANGGRAPH)) {
      customInstrumentModules.langgraph = true;
    }
    if (instruments.has(NetraInstruments.LLAMA_INDEX)) {
      instrumentModules.llamaIndex = true;
    }
    if (instruments.has(NetraInstruments.PINECONE)) {
      instrumentModules.pinecone = true;
    }
    if (instruments.has(NetraInstruments.QDRANT)) {
      instrumentModules.qdrant = true;
    }
    if (instruments.has(NetraInstruments.CHROMADB)) {
      instrumentModules.chromadb = true;
    }
    if (instruments.has(NetraInstruments.TOGETHER)) {
      instrumentModules.together = true;
    }
    if (instruments.has(NetraInstruments.ANTHROPIC)) {
      customInstrumentModules.anthropic = true;
    }
  }

  // Set Traceloop environment variables before initializing
  // This ensures the SDK picks up our configuration
  config.setTraceloopEnv();

  // Debug: Log configuration being used
  if (config.debugMode) {
    console.debug("Netra SDK Configuration:");
    console.debug(`  App Name: ${config.appName}`);
    console.debug(
      `  OTLP Endpoint: ${config.otlpEndpoint || "(default - localhost:3002)"}`,
    );
    console.debug(
      `  API Key: ${
        config.apiKey ? "***" + config.apiKey.slice(-4) : "(not set)"
      }`,
    );
    console.debug(`  Trace Content: ${config.traceContent}`);
    console.debug(`  Enable Scrubbing: ${config.enableScrubbing}`);
  }

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
  const originalExporter = exporter;

  try {
    const patterns = config.blockedSpans ?? [];
    exporter = new FilteringSpanExporter(exporter, patterns);
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
  const effectiveProvider = addCustomSpanProcessors(tracerProvider, config);

  // Initialize custom instrumentations asynchronously
  // We use async initialization to ensure we get the same ES module instances
  // that the application uses (important for ESM/CJS dual package handling)
  instrumentationsReady = initCustomInstrumentationsAsync(
    config,
    tracerProvider,
    customInstrumentModules,
    blockInstruments,
  );

  // Initialize additional OpenTelemetry instrumentations
  initOpenTelemetryInstrumentations(config, instruments, blockInstruments);

  return effectiveProvider;
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
  // Initialize custom MistralAI instrumentation
  if (
    customInstrumentModules.mistral &&
    !blockInstruments?.has(NetraInstruments.MISTRAL)
  ) {
    try {
      await mistralAIInstrumentor.instrumentAsync({ tracerProvider });
      if (config.debugMode) {
        console.debug("Custom MistralAI instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug(
          "Failed to initialize custom MistralAI instrumentation:",
          e,
        );
      }
    }
  }

  // Initialize custom OpenAI instrumentation
  if (
    customInstrumentModules.openai &&
    !blockInstruments?.has(NetraInstruments.OPENAI)
  ) {
    try {
      await openAIInstrumentor.instrumentAsync({ tracerProvider });
      if (config.debugMode) {
        console.debug("Custom OpenAI instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug("Failed to initialize custom OpenAI instrumentation:", e);
      }
    }
  }

  // Initialize custom Groq instrumentation
  if (
    customInstrumentModules.groq &&
    !blockInstruments?.has(NetraInstruments.GROQ)
  ) {
    try {
      await groqInstrumentor.instrumentAsync({ tracerProvider });
      if (config.debugMode) {
        console.debug("Custom Groq instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug("Failed to initialize custom Groq instrumentation:", e);
      }
    }
  }

  // Initialize custom Google GenAI instrumentation
  if (
    customInstrumentModules.googleGenAI &&
    !blockInstruments?.has(NetraInstruments.GOOGLE_GENERATIVE_AI)
  ) {
    try {
      await googleGenerativeAIInstrumentor.instrumentAsync({ tracerProvider });
      if (config.debugMode) {
        console.debug("Custom Google GenAI instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug(
          "Failed to initialize custom Google GenAI instrumentation:",
          e,
        );
      }
    }
  }

  // Initialize custom Langgraph instrumentation
  if (
    customInstrumentModules.langgraph &&
    !blockInstruments?.has(NetraInstruments.LANGGRAPH)
  ) {
    try {
      await langgraphInstrumentor.instrument({ tracerProvider });
      if (config.debugMode) {
        console.debug("Custom Langgraph instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug(
          "Failed to initialize custom Langgraph instrumentation:",
          e,
        );
      }
    }
  }

  if (
    customInstrumentModules.anthropic &&
    !blockInstruments?.has(NetraInstruments.ANTHROPIC)
  ) {
    try {
      await anthropicInstrumentor.instrumentAsync({ tracerProvider });
      if (config.debugMode) {
        console.debug("Custom Anthropic instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug(
          "Failed to initialize custom Anthropic instrumentation:",
          e,
        );
      }
    }
  }
}

function initOpenTelemetryInstrumentations(
  config: Config,
  instruments?: Set<NetraInstruments>,
  blockInstruments?: Set<NetraInstruments>,
): void {
  // HTTP instrumentation — also auto-enabled with EXPRESS because HttpInstrumentation
  // is what extracts traceparent from incoming request headers. Without it, Express
  // apps create a new root trace on every request instead of inheriting the caller's trace.
  const httpEnabled =
    !blockInstruments?.has(NetraInstruments.HTTP) &&
    (!instruments ||
      instruments.has(NetraInstruments.HTTP) ||
      instruments.has(NetraInstruments.EXPRESS));

  if (httpEnabled) {
    try {
      const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
      const { registerInstrumentations } = require("@opentelemetry/instrumentation");
      registerInstrumentations({ instrumentations: [new HttpInstrumentation()] });
      if (config.debugMode) {
        console.debug("HTTP instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug("HTTP instrumentation not available:", e);
      }
    }
  }

  // Prisma instrumentation
  if (
    !blockInstruments?.has(NetraInstruments.PRISMA) &&
    (!instruments || instruments.has(NetraInstruments.PRISMA))
  ) {
    try {
      const { PrismaInstrumentation } = require("@prisma/instrumentation");
      // Note: This would need to be registered with the SDK
    } catch (e) {
      if (config.debugMode) {
        console.debug("Prisma instrumentation not available:", e);
      }
    }
  }

  if (
    !blockInstruments?.has(NetraInstruments.TYPEORM) &&
    (!instruments || instruments.has(NetraInstruments.TYPEORM))
  ) {
    try {
      typeORMInstrumentor
        .instrument()
        .then(() => {
          if (config.debugMode) {
            console.debug("TypeORM instrumentation successfully initialized");
          }
        })
        .catch((e) => {
          console.error("TypeORM instrumentation error:", e);
          if (config.debugMode) {
            console.debug("TypeORM instrumentation error details:", e);
          }
        });
      if (config.debugMode) {
        console.debug("TypeORM instrumentation initialization started");
      }
    } catch (e) {
      console.error("TypeORM instrumentation failed to start:", e);
      if (config.debugMode) {
        console.debug("TypeORM instrumentation not available:", e);
      }
    }
  }

  // Express instrumentation
  if (
    !blockInstruments?.has(NetraInstruments.EXPRESS) &&
    (!instruments || instruments.has(NetraInstruments.EXPRESS))
  ) {
    try {
      const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
      const { registerInstrumentations } = require("@opentelemetry/instrumentation");
      registerInstrumentations({ instrumentations: [new ExpressInstrumentation()] });
      if (config.debugMode) {
        console.debug("Express instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug("Express instrumentation not available:", e);
      }
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
      if (config.debugMode) {
        console.debug(
          "Could not access TracerProvider for adding span processors. " +
            "Session context will still be propagated via baggage.",
        );
      }
      return null;
    }

    // 0. Local Filtering Span Processor - filters spans based on local context
    const localFilteringSpanProcessor = new LocalFilteringSpanProcessor();
    provider.addSpanProcessor(localFilteringSpanProcessor);

    // 1. Instrumentation Span Processor - truncates attributes and adds instrumentation name
    const instrumentationProcessor = new InstrumentationSpanProcessor();
    provider.addSpanProcessor(instrumentationProcessor);

    // 2. Session Span Processor - adds session context (session_id, user_id, etc.)
    const sessionProcessor = new SessionSpanProcessor();
    provider.addSpanProcessor(sessionProcessor);

    // 3. LLM Trace Identifier Span Processor - marks root spans that contain LLM calls
    const llmTraceProcessor = new LlmTraceIdentifierSpanProcessor();
    provider.addSpanProcessor(llmTraceProcessor);

    // 4. Scrubbing Span Processor - scrubs sensitive data (if enabled)
    if (config.enableScrubbing) {
      const scrubbingProcessor = new ScrubbingSpanProcessor();
      provider.addSpanProcessor(scrubbingProcessor);
    }

    if (config.debugMode) {
      console.debug("Custom span processors registered successfully");
    }

    return provider;
  } catch (e) {
    if (config.debugMode) {
      console.debug("Failed to add custom span processors:", e);
    }
    return null;
  }
}

/**
 * Uninstrument all active instrumentations
 * Should be called during shutdown
 */
export function uninstrumentAll(): void {
  // Uninstrument custom OpenAI instrumentation
  try {
    if (openAIInstrumentor.isInstrumented()) {
      openAIInstrumentor.uninstrument();
      console.debug("Custom OpenAI instrumentation disabled");
    }
  } catch (e) {
    console.debug("Failed to uninstrument OpenAI:", e);
  }

  // Uninstrument custom MistralAI instrumentation
  try {
    if (mistralAIInstrumentor.isInstrumented()) {
      mistralAIInstrumentor.uninstrument();
      console.debug("Custom MistralAI instrumentation disabled");
    }
  } catch (e) {
    console.debug("Failed to uninstrument MistralAI:", e);
  }

  // Uninstrument custom Groq instrumentation
  try {
    if (groqInstrumentor.isInstrumented()) {
      groqInstrumentor.uninstrument();
      console.debug("Custom Groq instrumentation disabled");
    }
  } catch (e) {
    console.debug("Failed to uninstrument Groq:", e);
  }

  // Uninstrument custom Anthropic instrumentation
  try {
    if (anthropicInstrumentor.isInstrumented()) {
      anthropicInstrumentor.uninstrument();
      console.debug("Custom Anthropic instrumentation disabled");
    }
  } catch (e) {
    console.debug("Failed to uninstrument Anthropic:", e);
  }

  // Uninstrument custom Google GenAI instrumentation
  try {
    if (googleGenerativeAIInstrumentor.isInstrumented()) {
      googleGenerativeAIInstrumentor.uninstrument();
      console.debug("Custom Google GenAI instrumentation disabled");
    }
  } catch (e) {
    console.debug("Failed to uninstrument Google GenAI:", e);
  }

  // Uninstrument custom Langgraph instrumentation
  try {
    if (langgraphInstrumentor.isInstrumented()) {
      langgraphInstrumentor.uninstrument();
      console.debug("Custom Langgraph instrumentation disabled");
    }
  } catch (e) {
    console.debug("Failed to uninstrument Langgraph:", e);
  }

  // Uninstrument custom TypeORM instrumentation
  try {
    if (typeORMInstrumentor.isInstrumented()) {
      typeORMInstrumentor.uninstrument();
      console.debug("Custom TypeORM instrumentation disabled");
    }
  } catch (e) {
    console.debug("Failed to uninstrument TypeORM:", e);
  }
}
