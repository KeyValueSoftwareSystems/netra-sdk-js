import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { Serialized } from "@langchain/core/load/serializable";
import { LLMResult } from "@langchain/core/outputs";
import { RunnableConfig } from "@langchain/core/runnables";
import { ChainValues } from "@langchain/core/utils/types";
import {
    Span,
    SpanKind,
    Tracer,
    context,
    trace
} from "@opentelemetry/api";

import {
    setResponseAttributes as setBaseResponseAttributes,
    shouldSuppressInstrumentation,
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

class NetraLanggraphCallbackHandler extends BaseCallbackHandler {
  name = "netra-langgraph-callback-handler";
  // Map runId -> Span for explicit parenting
  private spans: Map<string, Span> = new Map();
  private nodeAttributes: Map<string, Record<string, any>> = new Map();

  constructor(private tracer: Tracer, private rootSpan: Span) {
    super();
  }

  private getParentSpan(parentRunId?: string): Span {
    if (parentRunId && this.spans.has(parentRunId)) {
      return this.spans.get(parentRunId)!;
    }
    return this.rootSpan;
  }

  private addNodeAttributes(runId: string, attributes: Record<string, any>) {
    const current = this.nodeAttributes.get(runId) || {};
    this.nodeAttributes.set(runId, { ...current, ...attributes });
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

    const parentSpan = this.getParentSpan(parentRunId);
    
    // Create span parented to the correct node/workflow
    const ctx = trace.setSpan(context.active(), parentSpan);
    const span = this.tracer.startSpan(`${nodeName}.task`, undefined, ctx);
    
    setChainInputAttributes(span, inputs, tags, metadata);
    
    this.spans.set(runId, span);
  }

  async handleChainEnd(
    outputs: ChainValues,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: { inputs?: Record<string, unknown> },
  ) {
    const span = this.spans.get(runId);
    if (!span) return;

    setChainOutputAttributes(span, outputs, tags);
    span.end();
    this.spans.delete(runId);
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
    // Just store attributes for later use in handleLLMEnd where we create the span
    // Ideally we'd create the span here, but the original implementation did it in End??
    // Wait, the original implementation did addNodeAttributes here.
    // Let's attach these attributes to the *parent* node if it exists, or verify behavior.
    
    // Correction: In LangChain, LLM start is its own run. It will have a runId.
    // We should probably start the span here if we want to trace the LLM call duration accurately.
    // However, sticking to the previous logic of creating it at the end for simplicity of attributes?
    // No, standard OTel practice is to start on Start.
    
    // But keeping it close to original logic:
    // Original logic: handleLLMEnd creates the span.
    // Let's stick to that pattern to minimize regression risk, but manage attributes properly map-based.
    
    this.addNodeAttributes(runId, {
        llmIds: llm.id,
        metadata,
        prompts,
        extraParams,
        parentRunId // Store parent ID to link back
    });
  }

  async handleLLMEnd(
    output: LLMResult,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    const attributes = this.nodeAttributes.get(runId);
    if (!attributes) return;

    const response = (output?.generations?.[0]?.[0] as any)?.message;
    const llmIds = attributes.llmIds ?? [];
    const llmId = llmIds?.length > 0 ? llmIds[llmIds.length - 1] : "llm";
    
    const parentSpan = this.getParentSpan(parentRunId);
    const ctx = trace.setSpan(context.active(), parentSpan);
    
    const span = this.tracer.startSpan(`${llmId}.task`, undefined, ctx);
    setLlmRequestAttributes(
      span,
      attributes.metadata,
      attributes.prompts,
      attributes.extraParams,
    );
    setBaseResponseAttributes(span, response);
    span.end();
    
    this.nodeAttributes.delete(runId);
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
    
    this.addNodeAttributes(runId, {
      input: parsedInput,
      metadata,
      tags
    });
  }

  async handleToolEnd(
    output: any,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ) {
    const attributes = this.nodeAttributes.get(runId);
    if (!attributes) return;

    const toolName = attributes?.input?.name ?? "custom";
    const { input, metadata } = attributes;

    const parentSpan = this.getParentSpan(parentRunId);
    const ctx = trace.setSpan(context.active(), parentSpan);

    const span = this.tracer.startSpan(`${toolName}.tool`, undefined, ctx);
    setToolAttributes(span, toolName, input ?? {}, output, metadata, tags);
    span.end();

    this.nodeAttributes.delete(runId);
  }
}

export class LanggraphWrapper {
  private spanName: string;

  constructor(private tracer: Tracer) {
    this.spanName = "Langgraph.workflow";
  }

  private getUpdatedConfig(config?: RunnableConfig, rootSpan?: Span): RunnableConfig {
    if (!rootSpan) return config || {};

    const callbackHandler = new NetraLanggraphCallbackHandler(this.tracer, rootSpan);
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

    // Start metadata spanning for the workflow
    // We use context.active() to parent to the current active span (e.g. request handler)
    const span = this.tracer.startSpan(this.spanName, {
      kind: SpanKind.CLIENT,
    });
    
    return context.with(trace.setSpan(context.active(), span), async () => {
        try {
            setInvokeInputAttributes(span, input);
            
            // Pass the workflow span as the root for the callback handler
            const updatedConfig = this.getUpdatedConfig(config, span);
            
            const output = await originalFunc.call(
              instance,
              input,
              updatedConfig,
              ...rest,
            );
    
            setInvokeOutputAttributes(span, output);
    
            return output;
        } catch (e) {
            span.recordException(e as Error);
            throw e;
        } finally {
            span.end();
        }
    });
  }
}
