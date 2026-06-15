/**
 * Custom Groq instrumentor for Netra SDK
 *
 * Note: 'groq-sdk' is a peer dependency. The SDK dynamically imports it
 * to ensure we patch the same module instance the application uses.
 */

import { createRequire } from "module";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { Logger } from "../../logger";
import { __version__ } from "./version";
import { chatWrapper } from "./wrappers";

const INSTRUMENTATION_NAME = "netra.instrumentation.groq";
const INSTRUMENTS = ["groq-sdk >= 0.3.0"];
const originalMethods: Map<string, Function> = new Map();
let isInstrumented = false;

// Cache all resolved Groq classes (ESM + CJS)
let groqClasses: any[] = [];

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Resolve the Groq module from the application's context.
 * Tries ESM dynamic import first, then falls back to CJS require so the
 * instrumentor works in both ESM and CommonJS projects.
 */
async function resolveGroqAsync(): Promise<any[]> {
  if (groqClasses.length > 0) return groqClasses;

  try {
    // @ts-ignore - groq-sdk is an optional peer dependency
    const groqModule = await import("groq-sdk");
    groqClasses.push(groqModule.Groq || groqModule.default || groqModule);
  } catch {
    Logger.warn("Failed to resolve Groq ESM module");
  }

  try {
    const req = createRequire(import.meta.url);
    const mod = req("groq-sdk");
    const cjsClass = mod.Groq || mod.default || mod;
    if (!groqClasses.includes(cjsClass)) {
      groqClasses.push(cjsClass);
    }
  } catch {
    Logger.warn("Failed to resolve Groq CJS module");
  }

  return groqClasses;
}

/**
 * Synchronous version that returns cached classes.
 * Must call resolveGroqAsync() first to populate cache.
 */
function resolveGroq(): any[] {
  return groqClasses;
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
   * Tries both ESM and CJS resolution to cover dual-package setups.
   */
  async instrumentAsync(
    options: InstrumentorOptions = {}
  ): Promise<NetraGroqInstrumentor> {
    if (isInstrumented) {
      Logger.warn("Groq is already instrumented");
      return this;
    }

    const classes = await resolveGroqAsync();
    if (classes.length === 0) {
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
      Logger.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    classes.forEach((Groq, index) => {
      this._instrumentChatCompletions(Groq, index);
    });

    isInstrumented = true;
    return this;
  }

  /**
   * Instrument Groq client methods (sync version - for backwards compatibility)
   * Note: This uses cached Groq classes. Call instrumentAsync() for proper initialization.
   */
  instrument(options: InstrumentorOptions = {}): NetraGroqInstrumentor {
    if (isInstrumented) {
      Logger.warn("Groq is already instrumented");
      return this;
    }

    const classes = resolveGroq();
    if (classes.length === 0) {
      this.instrumentAsync(options).catch((e) => {
        Logger.error("Failed to instrument Groq:", e);
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
      Logger.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    classes.forEach((Groq, index) => {
      this._instrumentChatCompletions(Groq, index);
    });

    isInstrumented = true;
    return this;
  }

  uninstrument(): void {
    if (!isInstrumented) {
      Logger.warn("Groq is not instrumented");
      return;
    }

    const classes = resolveGroq();
    classes.forEach((Groq, index) => {
      this._uninstrumentChatCompletions(Groq, index);
    });

    originalMethods.clear();
    groqClasses = [];
    isInstrumented = false;
  }

  isInstrumented(): boolean {
    return isInstrumented;
  }

  private _instrumentChatCompletions(Groq: any, index: number): void {
    if (!this.tracer) {
      Logger.warn("Groq instrumentation: No tracer available");
      return;
    }

    try {
      const CompletionsClass = Groq.Chat?.Completions;

      if (!CompletionsClass?.prototype?.create) {
        Logger.error(
          "Groq instrumentation: Could not find Groq chat completions class to instrument"
        );
        return;
      }
      const originalCreate = CompletionsClass.prototype.create as Function;
      originalMethods.set(`chat.completions.create-${index}`, originalCreate);

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
      Logger.error(
        `Groq instrumentation: Failed to instrument chat completions: ${error}`
      );
    }
  }

  private _uninstrumentChatCompletions(Groq: any, index: number): void {
    try {
      const CompletionsClass = Groq.Chat?.Completions;

      const originalCreate = originalMethods.get(`chat.completions.create-${index}`);
      if (originalCreate && CompletionsClass?.prototype) {
        CompletionsClass.prototype.create =
          originalCreate as typeof CompletionsClass.prototype.create;
      }
    } catch (error) {
      Logger.error(`Failed to uninstrument chat completions: ${error}`);
    }
  }
}

export const groqInstrumentor = new NetraGroqInstrumentor();

export { chatWrapper } from "./wrappers";

export { setRequestAttributes, setResponseAttributes } from "./utils";

export { __version__ } from "./version";
