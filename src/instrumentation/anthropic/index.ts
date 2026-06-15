import { createRequire } from "module";
import { SpanKind, trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { Logger } from "../../logger";
import { setRequestAttributes } from "./utils";
import { __version__ } from "./version";
import { batchesWrapper, betaWrapper, chatWrapper, MessageStreamWrapper } from "./wrappers";

const INSTRUMENTATION_NAME = "netra.instrumentation.anthropic";
const INSTRUMENTS = ["anthropic >= 0.71.2"];

const originalMethods: Map<string, Function> = new Map();
let isInstrumented = false;
let anthropicClasses: any[] = [];


export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Resolve the Anthropic module from the application's context.
 * Tries ESM dynamic import first, then falls back to CJS require so the
 * instrumentor works in both ESM and CommonJS projects.
 */
async function resolveAnthropicAsync(): Promise<any[]> {
  if (anthropicClasses.length > 0) return anthropicClasses;

  try {
    // @ts-ignore - @anthropic-ai/sdk is an optional peer dependency
    const anthropicModule = await import("@anthropic-ai/sdk");
    anthropicClasses.push(anthropicModule.Anthropic || anthropicModule.default || anthropicModule);
  } catch {
    Logger.warn("Failed to resolve Anthropic ESM module");
  }

  try {
    const req = createRequire(import.meta.url);
    const mod = req("@anthropic-ai/sdk");
    const cjsClass = mod.Anthropic || mod.default || mod;
    if (!anthropicClasses.includes(cjsClass)) {
      anthropicClasses.push(cjsClass);
    }
  } catch {
    Logger.warn("Failed to resolve Anthropic CJS module");
  }

  return anthropicClasses;
}

function resolveAnthropic(): any[] {
  return anthropicClasses;
}


export class NetraAnthropicInstrumentor {
    private tracer: Tracer | null = null;
    private tracerProvider?: TracerProvider;

    constructor() {}
      instrumentationDependencies(): string[] {
        return INSTRUMENTS;
      }

      async instrumentAsync(options: InstrumentorOptions = {}): Promise<NetraAnthropicInstrumentor> {
        if (isInstrumented) {
          Logger.warn("Anthropic is already instrumented");
          return this;
        }

        const classes = await resolveAnthropicAsync();
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

    classes.forEach((AnthropicSDK, index) => {
      this._instrumentMessages(AnthropicSDK, index);
      this._instrumentBetaMessages(AnthropicSDK, index);
      this._instrumentBatchMessages(AnthropicSDK, index);
    });

    isInstrumented = true;
    return this;
  }

    uninstrument(): void{
        if (!isInstrumented) {
        Logger.warn("Anthropic is not instrumented");
        return;
        }

    const classes = resolveAnthropic();
    classes.forEach((AnthropicSDK, index) => {
      this._uninstrumentMessages(AnthropicSDK, index);
      this._uninstrumentBetaMessages(AnthropicSDK, index);
      this._uninstrumentBatchMessages(AnthropicSDK, index);
    });

    originalMethods.clear();
    anthropicClasses = [];
    isInstrumented = false;
  }

  isInstrumented(): boolean {
    return isInstrumented;
  }

private _instrumentMessages(AnthropicSDK: any, index: number): void {
  if (!this.tracer) {
    Logger.warn("Anthropic instrumentation: No tracer available");
    return;
  }
  try {
    const MessagesClass = AnthropicSDK.Messages;
    if (!MessagesClass) {
      Logger.error(
        "Anthropic instrumentation: Could not find Anthropic Messages class to instrument",
      );
      return;
    }

    if (MessagesClass?.prototype?.stream) {
      const originalStream = MessagesClass.prototype.stream as Function;
      originalMethods.set(`messages.stream-${index}`, originalStream);
      const tracer = this.tracer;
      MessagesClass.prototype.stream = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        const original = originalStream.bind(this);
        const kwargs = (args[0] || {}) as Record<string, unknown>;

        const span = tracer.startSpan("anthropic" + ".stream", {
          kind: SpanKind.CLIENT,
          attributes: {
            "llm.request.type": "chat",
            "llm.streaming": true,
            "llm.operation": "stream"
          },
        });

        setRequestAttributes(span, kwargs, "chat");
        const startTime = Date.now();

        const instrumentedCreate = (this as any).create;
        const originalCreate = originalMethods.get(`messages.create-${index}`);
        if (originalCreate) {
          (this as any).create = originalCreate;
        }

        try {
          const messageStream = original(...args);
          return new MessageStreamWrapper(span, messageStream, startTime, kwargs);
        } finally {
          if (originalCreate) {
            (this as any).create = instrumentedCreate;
          }
        }
      } as typeof MessagesClass.prototype.stream;
    }

    if (MessagesClass?.prototype?.create) {
      const originalCreate = MessagesClass.prototype.create as Function;
      originalMethods.set(`messages.create-${index}`, originalCreate);
      const tracer = this.tracer;
      const wrapper = chatWrapper(tracer);

      MessagesClass.prototype.create = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        const original = originalCreate.bind(this);
        const kwargs = (args[0] || {}) as Record<string, unknown>;
        
        return wrapper(
          (...a: unknown[]) => original(...a),
          this,
          args,
          kwargs,
        );
      } as typeof MessagesClass.prototype.create;
    }
  } catch (error) {
    Logger.error(`Failed to instrument messages: ${error}`);
  }
}

