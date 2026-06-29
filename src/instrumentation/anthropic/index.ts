import { createRequire } from "module";
import { context, SpanKind, SpanStatusCode, trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { Logger } from "../../logger";
import { setRequestAttributes, wrapRunnableTools } from "./utils";
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

  uninstrument(): void {
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

          const currentContext = context.active();

          const span = tracer.startSpan("anthropic.stream", {
              kind: SpanKind.CLIENT,
              attributes: {
                "llm.request.type": "chat",
                "llm.streaming": true,
                "llm.operation": "stream"
              },
            }, currentContext);

          const spanContext = trace.setSpan(currentContext, span);

          setRequestAttributes(span, kwargs, "chat");
          const startTime = Date.now();

          const originalCreate = originalMethods.get(`messages.create-${index}`);
          if (originalCreate) {
            (this as any).create = originalCreate;
          }

          try {
            const messageStream = context.with(spanContext, () => original(...args));
            return new MessageStreamWrapper(
              span,
              messageStream,
              startTime,
              kwargs,
              spanContext,
              currentContext,
            );
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
            span.recordException(error as Error);
            span.end();
            throw error;
          } finally {
            if (originalCreate) {
              delete (this as any).create;
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

      if (BetaMessagesClass?.prototype?.stream) {
        const originalStream = BetaMessagesClass.prototype.stream as Function;
        originalMethods.set(`beta.messages.stream-${index}`, originalStream);
        const tracer = this.tracer;
        BetaMessagesClass.prototype.stream = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalStream.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;

          const currentContext = context.active();

          const span = tracer.startSpan("anthropic.beta.stream", {
            kind: SpanKind.CLIENT,
            attributes: {
              "llm.request.type": "beta",
              "llm.streaming": true,
              "llm.operation": "stream",
            },
          }, currentContext);

          const spanContext = trace.setSpan(currentContext, span);

          setRequestAttributes(span, kwargs, "beta");

          const startTime = Date.now();
          const originalCreate = originalMethods.get(`beta.messages.create-${index}`);
          if (originalCreate) {
            (this as any).create = originalCreate;
          }

          try {
            const messageStream = context.with(spanContext, () => original(...args));
            return new MessageStreamWrapper(
              span,
              messageStream,
              startTime,
              kwargs,
              spanContext,
              currentContext,
            );
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
            span.recordException(error as Error);
            span.end();
            throw error;
          } finally {
            if (originalCreate) {
              delete (this as any).create;
            }
          }
        } as typeof BetaMessagesClass.prototype.stream;
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

      if (BetaMessagesClass?.prototype?.toolRunner) {
        const originalToolRunner = BetaMessagesClass.prototype.toolRunner as Function;
        originalMethods.set(`beta.messages.toolRunner-${index}`, originalToolRunner);
        const tracer = this.tracer;

        BetaMessagesClass.prototype.toolRunner = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const original = originalToolRunner.bind(this);
          const kwargs = (args[0] || {}) as Record<string, unknown>;
          const currentContext = context.active();

          const span = tracer.startSpan("anthropic.toolRunner", {
            kind: SpanKind.CLIENT,
            attributes: {
              "llm.request.type": "beta",
              "netra.span.type": "AGENT",
              "llm.operation": "toolRunner",
            },
          }, currentContext);

          let spanEnded = false;
          const endSpanOnce = (code: SpanStatusCode, error?: Error) => {
            if (spanEnded) return;
            spanEnded = true;
            if (error) {
              span.setStatus({ code, message: error.message });
              span.recordException(error);
            } else {
              span.setStatus({ code });
            }
            span.end();
          };

          let runner: any;
          try {
            setRequestAttributes(span, kwargs, "beta");

            const spanContext = trace.setSpan(currentContext, span);

            const wrappedTools = Array.isArray(kwargs.tools)
              ? wrapRunnableTools(kwargs.tools as any[], tracer, spanContext)
              : kwargs.tools;

            const wrappedArgs = [{ ...kwargs, tools: wrappedTools }, ...args.slice(1)];

            runner = context.with(spanContext, () => original(...wrappedArgs));

            if (runner == null || typeof runner[Symbol.asyncIterator] !== "function") {
              if (runner != null && typeof runner.then === "function") {
                return (runner as Promise<any>)
                  .then((v: any) => { endSpanOnce(SpanStatusCode.OK); return v; })
                  .catch((e: any) => {
                    endSpanOnce(SpanStatusCode.ERROR, e instanceof Error ? e : new Error(String(e)));
                    throw e;
                  });
              }
              endSpanOnce(SpanStatusCode.OK);
              return runner;
            }

            const originalIterator = runner[Symbol.asyncIterator]();

            const wrappedIterator: AsyncIterableIterator<unknown> = {
              [Symbol.asyncIterator]() { return this; },
              async next() {
                try {
                  const result = await context.with(spanContext, () => originalIterator.next());
                  if (result.done) {
                    endSpanOnce(SpanStatusCode.OK);
                  }
                  return result;
                } catch (error) {
                  endSpanOnce(SpanStatusCode.ERROR, error as Error);
                  throw error;
                }
              },
              async return(value?: any) {
                endSpanOnce(SpanStatusCode.OK);
                return originalIterator.return?.(value) ?? { done: true, value };
              },
              async throw(error?: any) {
                endSpanOnce(SpanStatusCode.ERROR, error);
                if (originalIterator.throw) return originalIterator.throw(error);
                throw error;
              },
            };

            if (typeof runner.then === "function") {
              const wrappedThen = (onFulfilled?: Function, onRejected?: Function) => {
                return runner.then(
                  onFulfilled ? (v: any) => { endSpanOnce(SpanStatusCode.OK); return onFulfilled(v); } : (v: any) => { endSpanOnce(SpanStatusCode.OK); return v; },
                  onRejected ? (e: any) => { endSpanOnce(SpanStatusCode.ERROR, e instanceof Error ? e : new Error(String(e))); return onRejected(e); } : (e: any) => { endSpanOnce(SpanStatusCode.ERROR, e instanceof Error ? e : new Error(String(e))); throw e; },
                );
              };
              return Object.assign(wrappedIterator, {
                then: wrappedThen,
                catch: (onRejected?: Function) => wrappedThen(undefined, onRejected),
              });
            }

            return wrappedIterator;
          } catch (error) {
            endSpanOnce(SpanStatusCode.ERROR, error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
        } as typeof BetaMessagesClass.prototype.toolRunner;
      }
    } catch (error) {
      Logger.error(`Failed to instrument beta: ${error}`);
    }
  }

  private _instrumentBatchMessages(AnthropicSDK: any, index: number): void {
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

      const originalStream = originalMethods.get(`beta.messages.stream-${index}`);
      if (originalStream && BetaMessagesClass?.prototype) {
        BetaMessagesClass.prototype.stream =
          originalStream as typeof BetaMessagesClass.prototype.stream;
      }

      const originalToolRunner = originalMethods.get(`beta.messages.toolRunner-${index}`);
      if (originalToolRunner && BetaMessagesClass?.prototype) {
        BetaMessagesClass.prototype.toolRunner =
          originalToolRunner as typeof BetaMessagesClass.prototype.toolRunner;
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

export { chatWrapper } from "./wrappers";

export { setRequestAttributes, setResponseAttributes } from "./utils";

export { __version__ } from "./version";
