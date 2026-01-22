import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { RunnableConfig } from "@langchain/core/runnables";
import { LLMResult } from "@langchain/core/outputs";
import { Serialized } from "@langchain/core/load/serializable";
import { ChainValues } from "@langchain/core/utils/types";
import {
  Context,
  Span,
  SpanKind,
  Tracer,
  context,
  trace,
} from "@opentelemetry/api";
import {
  shouldSuppressInstrumentation,
  setNetraAttributes,
  setResponseAttributes as setBaseResponseAttributes,
} from "../utils";
import { setLlmRequestAttributes } from "./utils";

type AnyFunc = (...args: any[]) => any;
type AsyncIterableFunc = (...args: any[]) => Promise<AsyncIterable<any>>;

class NetraLanggraphContextManager {
  private static _currentContext: Context | null = null;
  private static _activeContextStack: Context[] = [];

  static addContext(context: Context) {
    this._currentContext = context;
    this._activeContextStack.push(context);
  }

  static createSpanContext(span: Span) {
    const spanContext = trace.setSpan(context.active(), span);
    this.addContext(spanContext);
  }

  static removeContext() {
    this._activeContextStack.pop();
    const activeContexts = this._activeContextStack.length;
    this._currentContext =
      activeContexts > 0 ? this._activeContextStack[activeContexts - 1] : null;
  }

  static getCurrentContext() {
    return this._currentContext;
  }

  static runWithContext(func: () => any) {
    return this._currentContext
      ? context.with(this._currentContext, func)
      : func();
  }
}

class NetraLanggraphCallbackHandler extends BaseCallbackHandler {
  name = "netra-langgraph-callback-handler";
  private nodes: Record<string, any>[] = [];

  constructor(private tracer: Tracer) {
    super();
  }

  private addNode(id: string, name: string, span: Span) {
    this.nodes.push({ id, name, span });
  }

  private addNodeAttributes(attributes: Record<string, any>) {
    if (this.nodes.length === 0) return;
    let currentNode = this.nodes[this.nodes.length - 1];
    this.nodes[this.nodes.length - 1] = { ...currentNode, attributes };
  }

  private removeNode() {
    if (this.nodes.length === 0) return;
    return this.nodes.pop();
  }

  private get currentNode(): Record<string, any> | null {
    if (this.nodes.length == 0) return null;
    return this.nodes[this.nodes.length - 1];
  }

  async handleChainStart(
    chain: Serialized,
    inputs: ChainValues,
    runId: string,
    runType?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    parentRunId?: string,
    extra?: Record<string, unknown>,
  ) {
    const nodeName = (metadata?.langgraph_node ?? "") as string;
    const nodeType = chain.id?.[chain.id.length - 1] || "Unknown";

    if (
      !nodeName ||
      nodeType.toUpperCase() !== "RUNNABLESEQUENCE" ||
      ["__start__"].includes(nodeName.toLowerCase())
    ) {
      return;
    }

    NetraLanggraphContextManager.runWithContext(() => {
      const span = this.tracer.startSpan(`${nodeName}.task`);
      NetraLanggraphContextManager.createSpanContext(span);
      setNetraAttributes(span, "langgraph");
      this.addNode(runId, nodeName, span);
    });
  }

  async handleChainEnd(
    outputs: ChainValues,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: { inputs?: Record<string, unknown> },
  ) {
    const nodeInfo = this.currentNode;
    if (nodeInfo === null || nodeInfo?.id !== parentRunId) return;
    NetraLanggraphContextManager.runWithContext(() => {
      nodeInfo.span.end();
    });
    this.removeNode();
    NetraLanggraphContextManager.removeContext();
  }

  async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.addNodeAttributes({
      metadata,
      prompts,
      extraParams,
    });
  }

  async handleLLMEnd(
    output: LLMResult,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    let nodeInfo = this.currentNode;
    if (nodeInfo === null || nodeInfo?.id !== parentRunId) return;

    const response = (output?.generations?.[0]?.[0] as any)?.message;
    const attributes = nodeInfo.attributes;
    NetraLanggraphContextManager.runWithContext(() => {
      const span = this.tracer.startSpan(`llm.task`);
      setNetraAttributes(span, "langgraph");
      setLlmRequestAttributes(
        span,
        attributes.metadata,
        attributes.prompts,
        attributes.extraParams,
      );
      setBaseResponseAttributes(span, response);
      span.end();
    });
  }
}

class LanggraphStreamingWrapper implements AsyncIterable<unknown> {
  private iterable?: AsyncIterable<any>;
  private responses: any[] = [];

  constructor(private originalFunc: AsyncIterableFunc) {}

  async startStream(
    instance: unknown,
    input: any,
    config?: RunnableConfig,
    ...rest: any[]
  ) {
    await NetraLanggraphContextManager.runWithContext(async () => {
      this.iterable = await this.originalFunc.call(
        instance,
        input,
        config,
        ...rest,
      );
      for await (let response of this.iterable) {
        this.responses.push(response);
      }
    });
    return this;
  }

  async *[Symbol.asyncIterator]() {
    for await (const response of this.responses) {
      yield response;
    }
  }
}

export class LanggraphWrapper {
  private spanName: string;

  constructor(private tracer: Tracer) {
    this.spanName = "Langgraph.workflow";
  }

  private getUpdatedConfig(config?: RunnableConfig): RunnableConfig {
    const callbackHandler = new NetraLanggraphCallbackHandler(this.tracer);
    const callbacks = config?.callbacks;
    const normalizedCallbacks = callbacks
      ? Array.isArray(callbacks)
        ? callbacks
        : [callbacks]
      : [];
    const updatedConfig: RunnableConfig = {
      ...config,
      callbacks: [...normalizedCallbacks, callbackHandler],
    };
    return updatedConfig;
  }

  async invoke(
    originalFunc: AnyFunc,
    instance: unknown,
    input: any,
    config?: RunnableConfig,
    ...rest: any[]
  ): Promise<unknown> {
    if (shouldSuppressInstrumentation()) {
      return await originalFunc.call(instance, input, config, ...rest);
    }

    return NetraLanggraphContextManager.runWithContext(async () => {
      const span = this.tracer.startSpan(this.spanName, {
        kind: SpanKind.CLIENT,
      });
      NetraLanggraphContextManager.createSpanContext(span);
      try {
        setNetraAttributes(span, "langgraph");
        const updatedConfig = this.getUpdatedConfig(config);
        return await originalFunc.call(instance, input, updatedConfig, ...rest);
      } finally {
        span.end();
        NetraLanggraphContextManager.removeContext();
      }
    });
  }

  async stream(
    originalFunc: AsyncIterableFunc,
    instance: unknown,
    input: any,
    config?: RunnableConfig,
    ...rest: any[]
  ): Promise<AsyncIterable<unknown>> {
    if (shouldSuppressInstrumentation()) {
      return await originalFunc.call(instance, input, config, ...rest);
    }

    return NetraLanggraphContextManager.runWithContext(async () => {
      const span = this.tracer.startSpan(this.spanName, {
        kind: SpanKind.CLIENT,
      });
      NetraLanggraphContextManager.createSpanContext(span);
      try {
        setNetraAttributes(span, "langgraph");
        const updatedConfig = this.getUpdatedConfig(config);
        const streamingWrapper = new LanggraphStreamingWrapper(originalFunc);
        return await streamingWrapper.startStream(
          instance,
          input,
          updatedConfig,
          ...rest,
        );
      } catch (error) {
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
        NetraLanggraphContextManager.removeContext();
      }
    });
  }
}
