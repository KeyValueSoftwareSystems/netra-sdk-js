/**
 * Custom OpenAI instrumentor for Netra SDK
 *
 * Note: 'openai' is a peer dependency. The SDK dynamically imports it
 * to ensure we patch the same module instance the application uses.
 */

import { createRequire } from "module";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { __version__ } from "./version";
import { chatWrapper, embeddingsWrapper, responsesWrapper } from "./wrappers";

const INSTRUMENTATION_NAME = "netra.instrumentation.openai";
const INSTRUMENTS = ["openai >= 4.0.0"];

// Store original methods for uninstrumentation, keyed by "<classIdx>:<method>"
const originalMethods: Map<string, Function> = new Map();

// Track instrumentation state
let isInstrumented = false;

// Cache all resolved OpenAI classes (ESM + CJS builds of dual-package)
let OpenAIClasses: any[] = [];

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Resolve all OpenAI class instances the app may be using.
 *
 * openai@4+ ships as a dual-package (ESM: index.mjs, CJS: index.js).
 * In Node.js these are separate module instances with separate prototypes.
 * A CJS app's `require('openai')` gets index.js; our `import('openai')`
 * gets index.mjs. Patching only one leaves the other unpatched.
 *
 * We resolve both and deduplicate so ESM-only apps aren't double-patched.
 */
async function resolveOpenAIAsync(): Promise<any[]> {
  if (OpenAIClasses.length > 0) return OpenAIClasses;

  // ESM build — what import('openai') resolves to
  try {
    // @ts-ignore - openai is an optional peer dependency
    const esm = await import("openai");
    const ESMClass = esm.OpenAI ?? esm.default ?? esm;
    if (ESMClass) OpenAIClasses.push(ESMClass);
  } catch {
    // openai not installed — skip
  }

  // CJS build — what the app's require('openai') resolves to.
  // createRequire from this file's URL resolves through the same node_modules
  // tree, so require('openai') hits the same CJS cache entry as the app's own
  // require('openai') call.
  try {
    const req = createRequire(import.meta.url);
    const cjs = req("openai");
    const CJSClass = cjs.OpenAI ?? cjs.default ?? cjs;
    if (CJSClass && !OpenAIClasses.includes(CJSClass)) {
      OpenAIClasses.push(CJSClass);
    }
  } catch {
    // createRequire failed or openai CJS build absent — skip
  }

  return OpenAIClasses;
}

/**
 * Synchronous version that returns cached classes.
 * Must call resolveOpenAIAsync() first to populate cache.
 */
function resolveOpenAI(): any[] {
  return OpenAIClasses;
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

    // Resolve all OpenAI class instances (ESM + CJS builds)
    const classes = await resolveOpenAIAsync();
    if (classes.length === 0) {
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

    classes.forEach((OpenAI, idx) => {
      this._instrumentChatCompletions(OpenAI, idx);
      this._instrumentEmbeddings(OpenAI, idx);
      this._instrumentResponses(OpenAI, idx);
    });

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

    // Try to get cached OpenAI classes (must have called instrumentAsync first)
    const classes = resolveOpenAI();
    if (classes.length === 0) {
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

    classes.forEach((OpenAI, idx) => {
      this._instrumentChatCompletions(OpenAI, idx);
      this._instrumentEmbeddings(OpenAI, idx);
      this._instrumentResponses(OpenAI, idx);
    });

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

    resolveOpenAI().forEach((OpenAI, idx) => {
      this._uninstrumentChatCompletions(OpenAI, idx);
      this._uninstrumentEmbeddings(OpenAI, idx);
      this._uninstrumentResponses(OpenAI, idx);
    });

    originalMethods.clear();
    isInstrumented = false;
  }

  /**
   * Check if OpenAI is currently instrumented
   */
  isInstrumented(): boolean {
    return isInstrumented;
  }

  private _instrumentChatCompletions(OpenAI: any, classIdx: number): void {
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
      originalMethods.set(`${classIdx}:chat.completions.create`, originalCreate);

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

  private _instrumentEmbeddings(OpenAI: any, classIdx: number): void {
    if (!this.tracer) return;

    try {
      const EmbeddingsClass: any = OpenAI.Embeddings;
      if (!EmbeddingsClass?.prototype?.create) {
        console.error("Failed to find OpenAI embeddings class to instrument");
        return;
      }

      const originalCreate = EmbeddingsClass.prototype.create;
      originalMethods.set(`${classIdx}:embeddings.create`, originalCreate);

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

  private _instrumentResponses(OpenAI: any, classIdx: number): void {
    if (!this.tracer) return;

    try {
      const ResponsesClass: any = OpenAI.Responses;
      if (!ResponsesClass?.prototype?.create) {
        // Responses API may not exist in older versions - skip silently
        return;
      }

      const originalCreate = ResponsesClass.prototype.create;
      originalMethods.set(`${classIdx}:responses.create`, originalCreate);

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

  private _uninstrumentChatCompletions(OpenAI: any, classIdx: number): void {
    try {
      const CompletionsClass = OpenAI.Chat?.Completions;
      const originalCreate = originalMethods.get(`${classIdx}:chat.completions.create`);

      if (originalCreate && CompletionsClass?.prototype?.create) {
        CompletionsClass.prototype.create =
          originalCreate as typeof CompletionsClass.prototype.create;
      }
    } catch (error) {
      console.error(`Failed to uninstrument chat completions: ${error}`);
    }
    return;
  }

  private _uninstrumentEmbeddings(OpenAI: any, classIdx: number): void {
    try {
      const EmbeddingsClass = OpenAI.Embeddings;
      const originalCreate = originalMethods.get(`${classIdx}:embeddings.create`);

      if (originalCreate && EmbeddingsClass?.prototype?.create) {
        EmbeddingsClass.prototype.create =
          originalCreate as typeof EmbeddingsClass.prototype.create;
      }
    } catch (error) {
      console.error(`Failed to uninstrument embeddings: ${error}`);
    }
  }

  private _uninstrumentResponses(OpenAI: any, classIdx: number): void {
    try {
      const ResponsesClass = OpenAI.Responses;
      const originalCreate = originalMethods.get(`${classIdx}:responses.create`);

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
