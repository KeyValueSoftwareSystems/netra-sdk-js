import { createRequire } from "module";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import shimmer from "shimmer";
import { Logger } from "../../logger";
import { SPAN_NAMES, InstrumentorOptions } from "./types";
import { __version__ } from "./version";
import {
  batchesWrapper,
  betaWrapper,
  chatWrapper,
  streamWrapper,
  toolRunnerWrapper,
} from "./wrappers";

const INSTRUMENTATION_NAME = "netra.instrumentation.anthropic";
const INSTRUMENTS = ["anthropic >= 0.71.2"];

let isInstrumented = false;
let anthropicClasses: any[] = [];

/**
 * Resolve the Anthropic module from the application's context.
 * Tries ESM dynamic import first, then falls back to CJS require.
 * Returns cached classes on subsequent calls.
 */
async function resolveAnthropic(): Promise<any[]> {
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

export class NetraAnthropicInstrumentor {
  private tracer: Tracer | null = null;
  private tracerProvider?: TracerProvider;

  constructor() {}

  instrumentationDependencies(): string[] {
    return INSTRUMENTS;
  }

  async instrument(
    options: InstrumentorOptions = {},
  ): Promise<NetraAnthropicInstrumentor> {
    if (isInstrumented) {
      Logger.warn("Anthropic is already instrumented");
      return this;
    }

    const classes = await resolveAnthropic();
    if (classes.length === 0) return this;

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

    classes.forEach((AnthropicSDK) => {
      this._instrumentMessages(AnthropicSDK);
      this._instrumentBetaMessages(AnthropicSDK);
      this._instrumentBatchMessages(AnthropicSDK);
    });

    isInstrumented = true;
    return this;
  }

  uninstrument(): void {
    if (!isInstrumented) {
      Logger.warn("Anthropic is not instrumented");
      return;
    }

    anthropicClasses.forEach((AnthropicSDK) => {
      this._uninstrumentMessages(AnthropicSDK);
      this._uninstrumentBetaMessages(AnthropicSDK);
      this._uninstrumentBatchMessages(AnthropicSDK);
    });

    anthropicClasses = [];
    isInstrumented = false;
  }

  isInstrumented(): boolean {
    return isInstrumented;
  }

  private _instrumentMessages(AnthropicSDK: any): void {
    if (!this.tracer) {
      Logger.warn("Anthropic instrumentation: No tracer available");
      return;
    }
    try {
      const MessagesClass = AnthropicSDK.Messages;
      if (!MessagesClass?.prototype) {
        Logger.error(
          "Anthropic instrumentation: Could not find Messages class",
        );
        return;
      }

      const originalCreate = MessagesClass.prototype.create;

      if (typeof MessagesClass.prototype.create === "function") {
        shimmer.wrap(
          MessagesClass.prototype,
          "create",
          chatWrapper(this.tracer),
        );
      }

      if (typeof MessagesClass.prototype.stream === "function") {
        shimmer.wrap(
          MessagesClass.prototype,
          "stream",
          streamWrapper(this.tracer, SPAN_NAMES.STREAM, "chat", originalCreate),
        );
      }
    } catch (error) {
      Logger.error(`Failed to instrument messages: ${error}`);
    }
  }

  private _instrumentBetaMessages(AnthropicSDK: any): void {
    if (!this.tracer) {
      Logger.warn("Anthropic instrumentation: No tracer available");
      return;
    }
    try {
      const BetaMessagesClass = AnthropicSDK.Beta?.Messages;
      if (!BetaMessagesClass?.prototype) {
        Logger.error(
          "Anthropic instrumentation: Could not find Beta Messages class",
        );
        return;
      }

      const originalCreate = BetaMessagesClass.prototype.create;

      if (typeof BetaMessagesClass.prototype.create === "function") {
        shimmer.wrap(
          BetaMessagesClass.prototype,
          "create",
          betaWrapper(this.tracer),
        );
      }

      if (typeof BetaMessagesClass.prototype.stream === "function") {
        shimmer.wrap(
          BetaMessagesClass.prototype,
          "stream",
          streamWrapper(
            this.tracer,
            SPAN_NAMES.BETA_STREAM,
            "beta",
            originalCreate,
          ),
        );
      }

      if (typeof BetaMessagesClass.prototype.toolRunner === "function") {
        shimmer.wrap(
          BetaMessagesClass.prototype,
          "toolRunner",
          toolRunnerWrapper(this.tracer),
        );
      }
    } catch (error) {
      Logger.error(`Failed to instrument beta: ${error}`);
    }
  }

  private _instrumentBatchMessages(AnthropicSDK: any): void {
    if (!this.tracer) {
      Logger.warn("Anthropic instrumentation: No tracer available");
      return;
    }
    try {
      const BatchMessageClass = AnthropicSDK.Messages?.Batches;
      if (!BatchMessageClass?.prototype) {
        Logger.error("Anthropic instrumentation: Could not find Batches class");
        return;
      }

      if (typeof BatchMessageClass.prototype.create === "function") {
        shimmer.wrap(
          BatchMessageClass.prototype,
          "create",
          batchesWrapper(this.tracer),
        );
      }
    } catch (error) {
      Logger.error(`Failed to instrument batches: ${error}`);
    }
  }

  private _uninstrumentMessages(AnthropicSDK: any): void {
    try {
      const proto = AnthropicSDK.Messages?.prototype;
      if (!proto) return;

      if (typeof proto.create === "function") shimmer.unwrap(proto, "create");
      if (typeof proto.stream === "function") shimmer.unwrap(proto, "stream");
    } catch (error) {
      Logger.error(`Failed to uninstrument messages: ${error}`);
    }
  }

  private _uninstrumentBetaMessages(AnthropicSDK: any): void {
    try {
      const proto = AnthropicSDK.Beta?.Messages?.prototype;
      if (!proto) return;

      if (typeof proto.create === "function") shimmer.unwrap(proto, "create");
      if (typeof proto.stream === "function") shimmer.unwrap(proto, "stream");
      if (typeof proto.toolRunner === "function")
        shimmer.unwrap(proto, "toolRunner");
    } catch (error) {
      Logger.error(`Failed to uninstrument beta: ${error}`);
    }
  }

  private _uninstrumentBatchMessages(AnthropicSDK: any): void {
    try {
      const proto = AnthropicSDK.Messages?.Batches?.prototype;
      if (!proto) return;

      if (typeof proto.create === "function") shimmer.unwrap(proto, "create");
    } catch (error) {
      Logger.error(`Failed to uninstrument batches: ${error}`);
    }
  }
}

export const anthropicInstrumentor = new NetraAnthropicInstrumentor();

export { chatWrapper } from "./wrappers";
export { setRequestAttributes, setResponseAttributes } from "./utils";
export { __version__ } from "./version";
export type { InstrumentorOptions } from "./types";
