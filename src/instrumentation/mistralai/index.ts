/**
 * Custom MistralAI instrumentor for Netra SDK
 *
 * Note: '@mistralai/mistralai' is a peer dependency. The SDK dynamically imports it
 * to ensure we patch the same module instance the application uses.
 */

import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { Logger } from "../../logger";
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

const INSTRUMENTATION_NAME = "netra.instrumentation.mistral_ai";
const INSTRUMENTS = ["@mistralai/mistralai >= 1.0.0"];

// Store original methods for uninstrumentation
const originalMethods: Map<string, Function> = new Map();

// Track instrumentation state
let isInstrumented = false;

// Cache the resolved Mistral class
let MistralClass: any = null;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

type MistralResourceName = "chat" | "embeddings" | "fim" | "agents";

/**
 * Dynamically resolve the Mistral module from the application's context.
 * This ensures we patch the same module instance that the application uses.
 *
 * IMPORTANT: We use dynamic import() to ensure we get the same ES module
 * instance that the application uses. Using require() would give us a
 * different instance due to ESM/CJS dual package handling in Node.js.
 */
async function resolveMistralAsync(): Promise<any> {
  if (MistralClass) return MistralClass;

  try {
    // Use dynamic import to get the same ES module instance
    // @ts-ignore - @mistralai/mistralai is an optional peer dependency
    const mistralModule = await import("@mistralai/mistralai");
    MistralClass =
      mistralModule.Mistral || mistralModule.default || mistralModule;
    return MistralClass;
  } catch {
    // Package not installed - this is fine, it's optional
    return null;
  }
}

/**
 * Synchronous version that returns cached class or null.
 * Must call resolveMistralAsync() first to populate cache.
 */
function resolveMistral(): any {
  return MistralClass;
}

/**
 * Custom MistralAI instrumentor for Netra SDK
 */
