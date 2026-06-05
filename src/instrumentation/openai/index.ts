import { createRequire } from "module";
import { trace, Tracer } from "@opentelemetry/api";
import { Logger } from "../../logger";
import { __version__ } from "./version";
import { chatWrapper, embeddingsWrapper, responsesWrapper } from "./wrappers";
import { InstrumentorOptions, PatchTarget } from "./types";

const INSTRUMENTATION_NAME = "netra.instrumentation.openai";
const SUPPORTED_VERSIONS = ["openai >= 4.0.0"];

let openAIClasses: any[] = [];

/**
 * Resolve the OpenAI module from the application's context.
 * Tries ESM dynamic import first (same instance as the app), then falls back
 * to CJS require so the instrumentor works in both ESM and CommonJS projects.
 */
async function resolveOpenAI(): Promise<any[]> {
  if (openAIClasses.length > 0) return openAIClasses;

  try {
    // @ts-ignore - openai is an optional peer dependency
    const mod = await import("openai");
    openAIClasses.push(mod.OpenAI ?? mod.default ?? mod);
  } catch {
    Logger.warn("Failed to resolve OpenAI ESM module");
  }

  try {
    const req = createRequire(import.meta.url);
    const mod = req("openai");
    const cjsClass = mod.OpenAI ?? mod.default ?? mod;
    // Only add if it resolves to a different class identity than what ESM gave us.
    // In bundler / dual-package setups the two could resolve to the same object,
    // and patching the same prototype twice would wrap methods redundantly.
    if (!openAIClasses.includes(cjsClass)) {
      openAIClasses.push(cjsClass);
    }
  } catch {
    Logger.warn("Failed to resolve OpenAI CJS module");
  }

  return openAIClasses;
}

const PATCH_TARGETS: PatchTarget[] = [
  {
    key: "chat.completions.create",
    getPrototype: (O) => O.Chat?.Completions?.prototype,
    wrapperFactory: chatWrapper,
  },
  {
    key: "embeddings.create",
    getPrototype: (O) => O.Embeddings?.prototype,
    wrapperFactory: embeddingsWrapper,
  },
  {
    key: "responses.create",
    getPrototype: (O) => O.Responses?.prototype,
    wrapperFactory: responsesWrapper,
    optional: true,
  },
];

export class NetraOpenAIInstrumentor {
  private tracer: Tracer | null = null;
  private static _isInstrumented = false;
  private readonly originalMethods = new Map<string, Function>();

  instrumentationDependencies(): string[] {
    return [...SUPPORTED_VERSIONS];
  }

  isInstrumented(): boolean {
    return NetraOpenAIInstrumentor._isInstrumented;
  }

  async instrument(
    options: InstrumentorOptions = {},
  ): Promise<NetraOpenAIInstrumentor> {
    if (this.isInstrumented()) {
      Logger.warn("OpenAI is already instrumented");
      return this;
    }

    try {
      const provider = options.tracerProvider;
      this.tracer = provider
        ? provider.getTracer(INSTRUMENTATION_NAME, __version__)
        : trace.getTracer(INSTRUMENTATION_NAME, __version__);
    } catch (error) {
      Logger.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    const openAIClasses = await resolveOpenAI();
    openAIClasses.forEach((openAIClass, index) => {
      PATCH_TARGETS.forEach((target) => {
        this.patch(openAIClass, target, index);
      });
    });

    NetraOpenAIInstrumentor._isInstrumented = true;
    return this;
  }

  async uninstrument(): Promise<void> {
    if (!this.isInstrumented()) {
      Logger.warn("OpenAI is not instrumented");
      return;
    }

    const openAIClasses = await resolveOpenAI();
    openAIClasses.forEach((openAIClass, index) => {
      PATCH_TARGETS.forEach((target) => {
        this.unpatch(openAIClass, target, index);
      });
    });

    this.originalMethods.clear();
    openAIClasses.length = 0;
    NetraOpenAIInstrumentor._isInstrumented = false;
  }

  private patch(openAIClass: any, target: PatchTarget, index: number): void {
    if (!this.tracer) return;

    const proto = target.getPrototype(openAIClass);
    if (!proto?.create) {
      if (!target.optional) {
        Logger.error(`Failed to find OpenAI method to patch: ${target.key}`);
      }
      return;
    }

    try {
      const original = proto.create as Function;
      this.originalMethods.set(`${target.key}-${index}`, original);
      const wrapper = target.wrapperFactory(this.tracer);

      proto.create = function (this: unknown, ...args: unknown[]): unknown {
        const kwargs = (args[0] ?? {}) as Record<string, unknown>;
        return wrapper(
          (...a: unknown[]) => (original as any).call(this, ...a),
          this,
          args,
          kwargs,
        );
      };
    } catch (error) {
      Logger.error(`Failed to patch ${target.key}: ${error}`);
    }
  }

  private unpatch(openAIClass: any, target: PatchTarget, index: number): void {
    try {
      const proto = target.getPrototype(openAIClass);
      const original = this.originalMethods.get(`${target.key}-${index}`);
      if (proto && original) {
        proto.create = original;
      }
    } catch (error) {
      Logger.error(`Failed to unpatch ${target.key}: ${error}`);
    }
  }
}

export const openAIInstrumentor = new NetraOpenAIInstrumentor();

export {
  AsyncStreamingWrapper,
  chatWrapper,
  embeddingsWrapper,
  responsesWrapper,
  StreamingWrapper,
} from "./wrappers";

export {
  setRequestAttributes,
  setResponseAttributes,
} from "./utils";

export { __version__ } from "./version";
