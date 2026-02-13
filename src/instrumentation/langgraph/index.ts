import { RunnableConfig } from "@langchain/core/runnables";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import Module from "module";
import { __version__ } from "./version";
import { LanggraphWrapper } from "./wrappers";

const INSTRUMENTATION_NAME = "netra.instrumentation.langchain";
const INSTRUMENTS = ["langgraph >= 0.2.0"];

let isInstrumented = false;
let LanggraphClass: any = null;
const originalMethods: Map<string, Function | object> = new Map();

/** Cleanup function for the Module._load hook (if installed). */
let moduleLoadHookCleanup: (() => void) | null = null;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Find a module in Node's require cache by name pattern.
 * This allows us to patch the same module instance the app is using,
 * regardless of how pnpm/yarn/npm resolved the SDK's own peer dependency.
 */
function findModuleInCache(moduleName: string): any {
  // Try require.cache first (CommonJS)
  if (typeof require !== "undefined" && require.cache) {
    const cache = require.cache;
    for (const key of Object.keys(cache)) {
      // Match the module name in the path, but exclude our own SDK's copy
      if (
        key.includes(moduleName.replace(/\//g, "/")) &&
        !key.includes("netra-sdk")
      ) {
        if (process.env.NETRA_DEBUG_LOGS) {
          console.log(`Found module in require.cache: ${key}`);
        }
        return cache[key]?.exports;
      }
    }
    if (process.env.NETRA_DEBUG_LOGS) {
      console.log(
        `Module ${moduleName} not found in require.cache. Cache keys containing 'langgraph':`,
        Object.keys(cache).filter((k) => k.includes("langgraph")),
      );
    }
  }
  return null;
}

/**
 * Extract the LangGraph class (CompiledStateGraph or StateGraph) from
 * a resolved module and assign it to the module-level `LanggraphClass`.
 */
function extractLanggraphClass(langgraphModule: any): any {
  LanggraphClass =
    langgraphModule.CompiledStateGraph ?? langgraphModule.StateGraph;

  if (process.env.NETRA_DEBUG_LOGS) {
    console.log("LangGraph Module Exports:", Object.keys(langgraphModule));
    console.log("Resolved LanggraphClass:", !!LanggraphClass);
    console.log("LanggraphClass name:", LanggraphClass?.name);
    console.log(
      "LanggraphClass.prototype keys:",
      LanggraphClass?.prototype
        ? Object.getOwnPropertyNames(LanggraphClass.prototype)
        : "no prototype",
    );
    console.log(
      "Has invoke on prototype:",
      !!LanggraphClass?.prototype?.invoke,
    );
    console.log(
      "Has stream on prototype:",
      !!LanggraphClass?.prototype?.stream,
    );

    // Check prototype chain to find where invoke is defined
    console.log("Checking prototype chain for invoke location:");
    let proto = LanggraphClass?.prototype;
    while (proto) {
      const hasOwn = Object.getOwnPropertyNames(proto).includes("invoke");
      console.log(
        `  ${proto.constructor?.name}: hasOwnProperty('invoke')=${hasOwn}`,
      );
      if (hasOwn) {
        console.log(`  -> invoke is defined on: ${proto.constructor?.name}`);
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
  }

  return LanggraphClass;
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
      console.warn("Langgraph is already instrumented");
      return this;
    }

    // Initialize the tracer up-front so it's ready when patching happens
    // (either now or deferred via the Module._load hook).
    try {
      this.tracerProvider = options.tracerProvider;
      this.tracer = this.tracerProvider
        ? this.tracerProvider.getTracer(INSTRUMENTATION_NAME, __version__)
        : trace.getTracer(INSTRUMENTATION_NAME, __version__);
    } catch (error) {
      console.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    // ---- Strategy 1: module already in require.cache ----
    const cachedModule = findModuleInCache("@langchain/langgraph");
    if (cachedModule) {
      if (process.env.NETRA_DEBUG_LOGS) {
        console.log(
          "Found @langchain/langgraph in require.cache (using app's module instance)",
        );
      }
      const Klass = extractLanggraphClass(cachedModule);
      if (Klass) {
        this._applyPatches(Klass);
        return this;
      }
    }

    // ---- Strategy 2: deferred patching via Module._load hook ----
    // The module hasn't been loaded yet. Instead of doing
    //   await import("@langchain/langgraph")
    // which, under pnpm strict isolation, may resolve to a DIFFERENT copy
    // than what the application will actually use (different version, different
    // prototype objects), we install a Module._load hook that fires when the
    // real application code loads the module. We patch *that* exact instance.
    if (process.env.NETRA_DEBUG_LOGS) {
      console.log(
        "[Netra Debug] @langchain/langgraph not loaded yet; installing Module._load hook for deferred patching",
      );
    }

    const hasCommonJsRequire = typeof require !== "undefined";
    if (hasCommonJsRequire) {
      // Install hook first so if fallback import resolves to a different copy,
      // we can still repatch the real app copy when it is loaded later.
      this._installModuleLoadHook();

      // Best-effort fallback for runtimes where LangGraph was already loaded
      // through ESM before Netra.init(), and therefore won't appear in
      // require.cache or trigger Module._load after this point.
      const importedModule = await this._resolveViaDynamicImport();
      if (importedModule) {
        const Klass = extractLanggraphClass(importedModule);
        if (Klass) {
          this._applyPatches(Klass);
        }
      }
      return this;
    }

    // ---- Strategy 3: ESM fallback via dynamic import ----
    // In pure ESM runtimes there may be no CommonJS loader hook path.
    // Fall back to dynamic import so examples/apps running as ESM are still
    // instrumented. This may not solve every multi-copy pnpm layout, but it
    // preserves behavior for ESM-first projects.
    const importedModule = await this._resolveViaDynamicImport();
    if (importedModule) {
      const Klass = extractLanggraphClass(importedModule);
      if (Klass) {
        this._applyPatches(Klass);
      }
    }

    return this;
  }

  private async _resolveViaDynamicImport(): Promise<any | null> {
    try {
      if (process.env.NETRA_DEBUG_LOGS) {
        console.log(
          "[Netra Debug] Falling back to dynamic import for @langchain/langgraph",
        );
      }
      return await import("@langchain/langgraph");
    } catch (e) {
      if (process.env.NETRA_DEBUG_LOGS) {
        console.log(
          "[Netra Debug] Dynamic import fallback failed for @langchain/langgraph:",
          e,
        );
      }
      return null;
    }
  }

  /**
   * Apply invoke/stream patches to the resolved LangGraph class.
   * Called either eagerly (module already loaded) or deferred (via hook).
   */
  private _applyPatches(Klass: any): void {
    if (isInstrumented && Klass === LanggraphClass) return;

    this._instrumentInvoke(Klass);
    this._instrumentStream(Klass);
    isInstrumented = true;

    if (process.env.NETRA_DEBUG_LOGS) {
      console.log("[Netra] LangGraph instrumentation applied successfully");
    }
  }

  /**
   * Install a hook on Node's Module._load to intercept the moment the
   * application (or any of its transitive dependencies) loads
   * @langchain/langgraph. When it does, we grab the *actual* module
   * the app is using and patch its prototype — guaranteeing we instrument
   * the same object identity that graph.invoke() runs on at runtime.
   *
   * The hook removes itself after first successful patch.
   */
  private _installModuleLoadHook(): boolean {
    if (moduleLoadHookCleanup) return true; // already installed

    try {
      const ModuleAny = Module as any;
      if (typeof ModuleAny._load !== "function") {
        return false;
      }
      const originalLoad: Function = ModuleAny._load;
      const instrumentor = this;

      const hookedLoad = function (
        this: any,
        request: string,
        parent: any,
        isMain: boolean,
      ): any {
        const result = originalLoad.call(this, request, parent, isMain);

        // Detect @langchain/langgraph being loaded (bare import or subpath).
        // We only act on the bare specifier — subpath imports (e.g.
        // @langchain/langgraph/pregel) re-export from the main entry anyway
        // and share prototypes, so patching the main entry is sufficient.
        if (
          typeof request === "string" &&
          (request === "@langchain/langgraph" ||
            request === "@langchain/langgraph/index" ||
            request === "@langchain/langgraph/index.js" ||
            request === "@langchain/langgraph/index.cjs")
        ) {
          if (process.env.NETRA_DEBUG_LOGS) {
            console.log(
              `[Netra Debug] Module._load hook fired for "${request}"`,
            );
          }

          // Prefer the require.cache lookup (it returns the canonical exports
          // object that the app will hold a reference to), falling back to
          // the load result itself.
          const moduleExports =
            findModuleInCache("@langchain/langgraph") || result;

          const Klass = extractLanggraphClass(moduleExports);
          if (Klass) {
            instrumentor._applyPatches(Klass);
          }

          // Clean up the hook regardless of success — we don't want to
          // keep intercepting every require() call.
          removeHook();
        }

        return result;
      };

      const removeHook = () => {
        if (ModuleAny._load === hookedLoad) {
          ModuleAny._load = originalLoad;
        }
        moduleLoadHookCleanup = null;
      };

      ModuleAny._load = hookedLoad;
      moduleLoadHookCleanup = removeHook;
      return true;
    } catch (e) {
      if (process.env.NETRA_DEBUG_LOGS) {
        console.log("[Netra Debug] Failed to install Module._load hook:", e);
      }
      // If hooking fails (e.g. in a locked-down environment), fall through
      // silently — the instrumentation simply won't be active.
      return false;
    }
  }

  async uninstrument(): Promise<void> {
    // Remove the deferred hook if it's still waiting
    if (moduleLoadHookCleanup) {
      moduleLoadHookCleanup();
    }

    if (!isInstrumented) {
      console.warn("LangGraph is not instrumented");
      return;
    }

    if (LanggraphClass) {
      this._uninstrumentInvoke(LanggraphClass);
      this._uninstrumentStream(LanggraphClass);
    }

    originalMethods.clear();
    isInstrumented = false;
    LanggraphClass = null;
  }

  private _instrumentInvoke(Langgraph: any): void {
    if (!this.tracer) return;

    try {
      // Find the prototype that actually owns the invoke method
      let targetProto = Langgraph?.prototype;
      while (
        targetProto &&
        !Object.getOwnPropertyNames(targetProto).includes("invoke")
      ) {
        targetProto = Object.getPrototypeOf(targetProto);
      }

      if (!targetProto?.invoke) {
        console.error(
          "Failed to find langgraph invoke function to instrument",
        );
        return;
      }

      if (process.env.NETRA_DEBUG_LOGS) {
        console.log(
          `Found invoke on prototype: ${targetProto.constructor?.name}`,
        );
      }

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
        if (process.env.NETRA_DEBUG_LOGS) {
          console.log("[Netra Debug] LangGraph invoke intercepted!");
        }
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

      if (process.env.NETRA_DEBUG_LOGS) {
        console.log(
          `Successfully instrumented LangGraph invoke method on ${targetProto.constructor?.name}`,
        );
        console.log(`Patched Pregel class identity:`, targetProto.constructor);
      }
    } catch (error) {
      console.error(`Failed to instrument langgraph invoke: ${error}`);
    }
  }

  private _instrumentStream(Langgraph: any): void {
    if (!this.tracer) return;

    try {
      // Find the prototype that actually owns the stream method
      let targetProto = Langgraph?.prototype;
      while (
        targetProto &&
        !Object.getOwnPropertyNames(targetProto).includes("stream")
      ) {
        targetProto = Object.getPrototypeOf(targetProto);
      }

      if (!targetProto?.stream) {
        console.error(
          "Failed to find langgraph stream function to instrument",
        );
        return;
      }

      if (process.env.NETRA_DEBUG_LOGS) {
        console.log(
          `Found stream on prototype: ${targetProto.constructor?.name}`,
        );
      }

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
        if (process.env.NETRA_DEBUG_LOGS) {
          console.log("[Netra Debug] LangGraph stream intercepted!");
        }
        return await wrapper.stream(
          originalStream,
          this,
          input,
          config,
          ...rest,
        );
      };

      if (process.env.NETRA_DEBUG_LOGS) {
        console.log(
          `Successfully instrumented LangGraph stream method on ${targetProto.constructor?.name}`,
        );
      }
    } catch (error) {
      console.error(`Failed to instrument langgraph stream: ${error}`);
    }
  }

  private _uninstrumentInvoke(Langgraph: any): void {
    try {
      const originalInvoke = originalMethods.get("langgraph.graph.invoke");
      const targetProto =
        originalMethods.get("langgraph.graph.invoke.proto") ||
        Langgraph?.prototype;
      if (originalInvoke && targetProto?.invoke) {
        targetProto.invoke = originalInvoke;
      }
    } catch (error) {
      console.error(`Failed to uninstrument langgraph invoke: ${error}`);
    }
    return;
  }

  private _uninstrumentStream(Langgraph: any): void {
    try {
      const originalStream = originalMethods.get("langgraph.graph.stream");
      const targetProto =
        originalMethods.get("langgraph.graph.stream.proto") ||
        Langgraph?.prototype;
      if (originalStream && targetProto?.stream) {
        targetProto.stream = originalStream;
      }
    } catch (error) {
      console.error(`Failed to uninstrument langgraph stream: ${error}`);
    }
    return;
  }
}

export const langgraphInstrumentor = new NetraLanggraphInstrumentor();

export { __version__ } from "./version";
