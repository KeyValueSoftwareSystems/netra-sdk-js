import { RunnableConfig } from "@langchain/core/runnables";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { __version__ } from "./version";
import { LanggraphWrapper, wrapNode } from "./wrappers";

const INSTRUMENTATION_NAME = "netra.instrumentation.langgraph";
const INSTRUMENTS = ["langgraph >= 1.1.1"];

let isInstrumented = false;
let LanggraphClass: any = null;
let StateGraphClass: any = null;
const originalMethods: Map<string, Function> = new Map();

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

async function resolveLanggraph(): Promise<{
  Langgraph: any;
  StateGraph: any;
}> {
  if (LanggraphClass && StateGraphClass) {
    return { Langgraph: LanggraphClass, StateGraph: StateGraphClass };
  }
  try {
    const langgraphModule = await import("@langchain/langgraph");
    LanggraphClass = langgraphModule.CompiledStateGraph;
    StateGraphClass = langgraphModule.StateGraph;
    return { Langgraph: LanggraphClass, StateGraph: StateGraphClass };
  } catch {
    return { Langgraph: null, StateGraph: null };
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

    const { Langgraph, StateGraph } = await resolveLanggraph();
    if (!Langgraph || !StateGraph) {
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
    this._instrumentStateGraph(StateGraph);
    
    isInstrumented = true;
    return this;
  }

  async uninstrument(): Promise<void> {
    if (!isInstrumented) {
      console.warn("Langgraph is not instrumented");
      return;
    }

    const { Langgraph, StateGraph } = await resolveLanggraph();
    if (Langgraph) {
      this._uninstrumentInvoke(Langgraph);
    }
    if (StateGraph) {
      this._uninstrumentStateGraph(StateGraph);
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
      const wrapper = new LanggraphWrapper(tracer, originalInvoke);

      Langgraph.prototype.invoke = async function (
        this: unknown,
        input: any,
        config?: RunnableConfig,
        ...rest: any[]
      ): Promise<any> {
        return await wrapper.invoke(this, input, config, ...rest);
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

  private _instrumentStateGraph(StateGraph: any): void {
    if (!this.tracer) return;

    try {
      if (!StateGraph?.prototype?.addNode) {
        console.error("Failed to find StateGraph.addNode to instrument");
        return;
      }

      // cache original
      const originalAddNode = StateGraph.prototype.addNode;
      const originalAddConditionalEdges = StateGraph.prototype.addConditionalEdges;
      
      originalMethods.set("langgraph.StateGraph.addNode", originalAddNode);
      originalMethods.set("langgraph.StateGraph.addConditionalEdges", originalAddConditionalEdges);

      const tracer = this.tracer;

      StateGraph.prototype.addNode = function (
        node: string,
        action: any, // Runnable or function
        ...rest: any[]
      ) {
        // We wrap the action.
        // We call wrapNode(tracer, action, node)
        const wrappedAction = wrapNode(tracer, action, node);
        
        return originalAddNode.call(this, node, wrappedAction, ...rest);
      };

      StateGraph.prototype.addConditionalEdges = function (
        source: string,
        path: any, // Runnable or function
        ...rest: any[]
      ) {
        // The path condition is essentially a node-like task "router"
         // Just name it based on source + ".condition" or use function name?
         // In python example the trace node name is "route_question.task" because the function name is "route_question".
         // Let's use the function name if available, or "condition".
         let name = "condition";
         if (typeof path === 'function' && path.name) {
             name = path.name;
         }
         
         const wrappedPath = wrapNode(tracer, path, name);
         
         return originalAddConditionalEdges.call(this, source, wrappedPath, ...rest);
      };

    } catch (error) {
      console.error(`Failed to instrument StateGraph: ${error}`);
    }
  }

  private _uninstrumentStateGraph(StateGraph: any): void {
    try {
      const originalAddNode = originalMethods.get("langgraph.StateGraph.addNode");
      if (originalAddNode) {
        StateGraph.prototype.addNode = originalAddNode;
      }
      
      const originalAddConditionalEdges = originalMethods.get("langgraph.StateGraph.addConditionalEdges");
      if (originalAddConditionalEdges) {
        StateGraph.prototype.addConditionalEdges = originalAddConditionalEdges;
      }

    } catch (error) {
      console.error(`Failed to uninstrument StateGraph: ${error}`);
    }
  }
}

export const langgraphInstrumentor = new NetraLanggraphInstrumentor();

export { __version__ } from "./version";