private _instrumentBetaMessages(AnthropicSDK: any, index: number): void {
  if (!this.tracer) {
    Logger.warn("Anthropic instrumentation: No tracer available");
    return;
  }
  try {
    const BetaMessagesClass = AnthropicSDK.Beta?.Messages;
    if (!BetaMessagesClass) {
      Logger.error(
        "Anthropic instrumentation: Could not find Anthropic Beta Messages class to instrument",
      );
      return;
    }

    if (BetaMessagesClass?.prototype?.create) {
      const originalCreate = BetaMessagesClass.prototype.create as Function;
      originalMethods.set(`beta.messages.create-${index}`, originalCreate);
      const tracer = this.tracer;
      const wrapper = betaWrapper(tracer);

      BetaMessagesClass.prototype.create = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        const original = originalCreate.bind(this);
        const kwargs = (args[0] || {}) as Record<string, unknown>;
        
        return wrapper(
          (...a: unknown[]) => original(...a),
          this,
          args,
          kwargs,
        );
      } as typeof BetaMessagesClass.prototype.create;
    }
  } catch (error) {
    Logger.error(`Failed to instrument beta: ${error}`);
  }
}

private _instrumentBatchMessages(AnthropicSDK: any, index: number):void {
  if (!this.tracer) {
    Logger.warn("Anthropic instrumentation: No tracer available");
    return;
  }
  try {
    const BatchMessageClass = AnthropicSDK.Messages?.Batches;
    if (!BatchMessageClass) {
      Logger.error(
        "Anthropic instrumentation: Could not find Anthropic Batches class to instrument",
      );
      return;
    }

    if (BatchMessageClass?.prototype?.create) {
      const originalCreate = BatchMessageClass.prototype.create as Function;
      originalMethods.set(`batch.messages.create-${index}`, originalCreate);
      const tracer = this.tracer;
      const wrapper = batchesWrapper(tracer);

      BatchMessageClass.prototype.create = function (
        this: unknown,
        ...args: unknown[]
      ): unknown {
        const original = originalCreate.bind(this);
        const kwargs = (args[0] || {}) as Record<string, unknown>;
        
        return wrapper(
          (...a: unknown[]) => original(...a),
          this,
          args,
          kwargs,
        );
      } as typeof BatchMessageClass.prototype.create;
    }
  } catch (error) {
    Logger.error(`Failed to instrument batches: ${error}`);
  }
}
  private _uninstrumentMessages(AnthropicSDK: any, index: number): void {
    try {
      const MessagesClass = AnthropicSDK.Messages;

      const originalCreate = originalMethods.get(`messages.create-${index}`);
      if (originalCreate && MessagesClass?.prototype) {
        MessagesClass.prototype.create =
          originalCreate as typeof MessagesClass.prototype.create;
      }

      const originalStream = originalMethods.get(`messages.stream-${index}`);
      if (originalStream && MessagesClass?.prototype) {
        MessagesClass.prototype.stream =
          originalStream as typeof MessagesClass.prototype.stream;
      }
    } catch (error) {
      Logger.error(`Failed to uninstrument messages: ${error}`);
    }
  }
  private _uninstrumentBetaMessages(AnthropicSDK: any, index: number): void {
    try {
      const BetaMessagesClass = AnthropicSDK.Beta?.Messages;

      const originalCreate = originalMethods.get(`beta.messages.create-${index}`);
      if (originalCreate && BetaMessagesClass?.prototype) {
        BetaMessagesClass.prototype.create =
          originalCreate as typeof BetaMessagesClass.prototype.create;
      }
    } catch (error) {
      Logger.error(`Failed to uninstrument beta: ${error}`);
    }
  }
  private _uninstrumentBatchMessages(AnthropicSDK: any, index: number): void {
    try {
      const BatchMessagesClass = AnthropicSDK.Messages?.Batches;

      const originalCreate = originalMethods.get(`batch.messages.create-${index}`);
      if (originalCreate && BatchMessagesClass?.prototype) {
        BatchMessagesClass.prototype.create =
          originalCreate as typeof BatchMessagesClass.prototype.create;
      }
    } catch (error) {
      Logger.error(`Failed to uninstrument batches: ${error}`);
    }
  }
}

export const anthropicInstrumentor = new NetraAnthropicInstrumentor();

export { AsyncStreamingWrapper, chatWrapper } from "./wrappers";

export { setRequestAttributes, setResponseAttributes } from "./utils";

export { __version__ } from "./version";
