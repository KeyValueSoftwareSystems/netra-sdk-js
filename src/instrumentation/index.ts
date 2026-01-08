/**
 * Instrumentation setup for Netra SDK
 */

import { initialize, InitializeOptions } from "@traceloop/node-server-sdk";
import { Config, NetraInstruments } from "../config";
import { mistralAIInstrumentor } from "./mistralai";

// Re-export shared utilities for use across instrumentations
export {
  modelAsDict,
  setRequestAttributes,
  setResponseAttributes,
  shouldSuppressInstrumentation,
} from "./utils";

// Track which instrumentations are active for cleanup
let mistralAIInstrumentationActive = false;

export function initInstrumentations(
  config: Config,
  instruments?: Set<NetraInstruments>,
  blockInstruments?: Set<NetraInstruments>
): void {
  // Map Netra instruments to Traceloop instrument modules
  const instrumentModules: InitializeOptions["instrumentModules"] = {};

  let useCustomMistralAI = false;

  if (!instruments || instruments.size === 0) {
    // Enable all by default
    useCustomMistralAI = true;
    instrumentModules.google_vertexai = true;
    instrumentModules.langchain = true;
    instrumentModules.llamaIndex = true;
    instrumentModules.pinecone = true;
    instrumentModules.qdrant = true;
    instrumentModules.chromadb = true;
    instrumentModules.together = true;
  } else {
    // Enable specific instruments
    if (instruments.has(NetraInstruments.MISTRAL)) {
      useCustomMistralAI = true;
    }
    if (
      instruments.has(NetraInstruments.GOOGLE_GENAI) ||
      instruments.has(NetraInstruments.VERTEX_AI)
    ) {
      // Google GenAI (Gemini) is supported via VertexAI instrumentation
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

  // Initialize custom MistralAI instrumentation
  if (useCustomMistralAI && !blockInstruments?.has(NetraInstruments.MISTRAL)) {
    try {
      mistralAIInstrumentor.instrument();
      mistralAIInstrumentationActive = mistralAIInstrumentor.isInstrumented();
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

  // TypeORM instrumentation
  if (
    !blockInstruments?.has(NetraInstruments.TYPEORM) &&
    (!instruments || instruments.has(NetraInstruments.TYPEORM))
  ) {
    try {
      // TypeORM instrumentation would be handled via OpenTelemetry
    } catch (e) {
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
 * Uninstrument all active instrumentations
 * Should be called during shutdown
 */
export function uninstrumentAll(): void {
  // Uninstrument MistralAI if it was active
  if (mistralAIInstrumentationActive) {
    try {
      mistralAIInstrumentor.uninstrument();
      mistralAIInstrumentationActive = false;
      console.debug("Custom MistralAI instrumentation disabled");
    } catch (e) {
      console.debug("Failed to uninstrument MistralAI:", e);
    }
  }
}
