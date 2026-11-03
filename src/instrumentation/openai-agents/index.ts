import { trace, Tracer } from "@opentelemetry/api";
import { createRequire } from "module";
import { NetraAgentsTracingProcessor } from "./processor";
import { DEFAULT_LLM_SYSTEM, INSTRUMENTATION_NAME } from "./constants";
import { __version__ } from "./version";
import { NetraLogger } from "../../netraLogger";
import { parseNativeTracingEnv } from "../utils";
import type { NativeTracingMode } from "../utils";
import type { InstrumentorOptions, TracingProcessor } from "./types";

let cachedAgentsModule: any = null;
let isInstrumented = false;
let activeTracer: Tracer | null = null;
let activeProcessor: NetraAgentsTracingProcessor | null = null;
let originalProcessors: TracingProcessor[] | null = null;
let didReplaceProcessors = false;

/**
 * Resolve the @openai/agents module from the application's context.
 * Tries ESM dynamic import first (same instance as the app), then falls back
 * to CJS require so the instrumentor works in both ESM and CommonJS projects.
 */
async function resolveAgentsModule(): Promise<any> {
  if (cachedAgentsModule) return cachedAgentsModule;

  try {
    // @ts-ignore - @openai/agents is an optional peer dependency
    const mod = await import("@openai/agents");
    cachedAgentsModule = mod;
    return cachedAgentsModule;
  } catch {
    NetraLogger.debug("ESM resolution of @openai/agents failed, trying CJS fallback");
  }

  try {
    const req = createRequire(import.meta.url);
    const mod = req("@openai/agents");
    cachedAgentsModule = mod;
    return cachedAgentsModule;
  } catch {
    NetraLogger.debug("CJS resolution of @openai/agents also failed");
  }

  return null;
}

export class NetraOpenAIAgentsInstrumentor {
  isInstrumented(): boolean {
    return isInstrumented;
  }

  /**
   * Register the Netra tracing processor with the OpenAI Agents SDK.
   *
   * Returns `this` in all cases (success **and** failure) so the call can be
   * chained. Check {@link isInstrumented} afterwards to verify the processor
   * was registered successfully.
   */
  async instrument(
    options: InstrumentorOptions = {},
  ): Promise<NetraOpenAIAgentsInstrumentor> {
    if (isInstrumented) {
      NetraLogger.warn("OpenAI Agents SDK is already instrumented");
      return this;
    }

    try {
      const provider = options.tracerProvider;
      activeTracer = provider
        ? provider.getTracer(INSTRUMENTATION_NAME, __version__)
        : trace.getTracer(INSTRUMENTATION_NAME, __version__);
    } catch (error) {
      NetraLogger.error(`Failed to initialize tracer for OpenAI Agents: ${error}`);
      return this;
    }

    const agentsModule = await resolveAgentsModule();
    if (!agentsModule) {
      NetraLogger.warn(
        "OpenAI Agents SDK (@openai/agents) not found.",
        "Install it to enable automatic agent tracing.",
      );
      return this;
    }

    const systemName = options.systemName ?? DEFAULT_LLM_SYSTEM;
    activeProcessor = new NetraAgentsTracingProcessor(activeTracer!, systemName);

    const mode: NativeTracingMode = options.nativeTracing
      ?? parseNativeTracingEnv("NATIVE_TRACING_MODE")
      ?? "netra-strict";

    const canSet = typeof agentsModule.setTraceProcessors === "function";
    const canAdd = typeof agentsModule.addTraceProcessor === "function";

    let strategy: "replace" | "append" | "skip";
    if (mode === "both" || (mode === "netra" && !canSet)) {
      strategy = "append";
    } else if (canSet) {
      strategy = "replace";
    } else {
      strategy = "skip";
    }

    try {
      switch (strategy) {
        case "replace":
          if (typeof agentsModule.getTraceProcessors === "function") {
            originalProcessors = agentsModule.getTraceProcessors();
          }
          agentsModule.setTraceProcessors([activeProcessor]);
          didReplaceProcessors = true;
          NetraLogger.debug("OpenAI Agents native tracing disabled — traces will only be sent to Netra.");
          break;

        case "append":
          if (canAdd) {
            agentsModule.addTraceProcessor(activeProcessor);
          } else {
            NetraLogger.warn("OpenAI Agents SDK does not expose addTraceProcessor or setTraceProcessors.");
            activeProcessor = null;
            activeTracer = null;
            return this;
          }
          if (mode === "netra") {
            NetraLogger.warn(
              "Cannot exclusively replace native trace processors in this @openai/agents version.",
              "Traces may still be sent to OpenAI.",
            );
          }
          break;

        case "skip":
          NetraLogger.warn(
            "nativeTracing is \"netra-strict\" but the installed @openai/agents version",
            "does not support processor replacement. Skipping instrumentation.",
          );
          activeProcessor = null;
          activeTracer = null;
          return this;
      }
    } catch (error) {
      NetraLogger.warn("Failed to register trace processor with @openai/agents:", error);
      activeProcessor = null;
      activeTracer = null;
      return this;
    }

    isInstrumented = true;
    return this;
  }

  uninstrument(): void {
    if (!isInstrumented) {
      NetraLogger.warn("OpenAI Agents SDK is not instrumented");
      return;
    }

    if (activeProcessor) {
      activeProcessor.shutdown();
      activeProcessor = null;
    }

    if (didReplaceProcessors && cachedAgentsModule) {
      try {
        if (originalProcessors && typeof cachedAgentsModule.setTraceProcessors === "function") {
          cachedAgentsModule.setTraceProcessors(originalProcessors);
          NetraLogger.debug("Restored original OpenAI Agents trace processors");
        } else if (typeof cachedAgentsModule.setDefaultOpenAITracingExporter === "function") {
          cachedAgentsModule.setDefaultOpenAITracingExporter();
          NetraLogger.debug("Restored default OpenAI Agents tracing exporter");
        }
      } catch (error) {
        NetraLogger.debug("Failed to restore original trace processors:", error);
      }
    }

    originalProcessors = null;
    didReplaceProcessors = false;
    activeTracer = null;
    cachedAgentsModule = null;
    isInstrumented = false;
  }
}

export const openaiAgentsInstrumentor = new NetraOpenAIAgentsInstrumentor();

export { NetraAgentsTracingProcessor } from "./processor";
export type { AgentSpan, AgentTrace, InstrumentorOptions, NativeTracingMode, TracingProcessor } from "./types";
