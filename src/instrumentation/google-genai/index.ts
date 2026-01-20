/**
 * Custom Google GenAI instrumentor for Netra SDK
 */
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { __version__ } from "./version";
import { chatStreamWrapper, chatWrapper, embeddingsWrapper } from "./wrappers";
// Cache the resolved GenerativeModel class
let GenerativeModel: any = null;

import shimmer from "shimmer";

const INSTRUMENTATION_NAME = "netra.instrumentation.google-genai";
const INSTRUMENTS = ["@google/genai >= 0.1.0"];

// Track instrumentation state
let isInstrumented = false;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Dynamically resolve the Google GenAI module from the application's context.
 * This ensures we patch the same module instance that the application uses.
 *
 * IMPORTANT: We use dynamic import() to ensure we get the same ES module
 * instance that the application uses. Using require() would give us a
 * different instance due to ESM/CJS dual package handling in Node.js.
 */
async function resolveGoogleGenerativeAIAsync(): Promise<any> {
  if (GenerativeModel) return GenerativeModel;

  try {
    // Use dynamic import to get the same ES module instance
    // @ts-ignore - @google/generative-ai is an optional peer dependency
    const googleGenAIModule = await import("@google/generative-ai");
    GenerativeModel =
      googleGenAIModule.GenerativeModel ||
      googleGenAIModule.default?.GenerativeModel ||
      googleGenAIModule.default ||
      googleGenAIModule;
    return GenerativeModel;
  } catch {
    // Package not installed - this is fine, it's optional
    return null;
  }
}

/**
 * Synchronous version that returns cached class or null.
 * Must call resolveGoogleGenerativeAIAsync() first to populate cache.
 */
function resolveGoogleGenerativeAI(): any {
  return GenerativeModel;
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
   * Uses dynamic import() to ensure we get the same ES module instance
   * that the application uses.
   */
  async instrumentAsync(
    options: InstrumentorOptions = {},
  ): Promise<NetraGoogleGenerativeAIInstrumentor> {
    if (isInstrumented) {
      console.warn("Google GenAI is already instrumented");
      return this;
    }

    // Resolve Google GenAI from application context using dynamic import
    const model = await resolveGoogleGenerativeAIAsync();
    if (!model) {
      // package not installed - skip silently (it's optional)
      return this;
    }

    try {
      this.tracerProvider = options.tracerProvider;
      this.tracer = this.tracerProvider
        ? this.tracerProvider.getTracer(INSTRUMENTATION_NAME, __version__)
        : trace.getTracer(INSTRUMENTATION_NAME, __version__);
    } catch (error) {
      console.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    this._instrumentGenerativeModel();

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
      console.warn("Google GenAI is already instrumented");
      return this;
    }

    // Check if we have the cached class
    if (!resolveGoogleGenerativeAI()) {
      // Fall back to async initialization
      this.instrumentAsync(options).catch((e) => {
        console.error("Failed to instrument Google GenAI:", e);
      });
      return this;
    }

    try {
      this.tracerProvider = options.tracerProvider;
      this.tracer = this.tracerProvider
        ? this.tracerProvider.getTracer(INSTRUMENTATION_NAME, __version__)
        : trace.getTracer(INSTRUMENTATION_NAME, __version__);
    } catch (error) {
      console.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    this._instrumentGenerativeModel();

    isInstrumented = true;
    return this;
  }

  /**
   * Uninstrument Google GenAI client methods
   */
  uninstrument(): void {
    if (!isInstrumented) {
      console.warn("Google GenAI is not instrumented");
      return;
    }

    this._uninstrumentGenerativeModel();

    isInstrumented = false;
  }

  /**
   * Check if Google GenAI is currently instrumented
   */
  isInstrumented(): boolean {
    return isInstrumented;
  }

  private _instrumentGenerativeModel(): void {
    if (!this.tracer) return;

    try {
      if (!GenerativeModel) {
        console.error(
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
      console.debug(
        `Google GenAI instrumentation: failed to instrument: ${error}`,
      );
    }
  }

  private _uninstrumentGenerativeModel(): void {
    try {
      // Verify methods before unwrapping
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
      console.debug(`Failed to uninstrument Google GenAI: ${error}`);
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
