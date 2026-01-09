/**
 * Custom OpenAI instrumentor for Netra SDK
 */

import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { __version__ } from "./version";
import { chatWrapper, embeddingsWrapper, responsesWrapper } from "./wrappers";
import { OpenAI } from "openai";

const INSTRUMENTATION_NAME = "netra.instrumentation.openai";
const INSTRUMENTS = ["openai >= 1.0.0"];

// Store original methods for uninstrumentation
const originalMethods: Map<string, Function> = new Map();

// Track instrumentation state
let isInstrumented = false;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Custom OpenAI instrumentor for Netra SDK
 */
export class NetraOpenAIInstrumentor {
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
   * Instrument OpenAI client methods
   */
  instrument(options: InstrumentorOptions = {}): NetraOpenAIInstrumentor {
    if (isInstrumented) {
      console.warn("OpenAI is already instrumented");
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

    this._instrumentChatCompletions();
    this._instrumentEmbeddings();
    this._instrumentResponses();

    isInstrumented = true;
    return this;
  }

  /**
   * Uninstrument OpenAI client methods
   */
  uninstrument(): void {
    if (!isInstrumented) {
      console.warn("OpenAI is not instrumented");
      return;
    }

    this._uninstrumentChatCompletions();
    this._uninstrumentEmbeddings();
    this._uninstrumentResponses();

    originalMethods.clear();
    isInstrumented = false;
  }

  /**
   * Check if OpenAI is currently instrumented
   */
  isInstrumented(): boolean {
    return isInstrumented;
  }

  private _instrumentChatCompletions(): void {
    if (!this.tracer) return;

    try {
      const CompletionsClass: any = OpenAI.Chat?.Completions;
      if (!CompletionsClass?.prototype?.create) {
        console.error(
          "Failed to find OpenAI chat completions class to instrument"
        );
        return;
      }
      const originalCreate = CompletionsClass.prototype.create;
      originalMethods.set("chat.completions.create", originalCreate);

      const tracer = this.tracer;
      const wrapper = chatWrapper(tracer);

      CompletionsClass.prototype.create = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        const original = originalCreate.bind(this);
        const kwargs = (args[0] || {}) as Record<string, unknown>;
        return wrapper((...a: unknown[]) => original(...a), this, args, kwargs);
      };
    } catch (error) {
      console.error(`Failed to instrument chat completions: ${error}`);
    }
  }

  private _instrumentEmbeddings(): void {
    if (!this.tracer) return;

    try {
      const EmbeddingsClass: any = OpenAI.Embeddings;
      if (!EmbeddingsClass?.prototype?.create) {
        console.error("Failed to find OpenAI embeddings class to instrument");
        return;
      }

      const originalCreate = EmbeddingsClass.prototype.create;
      originalMethods.set("embeddings.create", originalCreate);

      const tracer = this.tracer;
      const wrapper = embeddingsWrapper(tracer);

      EmbeddingsClass.prototype.create = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        const original = originalCreate.bind(this);
        const kwargs = (args[0] || {}) as Record<string, unknown>;
        return wrapper((...a: unknown[]) => original(...a), this, args, kwargs);
      };
    } catch (error) {
      console.error(`Failed to instrument embeddings: ${error}`);
    }
  }

  private _instrumentResponses(): void {
    if (!this.tracer) return;

    try {
      const ResponsesClass: any = OpenAI.Responses;
      if (!ResponsesClass?.prototype?.create) {
        console.error("Failed to find OpenAI responses class to instrument");
        return;
      }

      const originalCreate = ResponsesClass.prototype.create;
      originalMethods.set("responses.create", originalCreate);

      const tracer = this.tracer;
      const wrapper = responsesWrapper(tracer);

      ResponsesClass.prototype.create = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        const original = originalCreate.bind(this);
        const kwargs = (args[0] || {}) as Record<string, unknown>;
        return wrapper((...a: unknown[]) => original(...a), this, args, kwargs);
      };
    } catch (error) {
      console.error(`Failed to instrument responses: ${error}`);
    }
  }

  private _uninstrumentChatCompletions(): void {
    try {
      const CompletionsClass = OpenAI.Chat?.Completions;
      const originalCreate = originalMethods.get("chat.completions.create");

      if (originalCreate && CompletionsClass?.prototype?.create) {
        CompletionsClass.prototype.create =
          originalCreate as typeof CompletionsClass.prototype.create;
      }
    } catch (error) {
      console.error(`Failed to uninstrument chat completions: ${error}`);
    }
    return;
  }

  private _uninstrumentEmbeddings(): void {
    try {
      const EmbeddingsClass = OpenAI.Embeddings;
      const originalCreate = originalMethods.get("embeddings.create");

      if (originalCreate && EmbeddingsClass?.prototype?.create) {
        EmbeddingsClass.prototype.create =
          originalCreate as typeof EmbeddingsClass.prototype.create;
      }
    } catch (error) {
      console.error(`Failed to uninstrument embeddings: ${error}`);
    }
  }

  private _uninstrumentResponses(): void {
    try {
      const ResponsesClass = OpenAI.Responses;
      const originalCreate = originalMethods.get("responses.create");

      if (originalCreate && ResponsesClass?.prototype?.create) {
        ResponsesClass.prototype.create =
          originalCreate as typeof ResponsesClass.prototype.create;
      }
    } catch (error) {
      console.error(`Failed to uninstrument responses: ${error}`);
    }
  }
}

// Export singleton instance for convenience
export const openAIInstrumentor = new NetraOpenAIInstrumentor();

// Re-export wrappers for advanced usage
export {
  chatWrapper,
  embeddingsWrapper,
  responsesWrapper,
  StreamingWrapper,
  AsyncStreamingWrapper,
} from "./wrappers";

// Re-export utilities
export {
  modelAsDict,
  setRequestAttributes,
  setResponseAttributes,
  shouldSuppressInstrumentation,
} from "./utils";

export { __version__ } from "./version";
