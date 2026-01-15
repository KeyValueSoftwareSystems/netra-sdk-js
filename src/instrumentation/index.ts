/**
 * Instrumentation setup for Netra SDK
 */

import { trace } from "@opentelemetry/api";
import { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { initialize, InitializeOptions } from "@traceloop/node-server-sdk";
import { createRequire } from "module";
import { Config, NetraInstruments } from "../config";
import {
  InstrumentationSpanProcessor,
  ScrubbingSpanProcessor,
  SessionSpanProcessor,
} from "../processors";
import { groqInstrumentor } from "./groq";
import { mistralAIInstrumentor } from "./mistralai";
import { openAIInstrumentor } from "./openai";
import { googleGenAIInstrumentor } from "./google-genai";
import { typeORMInstrumentor } from "./typeorm";

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

export function initInstrumentations(
  config: Config,
  instruments?: Set<NetraInstruments>,
  blockInstruments?: Set<NetraInstruments>
): void {
  // Map Netra instruments to Traceloop instrument modules
  const instrumentModules: InitializeOptions["instrumentModules"] = {};

  // Track whether to use custom instrumentors
  let useCustomOpenAI = false;
  let useCustomGroq = false;
  let useCustomMistralAI = false;
  let useCustomGoogleGenAI = false;

  if (!instruments || instruments.size === 0) {
    // Enable all by default
    // Don't set OpenAI/Groq/Mistral modules - we use custom instrumentors instead
    useCustomOpenAI = true;
    useCustomGroq = true;
    useCustomMistralAI = true;
    useCustomGoogleGenAI = true;
    instrumentModules.google_vertexai = false; // Use custom Google GenAI instead
    instrumentModules.langchain = true;
    instrumentModules.llamaIndex = true;
    instrumentModules.pinecone = true;
    instrumentModules.qdrant = true;
    instrumentModules.chromadb = true;
    instrumentModules.together = true;
  } else if (instruments.size) {
    // Enable specific instruments
    if (instruments.has(NetraInstruments.OPENAI)) {
      useCustomOpenAI = true;
    }
    if (instruments.has(NetraInstruments.MISTRAL)) {
      useCustomMistralAI = true;
    }
    if (instruments.has(NetraInstruments.GROQ)) {
      useCustomGroq = true;
    }
    if (instruments.has(NetraInstruments.GOOGLE_GENAI)) {
      useCustomGoogleGenAI = true;
    }
    if (instruments.has(NetraInstruments.VERTEX_AI)) {
      // Vertex AI still uses Traceloop's vertexai module
      instrumentModules.google_vertexai = true;
    }
    if (
      instruments.has(NetraInstruments.LANGCHAIN) ||
      instruments.has(NetraInstruments.LANGGRAPH)
    ) {
      // LangGraph is supported via LangChain instrumentation
      instrumentModules.langchain = true;
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
  }

  // Set Traceloop environment variables before initializing
  // This ensures the SDK picks up our configuration
  config.setTraceloopEnv();

  // Debug: Log configuration being used
  if (config.debugMode) {
    console.debug("Netra SDK Configuration:");
    console.debug(`  App Name: ${config.appName}`);
    console.debug(
      `  OTLP Endpoint: ${config.otlpEndpoint || "(default - localhost:3002)"}`
    );
    console.debug(
      `  API Key: ${
        config.apiKey ? "***" + config.apiKey.slice(-4) : "(not set)"
      }`
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

  initialize(traceloopOptions);

  const tracerProvider = trace.getTracerProvider();

  // Add custom span processors to the TracerProvider
  // The Traceloop SDK creates a BasicTracerProvider internally
  addCustomSpanProcessors(tracerProvider, config);

  // Initialize custom instrumentations asynchronously
  // We use async initialization to ensure we get the same ES module instances
  // that the application uses (important for ESM/CJS dual package handling)
  instrumentationsReady = initCustomInstrumentationsAsync(
    config,
    tracerProvider,
    useCustomOpenAI,
    useCustomGroq,
    useCustomMistralAI,
    blockInstruments
  );

  // Initialize additional OpenTelemetry instrumentations
  initOpenTelemetryInstrumentations(config, instruments, blockInstruments);
}

/**
 * Initialize custom instrumentations asynchronously
 * This uses dynamic import() to ensure we patch the same ES module instances
 * that the application uses.
 */
async function initCustomInstrumentationsAsync(
  config: Config,
  tracerProvider: ReturnType<typeof trace.getTracerProvider>,
  useCustomOpenAI: boolean,
  useCustomGroq: boolean,
  useCustomMistralAI: boolean,
  blockInstruments?: Set<NetraInstruments>
): Promise<void> {
  // Initialize custom MistralAI instrumentation
  if (useCustomMistralAI && !blockInstruments?.has(NetraInstruments.MISTRAL)) {
    try {
      await mistralAIInstrumentor.instrumentAsync({ tracerProvider });
      if (config.debugMode) {
        console.debug("Custom MistralAI instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug(
          "Failed to initialize custom MistralAI instrumentation:",
          e
        );
      }
    }
  }

  // Initialize custom OpenAI instrumentation
  if (useCustomOpenAI && !blockInstruments?.has(NetraInstruments.OPENAI)) {
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
  if (useCustomGroq && !blockInstruments?.has(NetraInstruments.GROQ)) {
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
    useCustomGoogleGenAI &&
    !blockInstruments?.has(NetraInstruments.GOOGLE_GENAI)
  ) {
    try {
      googleGenAIInstrumentor.instrument({ tracerProvider });
      if (config.debugMode) {
        console.debug("Custom Google GenAI instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug(
          "Failed to initialize custom Google GenAI instrumentation:",
          e
        );
      }
    }
  }

  // Initialize additional OpenTelemetry instrumentations
  initOpenTelemetryInstrumentations(config, instruments, blockInstruments);
}

function initOpenTelemetryInstrumentations(
  config: Config,
  instruments?: Set<NetraInstruments>,
  blockInstruments?: Set<NetraInstruments>
): void {
  // HTTP/HTTPS instrumentation
  if (
    !blockInstruments?.has(NetraInstruments.HTTP) &&
    (!instruments || instruments.has(NetraInstruments.HTTP))
  ) {
    try {
      const {
        HttpInstrumentation,
      } = require("@opentelemetry/instrumentation-http");
      const httpInstrumentation = new HttpInstrumentation();
      // Note: This would need to be registered with the SDK
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
      const {
        ExpressInstrumentation,
      } = require("@opentelemetry/instrumentation-express");
      // Note: This would need to be registered with the SDK
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
 */
function addCustomSpanProcessors(
  tracerProvider: ReturnType<typeof trace.getTracerProvider>,
  config: Config
): void {
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
      if (delegate && typeof delegate.addSpanProcessor === "function") {
        provider = delegate as TracerProviderWithProcessors;
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
            "Session context will still be propagated via baggage."
        );
      }
      return;
    }

    // 1. Instrumentation Span Processor - truncates attributes and adds instrumentation name
    const instrumentationProcessor = new InstrumentationSpanProcessor();
    provider.addSpanProcessor(instrumentationProcessor);

    // 2. Session Span Processor - adds session context (session_id, user_id, etc.)
    const sessionProcessor = new SessionSpanProcessor();
    provider.addSpanProcessor(sessionProcessor);

    // 3. Scrubbing Span Processor - scrubs sensitive data (if enabled)
    if (config.enableScrubbing) {
      const scrubbingProcessor = new ScrubbingSpanProcessor();
      provider.addSpanProcessor(scrubbingProcessor);
    }

    if (config.debugMode) {
      console.debug("Custom span processors registered successfully");
    }
  } catch (e) {
    if (config.debugMode) {
      console.debug("Failed to add custom span processors:", e);
    }
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

  // Uninstrument custom Google GenAI instrumentation
  try {
    if (googleGenAIInstrumentor.isInstrumented()) {
      googleGenAIInstrumentor.uninstrument();
      console.debug("Custom Google GenAI instrumentation disabled");
    }
  } catch (e) {
    console.debug("Failed to uninstrument Google GenAI:", e);
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
