import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { RunnableConfig } from "@langchain/core/runnables";
import { LanggraphWrapper } from "./wrappers";
import { __version__ } from "./version";

const INSTRUMENTATION_NAME = "netra.instrumentation.langchain";
const INSTRUMENTS = ["langgraph >= 1.1.1"];

let isInstrumented = false;
let LanggraphClass: any = null;
const originalMethods: Map<string, Function> = new Map();

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

async function resolveLanggraph(): Promise<any> {
  if (LanggraphClass) return LanggraphClass;
  try {
    const langgraphModule = await import("@langchain/langgraph");
    LanggraphClass = langgraphModule.CompiledStateGraph;
    return LanggraphClass;
  } catch {
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
      console.warn("Langgraph is already instrumented");
      return this;
    }

    const Langgraph = await resolveLanggraph();
    if (!Langgraph) {
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

    this._instrumentInvoke(Langgraph);
    isInstrumented = true;
    return this;
  }

  async uninstrument(): Promise<void> {
    if (!isInstrumented) {
      console.warn("OpenAI is not instrumented");
      return;
    }

    const Langgraph = await resolveLanggraph();
    if (Langgraph) {
      this._uninstrumentInvoke(Langgraph);
    }

    originalMethods.clear();
    isInstrumented = false;
  }

  private _instrumentInvoke(Langgraph: any): void {
    if (!this.tracer) return;

    try {
      if (!Langgraph?.prototype?.invoke) {
        console.error("Failed to find langgraph invoke function to instrument");
        return;
      }
      const originalInvoke = Langgraph.prototype.invoke;
      originalMethods.set("langgraph.graph.invoke", originalInvoke);

      const tracer = this.tracer;
      const wrapper = new LanggraphWrapper(tracer);

      Langgraph.prototype.invoke = async function (
        this: unknown,
        input: any,
        config?: RunnableConfig,
        ...rest: any[]
      ): Promise<any> {
        return await wrapper.invoke(
          originalInvoke,
          this,
          input,
          config,
          ...rest,
        );
      };
    } catch (error) {
      console.error(`Failed to instrument langgraph invoke: ${error}`);
    }
  }

  private _uninstrumentInvoke(Langgraph: any): void {
    try {
      const originalInvoke = originalMethods.get("langgraph.graph.invoke");
      if (originalInvoke && Langgraph?.prototype?.invoke) {
        Langgraph.prototype.invoke = originalInvoke;
      }
    } catch (error) {
      console.error(`Failed to uninstrument langgraph invoke: ${error}`);
    }
    return;
  }
}

export const langgraphInstrumentor = new NetraLanggraphInstrumentor();

export { __version__ } from "./version";
