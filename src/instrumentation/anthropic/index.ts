import { SpanKind, trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { __version__ } from "./version";
import { batchesWrapper, betaWrapper, chatWrapper, MessageStreamWrapper } from "./wrappers";
import { Anthropic } from "@anthropic-ai/sdk";
import { setRequestAttributes } from "./utils";

const INSTRUMENTATION_NAME = "netra.instrumentation.anthropic";
const INSTRUMENTS = ["anthropic >= 0.71.2"];

const originalMethods: Map<string, Function> = new Map();
let isInstrumented = false;
let AnthropicClass: any = null;


export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

async function resolveAnthropicAsync(): Promise<any> {
  if (AnthropicClass) return AnthropicClass;

  try {
    const anthropicModule = await import("@anthropic-ai/sdk");
    AnthropicClass = anthropicModule.Anthropic || anthropicModule.default || anthropicModule;
    return AnthropicClass;
  } catch {
    return null;
  }
}

function resolveAnthropic(): any {
  return AnthropicClass;
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
          console.warn("Anthropic is already instrumented");
          return this;
        }

        const Anthropic = await resolveAnthropic();
        if (!Anthropic) {
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

    this._instrumentMessages();
    this._instrumentBetaMessages()
    this._instrumentBatchMessages();

    isInstrumented = true;
    return this;
  }

    uninstrument(): void{
        if (!isInstrumented) {
        console.warn("Anthropic is not instrumented");
        return;
        }

    this._uninstrumentMessages();
    this._uninstrumentBetaMessages();
    this._uninstrumentBatchMessages();

    originalMethods.clear();
    isInstrumented = false;
  }

  isInstrumented(): boolean {
    return isInstrumented;
  }

private _instrumentMessages(): void {
  if (!this.tracer) {
    console.warn("Anthropic instrumentation: No tracer available");
    return;
  }
  try {
    const MessagesClass = Anthropic.Messages;
    if (!MessagesClass) {
      console.error(
        "Anthropic instrumentation: Could not find Anthropic Messages class to instrument",
      );
      return;
    }

    if (MessagesClass?.prototype?.stream) {
      const originalStream = MessagesClass.prototype.stream as Function;
      originalMethods.set("messages.stream", originalStream);
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
        
        const messageStream = original(...args);
        
        return new MessageStreamWrapper(span, messageStream, startTime, kwargs);
      } as typeof MessagesClass.prototype.stream;
    }

    if (MessagesClass?.prototype?.create) {
      const originalCreate = MessagesClass.prototype.create as Function;
      originalMethods.set("messages.create", originalCreate);
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
    console.error(`Failed to instrument messages: ${error}`);
  }
}

private _instrumentBetaMessages(): void {
  if (!this.tracer) {
    console.warn("Anthropic instrumentation: No tracer available");
    return;
  }
  try {
    const BetaMessagesClass = Anthropic.Beta.Messages;
    if (!BetaMessagesClass) {
      console.error(
        "Anthropic instrumentation: Could not find Anthropic Beta Messages class to instrument",
      );
      return;
    }

    if (BetaMessagesClass?.prototype?.create) {
      const originalCreate = BetaMessagesClass.prototype.create as Function;
      originalMethods.set("beta.messages.create", originalCreate);
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
    console.error(`Failed to instrument beta: ${error}`);
  }
}

private _instrumentBatchMessages():void {
  if (!this.tracer) {
    console.warn("Anthropic instrumentation: No tracer available");
    return;
  }
  try {
    const BatchMessageClass = Anthropic.Messages.Batches;
    if (!BatchMessageClass) {
      console.error(
        "Anthropic instrumentation: Could not find Anthropic Batches class to instrument",
      );
      return;
    }

    if (BatchMessageClass?.prototype?.create) {
      const originalCreate = BatchMessageClass.prototype.create as Function;
      originalMethods.set("batch.messages.create", originalCreate);
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
    console.error(`Failed to instrument batches: ${error}`);
  }
}
  private _uninstrumentMessages(): void {
    try {
      const MessagesClass = Anthropic.Messages;

      const originalCreate = originalMethods.get("messages.create");
      if (originalCreate && MessagesClass?.prototype) {
        MessagesClass.prototype.create =
          originalCreate as typeof MessagesClass.prototype.create;
      }
    } catch (error) {
      console.error(`Failed to uninstrument messages: ${error}`);
    }
  }
  private _uninstrumentBetaMessages(): void {
    try {
      const BetaMessagesClass = Anthropic.Beta.Messages;

      const originalCreate = originalMethods.get("beta.messages.create");
      if (originalCreate && BetaMessagesClass?.prototype) {
        BetaMessagesClass.prototype.create =
          originalCreate as typeof BetaMessagesClass.prototype.create;
      }
    } catch (error) {
      console.error(`Failed to uninstrument beta: ${error}`);
    }
  }
  private _uninstrumentBatchMessages(): void {
    try {
      const BatchMessagesClass = Anthropic.Messages.Batches;

      const originalCreate = originalMethods.get("batch.messages.create");
      if (originalCreate && BatchMessagesClass?.prototype) {
        BatchMessagesClass.prototype.create =
          originalCreate as typeof BatchMessagesClass.prototype.create;
      }
    } catch (error) {
      console.error(`Failed to uninstrument batches: ${error}`);
    }
  }
}

export const anthropicInstrumentor = new NetraAnthropicInstrumentor();

export { chatWrapper } from "./wrappers";

export { setRequestAttributes, setResponseAttributes } from "./utils";

export { __version__ } from "./version";
