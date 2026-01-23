import { LLMResult } from "@langchain/core/outputs";
import { RunnableConfig } from "@langchain/core/runnables";
import { ChainValues } from "@langchain/core/utils/types";
import { Serialized } from "@langchain/core/load/serializable";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
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
  setResponseAttributes as setBaseResponseAttributes,
} from "../utils";
import {
  setChainInputAttributes,
  setChainOutputAttributes,
  setInvokeInputAttributes,
  setInvokeOutputAttributes,
  setLlmRequestAttributes,
  setToolAttributes,
} from "./utils";

type AnyFunc = (...args: any[]) => any;

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
      setChainInputAttributes(span, inputs, tags, metadata);
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
      const span: Span = nodeInfo.span;
      setChainOutputAttributes(span, outputs, tags);
      span.end();
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
      llmIds: llm.id,
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
    const llmIds = attributes.llmIds ?? [];
    const llmId = llmIds?.length > 0 ? llmIds[llmIds.length - 1] : "llm";

    NetraLanggraphContextManager.runWithContext(() => {
      const span = this.tracer.startSpan(`${llmId}.task`);
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

  async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    let parsedInput: Record<string | number, any>;
    try {
      parsedInput = JSON.parse(input);
    } catch {
      parsedInput = {};
    }
    this.addNodeAttributes({
      input: parsedInput,
      metadata,
      tags,
    });
  }

  async handleToolEnd(
    output: any,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ) {
    let nodeInfo = this.currentNode;
    if (nodeInfo === null || nodeInfo?.id !== parentRunId) return;

    const attributes = nodeInfo.attributes;
    const toolName = attributes?.input?.name ?? "custom";
    const { input, metadata } = attributes;

    NetraLanggraphContextManager.runWithContext(() => {
      const span = this.tracer.startSpan(`${toolName}.tool`);
      setToolAttributes(span, toolName, input ?? {}, output, metadata, tags);
      span.end();
    });
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
        setInvokeInputAttributes(span, input);

        const updatedConfig = this.getUpdatedConfig(config);
        const output = await originalFunc.call(
          instance,
          input,
          updatedConfig,
          ...rest,
        );

        setInvokeOutputAttributes(span, output);

        return output;
      } finally {
        span.end();
        NetraLanggraphContextManager.removeContext();
      }
    });
  }
}
