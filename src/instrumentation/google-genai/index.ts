/**
 * Custom Google GenAI instrumentor for Netra SDK
 */
import { createRequire } from "module";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { Logger } from "../../logger";
import { __version__ } from "./version";
import { chatStreamWrapper, chatWrapper, embeddingsWrapper } from "./wrappers";

import shimmer from "shimmer";

const INSTRUMENTATION_NAME = "netra.instrumentation.google_genai";
const INSTRUMENTS = ["@google/genai >= 0.24.1"];

// Track instrumentation state
let isInstrumented = false;
let generativeModelClasses: any[] = [];

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Resolve the Google GenAI module from the application's context.
 * Tries ESM dynamic import first, then falls back to CJS require so the
 * instrumentor works in both ESM and CommonJS projects.
 */
async function resolveGoogleGenerativeAIAsync(): Promise<any[]> {
  if (generativeModelClasses.length > 0) return generativeModelClasses;

  try {
    // @ts-ignore - @google/generative-ai is an optional peer dependency
    const googleGenAIModule = await import("@google/generative-ai");
    const esmClass =
      googleGenAIModule.GenerativeModel ||
      googleGenAIModule.default?.GenerativeModel ||
      googleGenAIModule.default ||
      googleGenAIModule;
    generativeModelClasses.push(esmClass);
  } catch {
    Logger.warn("Failed to resolve Google GenAI ESM module");
  }

  try {
    const req = createRequire(import.meta.url);
    const mod = req("@google/generative-ai");
    const cjsClass =
      mod.GenerativeModel ||
      mod.default?.GenerativeModel ||
      mod.default ||
      mod;
    if (!generativeModelClasses.includes(cjsClass)) {
      generativeModelClasses.push(cjsClass);
    }
  } catch {
    Logger.warn("Failed to resolve Google GenAI CJS module");
  }

  return generativeModelClasses;
}

/**
 * Synchronous version that returns cached classes.
 * Must call resolveGoogleGenerativeAIAsync() first to populate cache.
 */
function resolveGoogleGenerativeAI(): any[] {
  return generativeModelClasses;
}

/**
 * Custom Google GenAI instrumentor for Netra SDK
 */
export class NetraGoogleGenerativeAIInstrumentor {
  private tracer: Tracer | null = null;
  private tracerProvider?: TracerProvider;

  constructor() {
    // Tracer is initialized lazily during instrument()
  }

  /**
   * Returns the list of instrumentation dependencies
   */
  instrumentationDependencies(): string[] {
    return [...INSTRUMENTS];
  }

  /**
   * Instrument Google GenAI client methods (async version)
   * Tries both ESM and CJS resolution to cover dual-package setups.
   */
  async instrumentAsync(
    options: InstrumentorOptions = {},
  ): Promise<NetraGoogleGenerativeAIInstrumentor> {
    if (isInstrumented) {
      Logger.warn("Google GenAI is already instrumented");
      return this;
    }

    const classes = await resolveGoogleGenerativeAIAsync();
    if (classes.length === 0) {
      return this;
    }

    try {
      this.tracerProvider = options.tracerProvider;
      this.tracer = this.tracerProvider
        ? this.tracerProvider.getTracer(INSTRUMENTATION_NAME, __version__)
        : trace.getTracer(INSTRUMENTATION_NAME, __version__);
    } catch (error) {
      Logger.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    classes.forEach((model) => this._instrumentGenerativeModel(model));

    isInstrumented = true;
    return this;
  }

  /**
   * Instrument Google GenAI client methods (sync version)
   */
  instrument(
    options: InstrumentorOptions = {},
  ): NetraGoogleGenerativeAIInstrumentor {
    if (isInstrumented) {
      Logger.warn("Google GenAI is already instrumented");
      return this;
    }

    const classes = resolveGoogleGenerativeAI();
    if (classes.length === 0) {
      this.instrumentAsync(options).catch((e) => {
        Logger.error("Failed to instrument Google GenAI:", e);
      });
      return this;
    }

    try {
      this.tracerProvider = options.tracerProvider;
      this.tracer = this.tracerProvider
        ? this.tracerProvider.getTracer(INSTRUMENTATION_NAME, __version__)
        : trace.getTracer(INSTRUMENTATION_NAME, __version__);
    } catch (error) {
      Logger.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    classes.forEach((model) => this._instrumentGenerativeModel(model));

    isInstrumented = true;
    return this;
  }

  /**
   * Uninstrument Google GenAI client methods
   */
  uninstrument(): void {
    if (!isInstrumented) {
      Logger.warn("Google GenAI is not instrumented");
      return;
    }

    const classes = resolveGoogleGenerativeAI();
    classes.forEach((model) => this._uninstrumentGenerativeModel(model));

    generativeModelClasses = [];
    isInstrumented = false;
  }

  /**
   * Check if Google GenAI is currently instrumented
   */
  isInstrumented(): boolean {
    return isInstrumented;
  }

  private _instrumentGenerativeModel(GenerativeModel: any): void {
    if (!this.tracer) return;

    try {
      if (!GenerativeModel?.prototype) {
        Logger.error(
          "Failed to find Google GenAI GenerativeModel to instrument",
        );
        return;
      }

      const tracer = this.tracer;

      shimmer.wrap(
        GenerativeModel.prototype,
        "generateContent",
        chatWrapper(tracer),
      );

      shimmer.wrap(
        GenerativeModel.prototype,
        "generateContentStream",
        chatStreamWrapper(tracer),
      );

      shimmer.wrap(
        GenerativeModel.prototype,
        "embedContent",
        embeddingsWrapper(tracer),
      );
    } catch (error) {
      Logger.debug(
        `Google GenAI instrumentation: failed to instrument: ${error}`,
      );
    }
  }

  private _uninstrumentGenerativeModel(GenerativeModel: any): void {
    try {
      if (!GenerativeModel?.prototype) return;

      if (typeof GenerativeModel.prototype.generateContent === "function") {
        shimmer.unwrap(GenerativeModel.prototype, "generateContent");
      }
      if (
        typeof GenerativeModel.prototype.generateContentStream === "function"
      ) {
        shimmer.unwrap(GenerativeModel.prototype, "generateContentStream");
      }
      if (typeof GenerativeModel.prototype.embedContent === "function") {
        shimmer.unwrap(GenerativeModel.prototype, "embedContent");
      }
    } catch (error) {
      Logger.debug(`Failed to uninstrument Google GenAI: ${error}`);
    }
  }
}

// Export singleton instance for convenience
export const googleGenerativeAIInstrumentor =
  new NetraGoogleGenerativeAIInstrumentor();

// Re-export wrappers for advanced usage
export { chatWrapper, chatStreamWrapper, embeddingsWrapper } from "./wrappers";

// Re-export utilities
export { setRequestAttributes, setResponseAttributes } from "./utils";

export { __version__ } from "./version";
