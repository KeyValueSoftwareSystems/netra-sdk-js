import { RunnableConfig } from "@langchain/core/runnables";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { Logger } from "../../logger";
import { __version__ } from "./version";
import { LanggraphWrapper } from "./wrappers";

const INSTRUMENTATION_NAME = "netra.instrumentation.langchain";
const INSTRUMENTS = ["langgraph >= 1.1.1"];

let isInstrumented = false;
let LanggraphClass: any = null;
const originalMethods: Map<string, Function | object> = new Map();

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Find a module in Node's require cache by name pattern.
 * This allows us to patch the same module instance the app is using.
 */
function findModuleInCache(moduleName: string): any {
  // Try require.cache first (CommonJS)
    if (typeof require !== 'undefined' && require.cache) {
    const cache = require.cache;
    for (const key of Object.keys(cache)) {
      // Match the module name in the path, but exclude our own SDK's copy
      if (key.includes(moduleName.replace(/\//g, '/')) && !key.includes('netra-sdk')) {
        Logger.debug(`Found module in require.cache: ${key}`);
        return cache[key]?.exports;
      }
    }
    Logger.debug(
      `Module ${moduleName} not found in require.cache. Cache keys containing 'langgraph':`,
      Object.keys(cache).filter(k => k.includes('langgraph')),
    );
  }
  return null;
}

async function resolveLanggraph(): Promise<any> {
  if (LanggraphClass) return LanggraphClass;
  try {
    // First, try to find the module in require.cache (already loaded by the app)
    // This ensures we patch the same module instance the app is using
    let langgraphModule = findModuleInCache('@langchain/langgraph');

    if (langgraphModule) {
      Logger.debug("Found @langchain/langgraph in require.cache (using app's module instance)");
    } else {
      // Fallback to dynamic import if not in cache
      langgraphModule = await import("@langchain/langgraph");
      Logger.debug("Loaded @langchain/langgraph via dynamic import");
    }

    Logger.debug("LangGraph Module Exports:", Object.keys(langgraphModule));
    LanggraphClass = langgraphModule.CompiledStateGraph ?? langgraphModule.StateGraph;
    Logger.debug("Resolved LanggraphClass:", !!LanggraphClass);
    Logger.debug("LanggraphClass name:", LanggraphClass?.name);
    Logger.debug(
      "LanggraphClass.prototype keys:",
      LanggraphClass?.prototype ? Object.getOwnPropertyNames(LanggraphClass.prototype) : "no prototype",
    );
    Logger.debug("Has invoke on prototype:", !!LanggraphClass?.prototype?.invoke);
    Logger.debug("Has stream on prototype:", !!LanggraphClass?.prototype?.stream);

    // Check prototype chain to find where invoke is defined
    Logger.debug("Checking prototype chain for invoke location:");
    let proto = LanggraphClass?.prototype;
    while (proto) {
      const hasOwn = Object.getOwnPropertyNames(proto).includes('invoke');
      Logger.debug(`  ${proto.constructor?.name}: hasOwnProperty('invoke')=${hasOwn}`);
      if (hasOwn) {
        Logger.debug(`  -> invoke is defined on: ${proto.constructor?.name}`);
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }

    return LanggraphClass;
  } catch (e) {
    Logger.error("Failed to resolve LangGraph:", e);
    return null;
  }
}

export class NetraLanggraphInstrumentor {
  private tracer: Tracer | null = null;
  private tracerProvider?: TracerProvider;

  constructor() {}

  isInstrumented(): boolean {
    return isInstrumented;
  }

  instrumentationDependencies(): string[] {
    return [...INSTRUMENTS];
  }

  async instrument(
    options: InstrumentorOptions = {},
  ): Promise<NetraLanggraphInstrumentor> {
    if (isInstrumented) {
      Logger.warn("Langgraph is already instrumented");
      return this;
    }

    const Langgraph = await resolveLanggraph();
    if (!Langgraph) {
      Logger.warn("LangGraph class not found, skipping instrumentation");
      return this;
    }

    try {
      this.tracerProvider = options.tracerProvider;
      this.tracer = this.tracerProvider
        ? this.tracerProvider.getTracer(INSTRUMENTATION_NAME, __version__)
        : trace.getTracer(INSTRUMENTATION_NAME, __version__);
    } catch (error) {
      Logger.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    this._instrumentInvoke(Langgraph);
    this._instrumentStream(Langgraph);
    isInstrumented = true;
    return this;
  }

  async uninstrument(): Promise<void> {
    if (!isInstrumented) {
      Logger.warn("LangGraph is not instrumented");
      return;
    }

    const Langgraph = await resolveLanggraph();
    if (Langgraph) {
      this._uninstrumentInvoke(Langgraph);
      this._uninstrumentStream(Langgraph);
    }

    originalMethods.clear();
    isInstrumented = false;
  }

  private _instrumentInvoke(Langgraph: any): void {
    if (!this.tracer) return;

    try {
      // Find the prototype that actually owns the invoke method
      let targetProto = Langgraph?.prototype;
      while (targetProto && !Object.getOwnPropertyNames(targetProto).includes('invoke')) {
        targetProto = Object.getPrototypeOf(targetProto);
      }

      if (!targetProto?.invoke) {
        Logger.error("Failed to find langgraph invoke function to instrument");
        return;
      }

      Logger.debug(`Found invoke on prototype: ${targetProto.constructor?.name}`);

      const originalInvoke = targetProto.invoke;
      originalMethods.set("langgraph.graph.invoke", originalInvoke);
      // Store the target prototype for uninstrumentation
      originalMethods.set("langgraph.graph.invoke.proto", targetProto);

      const tracer = this.tracer;
      const wrapper = new LanggraphWrapper(tracer);

      const patchedInvoke = async function (
        this: unknown,
        input: any,
        config?: RunnableConfig,
        ...rest: any[]
      ): Promise<any> {
        Logger.debug("LangGraph invoke intercepted!");
        return await wrapper.invoke(
          originalInvoke,
          this,
          input,
          config,
          ...rest,
        );
      };
      // Add marker to identify patched method
      (patchedInvoke as any).__netra_patched = true;
      targetProto.invoke = patchedInvoke;

      Logger.debug(`Successfully instrumented LangGraph invoke method on ${targetProto.constructor?.name}`);
      Logger.debug(`Patched Pregel class identity:`, targetProto.constructor);
    } catch (error) {
      Logger.error(`Failed to instrument langgraph invoke: ${error}`);
    }
  }

  private _instrumentStream(Langgraph: any): void {
    if (!this.tracer) return;

    try {
      // Find the prototype that actually owns the stream method
      let targetProto = Langgraph?.prototype;
      while (targetProto && !Object.getOwnPropertyNames(targetProto).includes('stream')) {
        targetProto = Object.getPrototypeOf(targetProto);
      }

      if (!targetProto?.stream) {
        Logger.error("Failed to find langgraph stream function to instrument");
        return;
      }

      Logger.debug(`Found stream on prototype: ${targetProto.constructor?.name}`);

      const originalStream = targetProto.stream;
      originalMethods.set("langgraph.graph.stream", originalStream);
      // Store the target prototype for uninstrumentation
      originalMethods.set("langgraph.graph.stream.proto", targetProto);

      const tracer = this.tracer;
      const wrapper = new LanggraphWrapper(tracer);

      targetProto.stream = async function (
        this: unknown,
        input: any,
        config?: RunnableConfig,
        ...rest: any[]
      ): Promise<any> {
        Logger.debug("LangGraph stream intercepted!");
        return await wrapper.stream(
          originalStream,
          this,
          input,
          config,
          ...rest,
        );
      };

      Logger.debug(`Successfully instrumented LangGraph stream method on ${targetProto.constructor?.name}`);
    } catch (error) {
      Logger.error(`Failed to instrument langgraph stream: ${error}`);
    }
  }

  private _uninstrumentInvoke(Langgraph: any): void {
    try {
      const originalInvoke = originalMethods.get("langgraph.graph.invoke");
      const targetProto = originalMethods.get("langgraph.graph.invoke.proto") || Langgraph?.prototype;
      if (originalInvoke && targetProto?.invoke) {
        targetProto.invoke = originalInvoke;
      }
    } catch (error) {
      Logger.error(`Failed to uninstrument langgraph invoke: ${error}`);
    }
    return;
  }

  private _uninstrumentStream(Langgraph: any): void {
    try {
      const originalStream = originalMethods.get("langgraph.graph.stream");
      const targetProto = originalMethods.get("langgraph.graph.stream.proto") || Langgraph?.prototype;
      if (originalStream && targetProto?.stream) {
        targetProto.stream = originalStream;
      }
    } catch (error) {
      Logger.error(`Failed to uninstrument langgraph stream: ${error}`);
    }
    return;
  }
}

export const langgraphInstrumentor = new NetraLanggraphInstrumentor();

export { __version__ } from "./version";
