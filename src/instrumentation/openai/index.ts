/**
 * Custom OpenAI instrumentor for Netra SDK
 *
 * Note: 'openai' is a peer dependency. The SDK dynamically imports it
 * to ensure we patch the same module instance the application uses.
 */

import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { __version__ } from "./version";
import { chatWrapper, embeddingsWrapper, responsesWrapper } from "./wrappers";

const INSTRUMENTATION_NAME = "netra.instrumentation.openai";
const INSTRUMENTS = ["openai >= 4.0.0"];

// Store original methods for uninstrumentation
const originalMethods: Map<string, Function> = new Map();

// Track instrumentation state
let isInstrumented = false;

// Cache the resolved OpenAI class
let OpenAIClass: any = null;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Dynamically resolve the OpenAI module from the application's context.
 * This ensures we patch the same module instance that the application uses.
 *
 * IMPORTANT: We use dynamic import() to ensure we get the same ES module
 * instance that the application uses. Using require() would give us a
 * different instance due to ESM/CJS dual package handling in Node.js.
 */
async function resolveOpenAIAsync(): Promise<any> {
  if (OpenAIClass) return OpenAIClass;

  try {
    // Use dynamic import to get the same ES module instance
    // @ts-ignore - openai is an optional peer dependency
    const openaiModule = await import("openai");
    OpenAIClass = openaiModule.OpenAI || openaiModule.default || openaiModule;
    return OpenAIClass;
  } catch {
    // Package not installed - this is fine, it's optional
    return null;
  }
}

/**
 * Synchronous version that returns cached class or null.
 * Must call resolveOpenAIAsync() first to populate cache.
 */
function resolveOpenAI(): any {
  return OpenAIClass;
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
   * Instrument OpenAI client methods (async version)
   * Uses dynamic import() to ensure we get the same ES module instance
   * that the application uses.
   */
  async instrumentAsync(
    options: InstrumentorOptions = {}
  ): Promise<NetraOpenAIInstrumentor> {
    if (isInstrumented) {
      console.warn("OpenAI is already instrumented");
      return this;
    }

    // Resolve OpenAI from application context using dynamic import
    const OpenAI = await resolveOpenAIAsync();
    if (!OpenAI) {
      // openai package not installed - skip silently (it's optional)
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

    this._instrumentChatCompletions(OpenAI);
    this._instrumentEmbeddings(OpenAI);
    this._instrumentResponses(OpenAI);

    isInstrumented = true;
    return this;
  }

  /**
   * Instrument OpenAI client methods (sync version - for backwards compatibility)
   * Note: This uses a cached OpenAI class. Call instrumentAsync() for proper initialization.
   */
  instrument(options: InstrumentorOptions = {}): NetraOpenAIInstrumentor {
    if (isInstrumented) {
      console.warn("OpenAI is already instrumented");
      return this;
    }

    // Try to get cached OpenAI class (must have called instrumentAsync first)
    const OpenAI = resolveOpenAI();
    if (!OpenAI) {
      // Fall back to async initialization
      this.instrumentAsync(options).catch((e) => {
        console.error("Failed to instrument OpenAI:", e);
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

    this._instrumentChatCompletions(OpenAI);
    this._instrumentEmbeddings(OpenAI);
    this._instrumentResponses(OpenAI);

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

    const OpenAI = resolveOpenAI();
    if (OpenAI) {
      this._uninstrumentChatCompletions(OpenAI);
      this._uninstrumentEmbeddings(OpenAI);
      this._uninstrumentResponses(OpenAI);
    }

    originalMethods.clear();
    isInstrumented = false;
  }

  /**
   * Check if OpenAI is currently instrumented
   */
  isInstrumented(): boolean {
    return isInstrumented;
  }

  private _instrumentChatCompletions(OpenAI: any): void {
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

  private _instrumentEmbeddings(OpenAI: any): void {
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

  private _instrumentResponses(OpenAI: any): void {
    if (!this.tracer) return;

    try {
      const ResponsesClass: any = OpenAI.Responses;
      if (!ResponsesClass?.prototype?.create) {
        // Responses API may not exist in older versions - skip silently
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

  private _uninstrumentChatCompletions(OpenAI: any): void {
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

  private _uninstrumentEmbeddings(OpenAI: any): void {
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

  private _uninstrumentResponses(OpenAI: any): void {
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
  AsyncStreamingWrapper,
  chatWrapper,
  embeddingsWrapper,
  responsesWrapper,
  StreamingWrapper,
} from "./wrappers";

// Re-export utilities
export { setRequestAttributes, setResponseAttributes } from "./utils";

export { __version__ } from "./version";
