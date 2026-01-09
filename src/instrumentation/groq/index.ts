import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { createRequire } from "module";
import { __version__ } from "./version";
import {
  chatWrapper,
} from "./wrappers";

const require = createRequire(import.meta.url);

const INSTRUMENTATION_NAME = "netra.instrumentation.groq";
const INSTRUMENTS = ["groq-sdk >= 0.0.1"];
const originalMethods: Map<string, Function> = new Map();
let isInstrumented = false;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

export class NetraGroqInstrumentor {
  private tracer: Tracer | null = null;
  private tracerProvider?: TracerProvider;

  constructor() {
  }
  instrumentationDependencies(): string[] {
    return INSTRUMENTS;
  }

  instrument(options: InstrumentorOptions = {}): NetraGroqInstrumentor {
    if (isInstrumented) {
      console.warn("Groq is already instrumented");
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

    this._instrumentChatCompletions();

    isInstrumented = true;
    return this;
  }

  uninstrument(): void {
    if (!isInstrumented) {
      console.warn("Groq is not instrumented");
      return;
    }

    this._uninstrumentChatCompletions();

    originalMethods.clear();
    isInstrumented = false;
  }

  isInstrumented(): boolean {
    return isInstrumented;
  }

  private _instrumentChatCompletions(): void {
    if (!this.tracer) {
      console.warn("Groq instrumentation: No tracer available");
      return;
    }

    try {
      const chatModule = require("groq-sdk/resources/chat/completions");
      const CompletionsClass = chatModule.Completions;

      if (CompletionsClass?.prototype?.create) {
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
          const wrappedFn = (...a: unknown[]) => original(...a);
          return wrapper(wrappedFn, this, args, kwargs);
        };
      } else {
        console.error("Groq instrumentation: Could not find Groq chat completions class to instrument");
      }
    } catch (error) {
      console.error(`Groq instrumentation: Failed to instrument chat completions: ${error}`);
    }
  }

  private _uninstrumentChatCompletions(): void {
    try {
      const chatModule = require("groq-sdk/resources/chat/completions");
      const CompletionsClass = chatModule.Completions;

      const originalCreate = originalMethods.get("chat.completions.create");
      if (originalCreate && CompletionsClass?.prototype) {
        CompletionsClass.prototype.create = originalCreate;
      }
    } catch (error) {
      console.error(`Failed to uninstrument chat completions: ${error}`);
    }
  }
}

export const groqInstrumentor = new NetraGroqInstrumentor();

export {
  chatWrapper,
} from "./wrappers";

export {
  modelAsDict,
  setRequestAttributes,
  setResponseAttributes,
  shouldSuppressInstrumentation,
} from "./utils";

export { __version__ } from "./version";
