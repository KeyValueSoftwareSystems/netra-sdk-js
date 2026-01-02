/**
 * Custom MistralAI instrumentor for Netra SDK
 */

import { createRequire } from "module";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { __version__ } from "./version";
import {
  chatWrapper,
  achatWrapper,
  chatStreamWrapper,
  achatStreamWrapper,
  embeddingsWrapper,
  aembeddingsWrapper,
  fimWrapper,
  afimWrapper,
  fimStreamWrapper,
  afimStreamWrapper,
  agentsWrapper,
  aagentsWrapper,
  agentsStreamWrapper,
  aagentsStreamWrapper,
} from "./wrappers";

// Create require function for ESM compatibility
const require = createRequire(import.meta.url);

const INSTRUMENTATION_NAME = "netra.instrumentation.mistralai";
const INSTRUMENTS = ["@mistralai/mistralai >= 1.0.0"];

// Store original methods for uninstrumentation
const originalMethods: Map<string, Function> = new Map();

// Track instrumentation state
let isInstrumented = false;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Custom MistralAI instrumentor for Netra SDK
 */
export class NetraMistralAIInstrumentor {
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
   * Instrument MistralAI client methods
   */
  instrument(options: InstrumentorOptions = {}): NetraMistralAIInstrumentor {
    if (isInstrumented) {
      console.warn("MistralAI is already instrumented");
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
    this._instrumentChat();

    // Instrument embeddings
    this._instrumentEmbeddings();

    // Instrument FIM
    this._instrumentFIM();

    // Instrument agents
    this._instrumentAgents();

    isInstrumented = true;
    return this;
  }

  /**
   * Uninstrument MistralAI client methods
   */
  uninstrument(): void {
    if (!isInstrumented) {
      console.warn("MistralAI is not instrumented");
      return;
    }

    // Uninstrument chat
    this._uninstrumentChat();

    // Uninstrument embeddings
    this._uninstrumentEmbeddings();

    // Uninstrument FIM
    this._uninstrumentFIM();

    // Uninstrument agents
    this._uninstrumentAgents();

    originalMethods.clear();
    isInstrumented = false;
  }

  /**
   * Check if MistralAI is currently instrumented
   */
  isInstrumented(): boolean {
    return isInstrumented;
  }

  private _instrumentChat(): void {
    if (!this.tracer) return;

    try {
      const chatModule = require("@mistralai/mistralai/sdk/chat");
      const ChatClass = chatModule.Chat;

      if (ChatClass?.prototype?.complete) {
        const originalComplete = ChatClass.prototype.complete;
        originalMethods.set("chat.complete", originalComplete);

        const tracer = this.tracer;
        const syncWrapper = chatWrapper(tracer);
        const asyncWrapper = achatWrapper(tracer);

        ChatClass.prototype.complete = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalComplete.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;

          const isAsyncFunction =
            originalComplete.constructor.name === "AsyncFunction";

          if (isAsyncFunction) {
            const wrappedFunction = async (...a: unknown[]) => original(...a);
            return asyncWrapper(wrappedFunction, this, args, kwargs);
          } else {
            const wrappedFunction = (...a: unknown[]) => original(...a);
            return syncWrapper(wrappedFunction, this, args, kwargs);
          }
        };
      }

      if (ChatClass?.prototype?.stream) {
        const originalStream = ChatClass.prototype.stream;
        originalMethods.set("chat.stream", originalStream);

        const tracer = this.tracer;
        const syncWrapper = chatStreamWrapper(tracer);
        const asyncWrapper = achatStreamWrapper(tracer);

        ChatClass.prototype.stream = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalStream.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;

          const isAsyncFunction =
            originalStream.constructor.name === "AsyncFunction";

          if (isAsyncFunction) {
            const wrappedFunction = async (...a: unknown[]) => original(...a);
            return asyncWrapper(wrappedFunction, this, args, kwargs);
          } else {
            const wrappedFunction = (...a: unknown[]) => original(...a);
            return syncWrapper(wrappedFunction, this, args, kwargs);
          }
        };
      }
    } catch (error) {
      console.error("Failed to instrument MistralAI chat:", error);
    }
  }

  private _instrumentEmbeddings(): void {
    if (!this.tracer) return;

    try {
      const embeddingsModule = require("@mistralai/mistralai/sdk/embeddings");
      const EmbeddingsClass = embeddingsModule.Embeddings;

      if (EmbeddingsClass?.prototype?.create) {
        const originalCreate = EmbeddingsClass.prototype.create;
        originalMethods.set("embeddings.create", originalCreate);

        const tracer = this.tracer;
        const syncWrapper = embeddingsWrapper(tracer);
        const asyncWrapper = aembeddingsWrapper(tracer);

        EmbeddingsClass.prototype.create = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalCreate.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;

          const isAsyncFunction =
            originalCreate.constructor.name === "AsyncFunction";

          if (isAsyncFunction) {
            const wrappedFunction = async (...a: unknown[]) => original(...a);
            return asyncWrapper(wrappedFunction, this, args, kwargs);
          } else {
            const wrappedFunction = (...a: unknown[]) => original(...a);
            return syncWrapper(wrappedFunction, this, args, kwargs);
          }
        };
      }
    } catch (error) {
      console.error("Failed to instrument MistralAI embeddings:", error);
    }
  }

  private _instrumentFIM(): void {
    if (!this.tracer) return;

    try {
      const fimModule = require("@mistralai/mistralai/sdk/fim");
      const FimClass = fimModule.Fim;

      if (FimClass?.prototype?.complete) {
        const originalComplete = FimClass.prototype.complete;
        originalMethods.set("fim.complete", originalComplete);

        const tracer = this.tracer;
        const syncWrapper = fimWrapper(tracer);
        const asyncWrapper = afimWrapper(tracer);

        FimClass.prototype.complete = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalComplete.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;

          const isAsyncFunction =
            originalComplete.constructor.name === "AsyncFunction";

          if (isAsyncFunction) {
            const wrappedFunction = async (...a: unknown[]) => original(...a);
            return asyncWrapper(wrappedFunction, this, args, kwargs);
          } else {
            const wrappedFunction = (...a: unknown[]) => original(...a);
            return syncWrapper(wrappedFunction, this, args, kwargs);
          }
        };
      }

      if (FimClass?.prototype?.stream) {
        const originalStream = FimClass.prototype.stream;
        originalMethods.set("fim.stream", originalStream);

        const tracer = this.tracer;
        const syncWrapper = fimStreamWrapper(tracer);
        const asyncWrapper = afimStreamWrapper(tracer);

        FimClass.prototype.stream = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalStream.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;

          const isAsyncFunction =
            originalStream.constructor.name === "AsyncFunction";

          if (isAsyncFunction) {
            const wrappedFunction = async (...a: unknown[]) => original(...a);
            return asyncWrapper(wrappedFunction, this, args, kwargs);
          } else {
            const wrappedFunction = (...a: unknown[]) => original(...a);
            return syncWrapper(wrappedFunction, this, args, kwargs);
          }
        };
      }
    } catch (error) {
      console.error("Failed to instrument MistralAI FIM:", error);
    }
  }

  private _instrumentAgents(): void {
    if (!this.tracer) return;

    try {
      const agentsModule = require("@mistralai/mistralai/sdk/agents");
      const AgentsClass = agentsModule.Agents;

      if (AgentsClass?.prototype?.complete) {
        const originalComplete = AgentsClass.prototype.complete;
        originalMethods.set("agents.complete", originalComplete);

        const tracer = this.tracer;
        const syncWrapper = agentsWrapper(tracer);
        const asyncWrapper = aagentsWrapper(tracer);

        AgentsClass.prototype.complete = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalComplete.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;

          const isAsyncFunction =
            originalComplete.constructor.name === "AsyncFunction";

          if (isAsyncFunction) {
            const wrappedFunction = async (...a: unknown[]) => original(...a);
            return asyncWrapper(wrappedFunction, this, args, kwargs);
          } else {
            const wrappedFunction = (...a: unknown[]) => original(...a);
            return syncWrapper(wrappedFunction, this, args, kwargs);
          }
        };
      }

      if (AgentsClass?.prototype?.stream) {
        const originalStream = AgentsClass.prototype.stream;
        originalMethods.set("agents.stream", originalStream);

        const tracer = this.tracer;
        const syncWrapper = agentsStreamWrapper(tracer);
        const asyncWrapper = aagentsStreamWrapper(tracer);

        AgentsClass.prototype.stream = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalStream.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;

          const isAsyncFunction =
            originalStream.constructor.name === "AsyncFunction";

          if (isAsyncFunction) {
            const wrappedFunction = async (...a: unknown[]) => original(...a);
            return asyncWrapper(wrappedFunction, this, args, kwargs);
          } else {
            const wrappedFunction = (...a: unknown[]) => original(...a);
            return syncWrapper(wrappedFunction, this, args, kwargs);
          }
        };
      }
    } catch (error) {
      console.error("Failed to instrument MistralAI agents:", error);
    }
  }

  private _uninstrumentChat(): void {
    try {
      const chatModule = require("@mistralai/mistralai/sdk/chat");
      const ChatClass = chatModule.Chat;

      const originalComplete = originalMethods.get("chat.complete");
      if (originalComplete && ChatClass?.prototype) {
        ChatClass.prototype.complete = originalComplete;
      }

      const originalStream = originalMethods.get("chat.stream");
      if (originalStream && ChatClass?.prototype) {
        ChatClass.prototype.stream = originalStream;
      }
    } catch (error) {
      console.error(`Failed to uninstrument MistralAI chat: ${error}`);
    }
  }

  private _uninstrumentEmbeddings(): void {
    try {
      const embeddingsModule = require("@mistralai/mistralai/sdk/embeddings");
      const EmbeddingsClass = embeddingsModule.Embeddings;

      const originalCreate = originalMethods.get("embeddings.create");
      if (originalCreate && EmbeddingsClass?.prototype) {
        EmbeddingsClass.prototype.create = originalCreate;
      }
    } catch (error) {
      console.error(`Failed to uninstrument MistralAI embeddings: ${error}`);
    }
  }

  private _uninstrumentFIM(): void {
    try {
      const fimModule = require("@mistralai/mistralai/sdk/fim");
      const FimClass = fimModule.Fim;

      const originalComplete = originalMethods.get("fim.complete");
      if (originalComplete && FimClass?.prototype) {
        FimClass.prototype.complete = originalComplete;
      }

      const originalStream = originalMethods.get("fim.stream");
      if (originalStream && FimClass?.prototype) {
        FimClass.prototype.stream = originalStream;
      }
    } catch (error) {
      console.error(`Failed to uninstrument MistralAI FIM: ${error}`);
    }
  }

  private _uninstrumentAgents(): void {
    try {
      const agentsModule = require("@mistralai/mistralai/sdk/agents");
      const AgentsClass = agentsModule.Agents;

      const originalComplete = originalMethods.get("agents.complete");
      if (originalComplete && AgentsClass?.prototype) {
        AgentsClass.prototype.complete = originalComplete;
      }

      const originalStream = originalMethods.get("agents.stream");
      if (originalStream && AgentsClass?.prototype) {
        AgentsClass.prototype.stream = originalStream;
      }
    } catch (error) {
      console.error(`Failed to uninstrument MistralAI agents: ${error}`);
    }
  }
}

// Export singleton instance for convenience
export const mistralAIInstrumentor = new NetraMistralAIInstrumentor();

// Re-export wrappers for advanced usage
export {
  chatWrapper,
  achatWrapper,
  chatStreamWrapper,
  achatStreamWrapper,
  embeddingsWrapper,
  aembeddingsWrapper,
  fimWrapper,
  afimWrapper,
  fimStreamWrapper,
  afimStreamWrapper,
  agentsWrapper,
  aagentsWrapper,
  agentsStreamWrapper,
  aagentsStreamWrapper,
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
