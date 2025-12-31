/**
 * Custom OpenAI instrumentor for Netra SDK
 */

import { createRequire } from "module";
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

// Create require function for ESM compatibility
const require = createRequire(import.meta.url);

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
    return INSTRUMENTS;
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
      try {
        const chatModule = require("openai/resources/chat/completions");
        const CompletionsClass = chatModule.Completions;

        if (CompletionsClass?.prototype?.create) {
          const originalCreate = CompletionsClass.prototype.create;
          originalMethods.set("chat.completions.create", originalCreate);

          const tracer = this.tracer;
          // Create both sync and async wrappers for flexibility
          const syncWrapper = chatWrapper(tracer);
          const asyncWrapper = achatWrapper(tracer);

          CompletionsClass.prototype.create = function (
            this: unknown,
            ...args: unknown[]
          ): unknown {
            const original = originalCreate.bind(this);
            const kwargs = (args[0] || {}) as Record<string, unknown>;
            
            // Check if the original function is an async function
            const isAsyncFunction = originalCreate.constructor.name === "AsyncFunction";
            
            if (isAsyncFunction) {
              // Use async wrapper for async functions
              const wrappedFunction = async (...a: unknown[]) => original(...a);
              return asyncWrapper(wrappedFunction, this, args, kwargs);
            } else {
              // Use sync wrapper for sync functions
              const wrappedFunction = (...a: unknown[]) => original(...a);
              return syncWrapper(wrappedFunction, this, args, kwargs);
            }
          };
        }
      } catch {
        console.error("Failed to instrument chat completions");
      }
    } catch (error) {
      console.error("Failed to instrument chat completions:", error);
    }
  }

  private _instrumentEmbeddings(): void {
    if (!this.tracer) return;

    try {
      try {
        const embeddingsModule = require("openai/resources/embeddings");
        const EmbeddingsClass = embeddingsModule.Embeddings;
        
        if (EmbeddingsClass?.prototype?.create) {
          const originalCreate = EmbeddingsClass.prototype.create;
          originalMethods.set("embeddings.create", originalCreate);

          const tracer = this.tracer;
          // Create both sync and async wrappers for flexibility
          const syncWrapper = embeddingsWrapper(tracer);
          const asyncWrapper = aembeddingsWrapper(tracer);

          EmbeddingsClass.prototype.create = function (
            this: unknown,
            ...args: unknown[]
          ): unknown {
            const original = originalCreate.bind(this);
            const kwargs = (args[0] || {}) as Record<string, unknown>;
            
            // Check if the original function is an async function
            const isAsyncFunction = originalCreate.constructor.name === "AsyncFunction";
            
            if (isAsyncFunction) {
              // Use async wrapper for async functions
              const wrappedFunction = async (...a: unknown[]) => original(...a);
              return asyncWrapper(wrappedFunction, this, args, kwargs);
            } else {
              // Use sync wrapper for sync functions
              const wrappedFunction = (...a: unknown[]) => original(...a);
              return syncWrapper(wrappedFunction, this, args, kwargs);
            }
          };
        }
      } catch (error) {
        console.error(`Failed to instrument embeddings: ${error}`);
      }
    } catch (error) {
      console.error("Failed to instrument embeddings:", error);
    }
  }

  private _instrumentResponses(): void {
    if (!this.tracer) return;

    try {
      const responsesModule = require("openai/resources/responses");
      const ResponsesClass = responsesModule.Responses;

      if (ResponsesClass?.prototype?.create) {
        const originalCreate = ResponsesClass.prototype.create;
        originalMethods.set("responses.create", originalCreate);

        const tracer = this.tracer;
        // Create both sync and async wrappers for flexibility
        const syncWrapper = responsesWrapper(tracer);
        const asyncWrapper = aresponsesWrapper(tracer);

        ResponsesClass.prototype.create = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalCreate.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;
          
          // Check if the original function is an async function
          const isAsyncFunction = originalCreate.constructor.name === "AsyncFunction";
          
          if (isAsyncFunction) {
            // Use async wrapper for async functions
            const wrappedFunction = async (...a: unknown[]) => original(...a);
            return asyncWrapper(wrappedFunction, this, args, kwargs);
          } else {
            // Use sync wrapper for sync functions
            const wrappedFunction = (...a: unknown[]) => original(...a);
            return syncWrapper(wrappedFunction, this, args, kwargs);
          }
        };
      }
    } catch (error) {
      console.error("Failed to instrument responses:", error);
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
