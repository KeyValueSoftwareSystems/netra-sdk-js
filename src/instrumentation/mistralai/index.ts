/**
 * Custom MistralAI instrumentor for Netra SDK
 */

import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { createRequire } from "module";
import { __version__ } from "./version";
import {
  agentsStreamWrapper,
  agentsWrapper,
  chatStreamWrapper,
  chatWrapper,
  embeddingsWrapper,
  fimStreamWrapper,
  fimWrapper,
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

    // Instrument client methods. Mark instrumented only if we actually patched anything.
    // NOTE: don't use `a() || b() || ...` here — it short-circuits and would stop
    // patching after the first successful instrumentation.
    const patchedChat = this._instrumentChat();
    const patchedEmbeddings = this._instrumentEmbeddings();
    const patchedFIM = this._instrumentFIM();
    const patchedAgents = this._instrumentAgents();
    const didPatch =
      patchedChat || patchedEmbeddings || patchedFIM || patchedAgents;

    if (!didPatch) {
      console.warn(
        "MistralAI instrumentation initialized but no methods were patched. Is '@mistralai/mistralai' installed and compatible?"
      );
      return this;
    }

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

  private _instrumentChat(): boolean {
    if (!this.tracer) return false;

    try {
      const chatModule = require("@mistralai/mistralai/sdk/chat");
      const ChatClass = chatModule.Chat;
      let didPatch = false;

      if (ChatClass?.prototype?.complete) {
        const originalComplete = ChatClass.prototype.complete;
        originalMethods.set("chat.complete", originalComplete);

        const tracer = this.tracer;
        const wrapper = chatWrapper(tracer);

        ChatClass.prototype.complete = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalComplete.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;
          return wrapper(
            (...a: unknown[]) => original(...a),
            this,
            args,
            kwargs
          );
        };
        didPatch = true;
      }

      if (ChatClass?.prototype?.stream) {
        const originalStream = ChatClass.prototype.stream;
        originalMethods.set("chat.stream", originalStream);

        const tracer = this.tracer;
        const wrapper = chatStreamWrapper(tracer);

        ChatClass.prototype.stream = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalStream.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;
          return wrapper(
            (...a: unknown[]) => original(...a),
            this,
            args,
            kwargs
          );
        };
        didPatch = true;
      }

      return didPatch;
    } catch (error) {
      console.error("Failed to instrument MistralAI chat:", error);
      return false;
    }
  }

  private _instrumentEmbeddings(): boolean {
    if (!this.tracer) return false;

    try {
      const embeddingsModule = require("@mistralai/mistralai/sdk/embeddings");
      const EmbeddingsClass = embeddingsModule.Embeddings;
      let didPatch = false;

      if (EmbeddingsClass?.prototype?.create) {
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
          return wrapper(
            (...a: unknown[]) => original(...a),
            this,
            args,
            kwargs
          );
        };
        didPatch = true;
      }

      return didPatch;
    } catch (error) {
      console.error("Failed to instrument MistralAI embeddings:", error);
      return false;
    }
  }

  private _instrumentFIM(): boolean {
    if (!this.tracer) return false;

    try {
      const fimModule = require("@mistralai/mistralai/sdk/fim");
      const FimClass = fimModule.Fim;
      let didPatch = false;

      if (FimClass?.prototype?.complete) {
        const originalComplete = FimClass.prototype.complete;
        originalMethods.set("fim.complete", originalComplete);

        const tracer = this.tracer;
        const wrapper = fimWrapper(tracer);

        FimClass.prototype.complete = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalComplete.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;
          return wrapper(
            (...a: unknown[]) => original(...a),
            this,
            args,
            kwargs
          );
        };
        didPatch = true;
      }

      if (FimClass?.prototype?.stream) {
        const originalStream = FimClass.prototype.stream;
        originalMethods.set("fim.stream", originalStream);

        const tracer = this.tracer;
        const wrapper = fimStreamWrapper(tracer);

        FimClass.prototype.stream = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalStream.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;
          return wrapper(
            (...a: unknown[]) => original(...a),
            this,
            args,
            kwargs
          );
        };
        didPatch = true;
      }

      return didPatch;
    } catch (error) {
      console.error("Failed to instrument MistralAI FIM:", error);
      return false;
    }
  }

  private _instrumentAgents(): boolean {
    if (!this.tracer) return false;

    try {
      const agentsModule = require("@mistralai/mistralai/sdk/agents");
      const AgentsClass = agentsModule.Agents;
      let didPatch = false;

      if (AgentsClass?.prototype?.complete) {
        const originalComplete = AgentsClass.prototype.complete;
        originalMethods.set("agents.complete", originalComplete);

        const tracer = this.tracer;
        const wrapper = agentsWrapper(tracer);

        AgentsClass.prototype.complete = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalComplete.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;
          return wrapper(
            (...a: unknown[]) => original(...a),
            this,
            args,
            kwargs
          );
        };
        didPatch = true;
      }

      if (AgentsClass?.prototype?.stream) {
        const originalStream = AgentsClass.prototype.stream;
        originalMethods.set("agents.stream", originalStream);

        const tracer = this.tracer;
        const wrapper = agentsStreamWrapper(tracer);

        AgentsClass.prototype.stream = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalStream.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;
          return wrapper(
            (...a: unknown[]) => original(...a),
            this,
            args,
            kwargs
          );
        };
        didPatch = true;
      }

      return didPatch;
    } catch (error) {
      console.error("Failed to instrument MistralAI agents:", error);
      return false;
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
  agentsStreamWrapper,
  agentsWrapper,
  AsyncStreamingWrapper,
  chatStreamWrapper,
  chatWrapper,
  embeddingsWrapper,
  fimStreamWrapper,
  fimWrapper,
  StreamingWrapper,
} from "./wrappers";

// Re-export utilities
export {
  modelAsDict,
  setRequestAttributes,
  setResponseAttributes,
  shouldSuppressInstrumentation,
} from "./utils";

export { __version__ } from "./version";
