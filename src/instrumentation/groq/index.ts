/**
 * Custom Groq instrumentor for Netra SDK
 *
 * Note: 'groq-sdk' is a peer dependency. The SDK dynamically imports it
 * to ensure we patch the same module instance the application uses.
 */

import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { __version__ } from "./version";
import { chatWrapper } from "./wrappers";

const INSTRUMENTATION_NAME = "netra.instrumentation.groq";
const INSTRUMENTS = ["groq-sdk >= 0.3.0"];
const originalMethods: Map<string, Function> = new Map();
let isInstrumented = false;

// Cache the resolved Groq class
let GroqClass: any = null;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Dynamically resolve the Groq module from the application's context.
 * This ensures we patch the same module instance that the application uses.
 *
 * IMPORTANT: We use dynamic import() to ensure we get the same ES module
 * instance that the application uses. Using require() would give us a
 * different instance due to ESM/CJS dual package handling in Node.js.
 */
async function resolveGroqAsync(): Promise<any> {
  if (GroqClass) return GroqClass;

  try {
    // Use dynamic import to get the same ES module instance
    // @ts-ignore - groq-sdk is an optional peer dependency
    const groqModule = await import("groq-sdk");
    GroqClass = groqModule.Groq || groqModule.default || groqModule;
    return GroqClass;
  } catch {
    // Package not installed - this is fine, it's optional
    return null;
  }
}

/**
 * Synchronous version that returns cached class or null.
 * Must call resolveGroqAsync() first to populate cache.
 */
function resolveGroq(): any {
  return GroqClass;
}

export class NetraGroqInstrumentor {
  private tracer: Tracer | null = null;
  private tracerProvider?: TracerProvider;

  constructor() {}
  instrumentationDependencies(): string[] {
    return INSTRUMENTS;
  }

  /**
   * Instrument Groq client methods (async version)
   * Uses dynamic import() to ensure we get the same ES module instance
   * that the application uses.
   */
  async instrumentAsync(
    options: InstrumentorOptions = {}
  ): Promise<NetraGroqInstrumentor> {
    if (isInstrumented) {
      console.warn("Groq is already instrumented");
      return this;
    }

    // Resolve Groq from application context using dynamic import
    const Groq = await resolveGroqAsync();
    if (!Groq) {
      // groq-sdk package not installed - skip silently (it's optional)
      return this;
    }

    try {
      this.tracerProvider = options.tracerProvider;
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

    this._instrumentChatCompletions(Groq);

    isInstrumented = true;
    return this;
  }

  /**
   * Instrument Groq client methods (sync version - for backwards compatibility)
   * Note: This uses a cached Groq class. Call instrumentAsync() for proper initialization.
   */
  instrument(options: InstrumentorOptions = {}): NetraGroqInstrumentor {
    if (isInstrumented) {
      console.warn("Groq is already instrumented");
      return this;
    }

    // Try to get cached Groq class (must have called instrumentAsync first)
    const Groq = resolveGroq();
    if (!Groq) {
      // Fall back to async initialization
      this.instrumentAsync(options).catch((e) => {
        console.error("Failed to instrument Groq:", e);
      });
      return this;
    }

    try {
      this.tracerProvider = options.tracerProvider;
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

    this._instrumentChatCompletions(Groq);

    isInstrumented = true;
    return this;
  }

  uninstrument(): void {
    if (!isInstrumented) {
      console.warn("Groq is not instrumented");
      return;
    }

    const Groq = resolveGroq();
    if (Groq) {
      this._uninstrumentChatCompletions(Groq);
    }

    originalMethods.clear();
    isInstrumented = false;
  }

  isInstrumented(): boolean {
    return isInstrumented;
  }

  private _instrumentChatCompletions(Groq: any): void {
    if (!this.tracer) {
      console.warn("Groq instrumentation: No tracer available");
      return;
    }

    try {
      const CompletionsClass = Groq.Chat?.Completions;

      if (!CompletionsClass?.prototype?.create) {
        console.error(
          "Groq instrumentation: Could not find Groq chat completions class to instrument"
        );
        return;
      }
      const originalCreate = CompletionsClass.prototype.create as Function;
      originalMethods.set("chat.completions.create", originalCreate);

      const tracer = this.tracer;
      const wrapper = chatWrapper(tracer);

      CompletionsClass.prototype.create = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        const original = originalCreate.bind(this);
        const kwargs = (args[0] || {}) as Record<string, unknown>;
        const wrappedFn = (...a: unknown[]) => original(...a);
        return wrapper(wrappedFn, this, args, kwargs);
      } as typeof CompletionsClass.prototype.create;
    } catch (error) {
      console.error(
        `Groq instrumentation: Failed to instrument chat completions: ${error}`
      );
    }
  }

  private _uninstrumentChatCompletions(Groq: any): void {
    try {
      const CompletionsClass = Groq.Chat?.Completions;

      const originalCreate = originalMethods.get("chat.completions.create");
      if (originalCreate && CompletionsClass?.prototype) {
        CompletionsClass.prototype.create =
          originalCreate as typeof CompletionsClass.prototype.create;
      }
    } catch (error) {
      console.error(`Failed to uninstrument chat completions: ${error}`);
    }
  }
}

export const groqInstrumentor = new NetraGroqInstrumentor();

export { chatWrapper } from "./wrappers";

export { setRequestAttributes, setResponseAttributes } from "./utils";

export { __version__ } from "./version";
