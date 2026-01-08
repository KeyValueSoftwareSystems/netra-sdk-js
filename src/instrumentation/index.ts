/**
 * Instrumentation setup for Netra SDK
 */

import { initialize, InitializeOptions } from "@traceloop/node-server-sdk";
import { trace } from "@opentelemetry/api";
import { NetraInstruments, Config } from "../config";
import { openAIInstrumentor } from "./openai";
import { groqInstrumentor } from "./groq";
import { typeORMInstrumentor } from "./typeorm";
import { createRequire } from "module";

const require = createRequire(import.meta.url)

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

  if (instruments === undefined || instruments === null) {
    // Don't set openAI - we use our custom instrumentor instead
    useCustomOpenAI = true;
    useCustomGroq = true;
    instrumentModules.google_vertexai = true;
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
    if (instruments.has(NetraInstruments.GROQ)) {
      useCustomGroq = true;
    }
    if (instruments.has(NetraInstruments.GOOGLE_GENAI) || instruments.has(NetraInstruments.VERTEX_AI)) {
      // Google GenAI (Gemini) is supported via VertexAI instrumentation
      instrumentModules.google_vertexai = true;
    }
    if (instruments.has(NetraInstruments.LANGCHAIN) || instruments.has(NetraInstruments.LANGGRAPH)) {
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

  const tracerProvider = trace.getTracerProvider();

  // Initialize custom OpenAI instrumentation
  if (useCustomOpenAI && !blockInstruments?.has(NetraInstruments.OPENAI)) {
    try {
      openAIInstrumentor.instrument({ tracerProvider });
      if (config.debugMode) {
        console.debug("Custom OpenAI instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug("Failed to initialize custom OpenAI instrumentation:", e);
      }
    }
  }

  if (useCustomGroq && !blockInstruments?.has(NetraInstruments.GROQ)) {
    try {
      groqInstrumentor.instrument({ tracerProvider });
      if (config.debugMode) {
        console.debug("Custom Groq instrumentation enabled");
      }
    } catch (e) {
      if (config.debugMode) {
        console.debug("Failed to initialize custom Groq instrumentation:", e);
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
      const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
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
      typeORMInstrumentor.instrument().then(() => {
        if (config.debugMode) {
          console.debug("TypeORM instrumentation successfully initialized");
        }
      }).catch((e) => {
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
      // Note: This would need to be registered with the SDK
    } catch (e) {
      if (config.debugMode) {
        console.debug("Express instrumentation not available:", e);
      }
    }
  }
}