export class NetraMistralAIInstrumentor {
  private tracer: Tracer | null = null;
  private tracerProvider?: TracerProvider;
  private resourceCtors: Partial<Record<MistralResourceName, any>> = {};

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
   * Instrument MistralAI client methods (async version)
   * Uses dynamic import() to ensure we get the same ES module instance
   * that the application uses.
   */
  async instrumentAsync(
    options: InstrumentorOptions = {}
  ): Promise<NetraMistralAIInstrumentor> {
    if (isInstrumented) {
      Logger.warn("MistralAI is already instrumented");
      return this;
    }

    // Resolve Mistral from application context using dynamic import
    const Mistral = await resolveMistralAsync();
    if (!Mistral) {
      // @mistralai/mistralai package not installed - skip silently (it's optional)
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
      Logger.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    // Instrument client methods. Mark instrumented only if we actually patched anything.
    const patchedChat = this._instrumentChat(Mistral);
    const patchedEmbeddings = this._instrumentEmbeddings(Mistral);
    const patchedFIM = this._instrumentFIM(Mistral);
    const patchedAgents = this._instrumentAgents(Mistral);
    const didPatch =
      patchedChat || patchedEmbeddings || patchedFIM || patchedAgents;

    if (!didPatch) {
      Logger.warn(
        "MistralAI instrumentation initialized but no methods were patched. Is '@mistralai/mistralai' installed and compatible?"
      );
      return this;
    }

    isInstrumented = true;
    return this;
  }

  /**
   * Instrument MistralAI client methods (sync version - for backwards compatibility)
   * Note: This uses a cached Mistral class. Call instrumentAsync() for proper initialization.
   */
  instrument(options: InstrumentorOptions = {}): NetraMistralAIInstrumentor {
    if (isInstrumented) {
      Logger.warn("MistralAI is already instrumented");
      return this;
    }

    // Try to get cached Mistral class (must have called instrumentAsync first)
    const Mistral = resolveMistral();
    if (!Mistral) {
      // Fall back to async initialization
      this.instrumentAsync(options).catch((e) => {
        Logger.error("Failed to instrument MistralAI:", e);
      });
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
      Logger.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    // Instrument client methods. Mark instrumented only if we actually patched anything.
    const patchedChat = this._instrumentChat(Mistral);
    const patchedEmbeddings = this._instrumentEmbeddings(Mistral);
    const patchedFIM = this._instrumentFIM(Mistral);
    const patchedAgents = this._instrumentAgents(Mistral);
    const didPatch =
      patchedChat || patchedEmbeddings || patchedFIM || patchedAgents;

    if (!didPatch) {
      Logger.warn(
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
      Logger.warn("MistralAI is not instrumented");
      return;
    }

    const Mistral = resolveMistral();
    if (Mistral) {
      this._uninstrumentChat(Mistral);
      this._uninstrumentEmbeddings(Mistral);
      this._uninstrumentFIM(Mistral);
      this._uninstrumentAgents(Mistral);
    }

    originalMethods.clear();
    MistralClass = null;
    isInstrumented = false;
  }

  /**
   * Check if MistralAI is currently instrumented
   */
  isInstrumented(): boolean {
    return isInstrumented;
  }

  /**
   * Resolve public resource constructors from the exported Mistral client.
   * This avoids relying on internal "@mistralai/mistralai/sdk/*" paths.
   *
   * We create a temporary client instance purely for discovery; it should not
   * make network calls.
   */
  private _ensureResourceCtors(Mistral: any): void {
    if (
      this.resourceCtors.chat &&
      this.resourceCtors.embeddings &&
      this.resourceCtors.fim &&
      this.resourceCtors.agents
    ) {
      return;
    }

    // Some SDK versions require an apiKey at construction time.
    // Use a dummy if none is provided; this is only for discovering constructors.
    const apiKey = process.env.MISTRAL_API_KEY ?? "netra_dummy_api_key";

    let client: any;
    try {
      client = new Mistral({ apiKey });
    } catch {
      // Fallback for alternate ctor signatures
      client = new Mistral(apiKey);
    }

    for (const name of ["chat", "embeddings", "fim", "agents"] as const) {
      const res = client?.[name];
      if (res && res.constructor) {
        this.resourceCtors[name] = res.constructor;
      }
    }
  }

  private _getCtor(Mistral: any, name: MistralResourceName): any | null {
    this._ensureResourceCtors(Mistral);
    return this.resourceCtors[name] ?? null;
  }

  private _instrumentChat(Mistral: any): boolean {
    if (!this.tracer) return false;

    try {
      const ChatClass = this._getCtor(Mistral, "chat");
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
      Logger.error("Failed to instrument MistralAI chat:", error);
      return false;
    }
  }

  private _instrumentEmbeddings(Mistral: any): boolean {
    if (!this.tracer) return false;

    try {
      const EmbeddingsClass = this._getCtor(Mistral, "embeddings");
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
      Logger.error("Failed to instrument MistralAI embeddings:", error);
      return false;
    }
  }

  private _instrumentFIM(Mistral: any): boolean {
    if (!this.tracer) return false;

    try {
      const FimClass = this._getCtor(Mistral, "fim");
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
      Logger.error("Failed to instrument MistralAI FIM:", error);
      return false;
    }
  }

  private _instrumentAgents(Mistral: any): boolean {
    if (!this.tracer) return false;

    try {
      const AgentsClass = this._getCtor(Mistral, "agents");
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
      Logger.error("Failed to instrument MistralAI agents:", error);
      return false;
    }
  }

  private _uninstrumentChat(Mistral: any): void {
    try {
      const ChatClass = this._getCtor(Mistral, "chat");

      const originalComplete = originalMethods.get("chat.complete");
      if (originalComplete && ChatClass?.prototype) {
        ChatClass.prototype.complete = originalComplete;
      }

      const originalStream = originalMethods.get("chat.stream");
      if (originalStream && ChatClass?.prototype) {
        ChatClass.prototype.stream = originalStream;
      }
    } catch (error) {
      Logger.error(`Failed to uninstrument MistralAI chat: ${error}`);
    }
  }

  private _uninstrumentEmbeddings(Mistral: any): void {
    try {
      const EmbeddingsClass = this._getCtor(Mistral, "embeddings");

      const originalCreate = originalMethods.get("embeddings.create");
      if (originalCreate && EmbeddingsClass?.prototype) {
        EmbeddingsClass.prototype.create = originalCreate;
      }
    } catch (error) {
      Logger.error(`Failed to uninstrument MistralAI embeddings: ${error}`);
    }
  }

  private _uninstrumentFIM(Mistral: any): void {
    try {
      const FimClass = this._getCtor(Mistral, "fim");

      const originalComplete = originalMethods.get("fim.complete");
      if (originalComplete && FimClass?.prototype) {
        FimClass.prototype.complete = originalComplete;
      }

      const originalStream = originalMethods.get("fim.stream");
      if (originalStream && FimClass?.prototype) {
        FimClass.prototype.stream = originalStream;
      }
    } catch (error) {
      Logger.error(`Failed to uninstrument MistralAI FIM: ${error}`);
    }
  }

  private _uninstrumentAgents(Mistral: any): void {
    try {
      const AgentsClass = this._getCtor(Mistral, "agents");

      const originalComplete = originalMethods.get("agents.complete");
      if (originalComplete && AgentsClass?.prototype) {
        AgentsClass.prototype.complete = originalComplete;
      }

      const originalStream = originalMethods.get("agents.stream");
      if (originalStream && AgentsClass?.prototype) {
        AgentsClass.prototype.stream = originalStream;
      }
    } catch (error) {
      Logger.error(`Failed to uninstrument MistralAI agents: ${error}`);
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
