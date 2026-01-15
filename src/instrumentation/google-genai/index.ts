/**
 * Custom Google GenAI instrumentor for Netra SDK
 */
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { __version__ } from "./version";
import { chatWrapper, embeddingsWrapper } from "./wrappers";
import { GenerativeModel } from "@google/generative-ai";
import shimmer from "shimmer";

const INSTRUMENTATION_NAME = "netra.instrumentation.google-genai";
const INSTRUMENTS = ["@google/generative-ai >= 0.1.0"];

// Track instrumentation state
let isInstrumented = false;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Custom Google GenAI instrumentor for Netra SDK
 */
export class NetraGoogleGenAIInstrumentor {
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
   * Instrument Google GenAI client methods
   */
  instrument(options: InstrumentorOptions = {}): NetraGoogleGenAIInstrumentor {
    if (isInstrumented) {
      console.warn("Google GenAI is already instrumented");
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
      if (!GenerativeModel?.prototype?.generateContent) {
        console.error(
          "Failed to find Google GenAI GenerativeModel to instrument"
        );
        return;
      }

      const tracer = this.tracer;

      shimmer.wrap(
        GenerativeModel.prototype,
        "generateContent",
        chatWrapper(tracer)
      );

      shimmer.wrap(
        GenerativeModel.prototype,
        "embedContent",
        embeddingsWrapper(tracer)
      );
    } catch (error) {
      console.debug(
        `Google GenAI instrumentation: failed to instrument: ${error}`
      );
    }
  }

  private _uninstrumentGenerativeModel(): void {
    try {
      // Verify methods before unwrapping
      if (typeof GenerativeModel.prototype.generateContent === "function") {
        shimmer.unwrap(GenerativeModel.prototype, "generateContent");
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
export const googleGenAIInstrumentor = new NetraGoogleGenAIInstrumentor();

// Re-export wrappers for advanced usage
export { chatWrapper, embeddingsWrapper } from "./wrappers";

// Re-export utilities
export { setRequestAttributes, setResponseAttributes } from "./utils";

export { __version__ } from "./version";
