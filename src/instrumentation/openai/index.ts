/**
 * Custom OpenAI instrumentor for Netra SDK
 */

import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { __version__ } from "./version";
import {
  chatWrapper,
  achatWrapper,
  embeddingsWrapper,
  aembeddingsWrapper,
  responsesWrapper,
  aresponsesWrapper,
} from "./wrappers";

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
    // Initialize without tracer - will be set during instrument()
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
      // Use provided tracer provider or fall back to global
      if (this.tracerProvider) {
        this.tracer = this.tracerProvider.getTracer(
          INSTRUMENTATION_NAME,
          __version__
        );
      } else {
        this.tracer = trace.getTracer(INSTRUMENTATION_NAME, __version__);
      }
    } catch (error) {
      console.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    // Instrument chat completions
    this._instrumentChatCompletions();

    // Instrument embeddings
    this._instrumentEmbeddings();

    // Instrument responses
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

    // Uninstrument chat completions
    this._uninstrumentChatCompletions();

    // Uninstrument embeddings
    this._uninstrumentEmbeddings();

    // Uninstrument responses
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
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const openai = require("openai");

      // Get the Completions class from chat resources
      const Completions = openai.OpenAI?.Chat?.Completions ?? openai.default?.Chat?.Completions;
      const AsyncCompletions = openai.OpenAI?.Chat?.Completions ?? openai.default?.Chat?.Completions;

      // Try to get from the resources path
      let CompletionsClass: any;
      let AsyncCompletionsClass: any;

      try {
        const chatModule = require("openai/resources/chat/completions");
        CompletionsClass = chatModule.Completions;
        AsyncCompletionsClass = chatModule.Completions; // In JS SDK, same class handles both
      } catch {
        // Fallback: try to patch via prototype on OpenAI instance
        const OpenAI = openai.OpenAI ?? openai.default;
        if (OpenAI?.prototype?.chat?.completions) {
          CompletionsClass = OpenAI.prototype.chat.completions.constructor;
        }
      }

      if (CompletionsClass?.prototype?.create) {
        const originalCreate = CompletionsClass.prototype.create;
        originalMethods.set("chat.completions.create", originalCreate);

        const tracer = this.tracer;
        const wrapper = chatWrapper(tracer);
        const asyncWrapper = achatWrapper(tracer);

        CompletionsClass.prototype.create = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalCreate.bind(this);
          // First argument is the kwargs/options object
          const kwargs = (args[0] || {}) as Record<string, unknown>;
          const result = original(...args);

          // Check if result is a Promise (async call)
          if (result && typeof result.then === "function") {
            return asyncWrapper(
              (...a: unknown[]) => original(...a),
              this,
              args,
              kwargs
            );
          }

          return wrapper((...a: unknown[]) => original(...a), this, args, kwargs);
        };
      }
    } catch (error) {
      console.error(`Failed to instrument chat completions: ${error}`);
    }
  }

  private _instrumentEmbeddings(): void {
    if (!this.tracer) return;

    try {
      let EmbeddingsClass: any;

      try {
        const embeddingsModule = require("openai/resources/embeddings");
        EmbeddingsClass = embeddingsModule.Embeddings;
      } catch {
        // Fallback approach
        const openai = require("openai");
        const OpenAI = openai.OpenAI ?? openai.default;
        if (OpenAI?.prototype?.embeddings) {
          EmbeddingsClass = OpenAI.prototype.embeddings.constructor;
        }
      }

      if (EmbeddingsClass?.prototype?.create) {
        const originalCreate = EmbeddingsClass.prototype.create;
        originalMethods.set("embeddings.create", originalCreate);

        const tracer = this.tracer;
        const wrapper = embeddingsWrapper(tracer);
        const asyncWrapper = aembeddingsWrapper(tracer);

        EmbeddingsClass.prototype.create = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalCreate.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;
          const result = original(...args);

          if (result && typeof result.then === "function") {
            return asyncWrapper(
              (...a: unknown[]) => original(...a),
              this,
              args,
              kwargs
            );
          }

          return wrapper((...a: unknown[]) => original(...a), this, args, kwargs);
        };
      }
    } catch (error) {
      console.error(`Failed to instrument embeddings: ${error}`);
    }
  }

  private _instrumentResponses(): void {
    if (!this.tracer) return;

    try {
      let ResponsesClass: any;

      try {
        const responsesModule = require("openai/resources/responses");
        ResponsesClass = responsesModule.Responses;
      } catch {
        // Responses API might not exist in older versions
        return;
      }

      if (ResponsesClass?.prototype?.create) {
        const originalCreate = ResponsesClass.prototype.create;
        originalMethods.set("responses.create", originalCreate);

        const tracer = this.tracer;
        const wrapper = responsesWrapper(tracer);
        const asyncWrapper = aresponsesWrapper(tracer);

        ResponsesClass.prototype.create = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalCreate.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;
          const result = original(...args);

          if (result && typeof result.then === "function") {
            return asyncWrapper(
              (...a: unknown[]) => original(...a),
              this,
              args,
              kwargs
            );
          }

          return wrapper((...a: unknown[]) => original(...a), this, args, kwargs);
        };
      }
    } catch (error) {
      console.error(`Failed to instrument responses: ${error}`);
    }
  }

  private _uninstrumentChatCompletions(): void {
    try {
      const chatModule = require("openai/resources/chat/completions");
      const CompletionsClass = chatModule.Completions;

      const originalCreate = originalMethods.get("chat.completions.create");
      if (originalCreate && CompletionsClass?.prototype) {
        CompletionsClass.prototype.create = originalCreate;
      }
    } catch (error) {
      console.error(`Failed to uninstrument chat completions: ${error}`);
    }
  }

  private _uninstrumentEmbeddings(): void {
    try {
      const embeddingsModule = require("openai/resources/embeddings");
      const EmbeddingsClass = embeddingsModule.Embeddings;

      const originalCreate = originalMethods.get("embeddings.create");
      if (originalCreate && EmbeddingsClass?.prototype) {
        EmbeddingsClass.prototype.create = originalCreate;
      }
    } catch (error) {
      console.error(`Failed to uninstrument embeddings: ${error}`);
    }
  }

  private _uninstrumentResponses(): void {
    try {
      const responsesModule = require("openai/resources/responses");
      const ResponsesClass = responsesModule.Responses;

      const originalCreate = originalMethods.get("responses.create");
      if (originalCreate && ResponsesClass?.prototype) {
        ResponsesClass.prototype.create = originalCreate;
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
  achatWrapper,
  embeddingsWrapper,
  aembeddingsWrapper,
  responsesWrapper,
  aresponsesWrapper,
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

