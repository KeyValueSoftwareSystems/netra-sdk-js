import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { Serialized } from "@langchain/core/load/serializable";
import { LLMResult } from "@langchain/core/outputs";
import { RunnableConfig } from "@langchain/core/runnables";
import { ChainValues } from "@langchain/core/utils/types";
import {
  Span,
  SpanKind,
  Tracer,
  Context,
  context,
  trace,
  createContextKey,
} from "@opentelemetry/api";

import {
  setResponseAttributes as setBaseResponseAttributes,
  shouldSuppressInstrumentation,
} from "../utils";

// Context key to track if we're inside a LangGraph instrumented call
// This prevents double-instrumentation when invoke internally calls stream
const LANGGRAPH_INSTRUMENTATION_ACTIVE = createContextKey("netra.langgraph.active");

function getContextManager(): any {
  try {
    if ((context as any)._getContextManager) {
      return (context as any)._getContextManager();
    }

    const globalSymbols = Object.getOwnPropertySymbols(global);
    const otelSymbol = globalSymbols.find(s =>
      s.toString().includes("opentelemetry.js.api"),
    );
    if (otelSymbol) {
      const globalState = (global as any)[otelSymbol];
      if (globalState?.contextManager) {
        return globalState.contextManager;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function enterWithContext(newContext: Context): void {
  const contextManager = getContextManager();
  if (!contextManager) return;

  if (typeof contextManager.enterWith === "function") {
    contextManager.enterWith(newContext);
    return;
  }

  if (
    contextManager._asyncLocalStorage &&
    typeof contextManager._asyncLocalStorage.enterWith === "function"
  ) {
    contextManager._asyncLocalStorage.enterWith(newContext);
  }
}
import {
  NetraLanggraphAttributes,
  setChainInputAttributes,
  setChainOutputAttributes,
  setGraphInputAttributes,
  setGraphOutputAttributes,
  setLlmRequestAttributes,
  setToolAttributes,
} from "./utils";

type AnyFunc = (...args: any[]) => any;
type AsyncIterableFunc = (...args: any[]) => Promise<AsyncIterable<any>>;

class NetraLanggraphCallbackHandler extends BaseCallbackHandler {
  name = "netra-langgraph-callback-handler";
  // Map runId -> Span for explicit parenting
  private spans: Map<string, Span> = new Map();
  private nodeAttributes: Map<string, Record<string, any>> = new Map();
  private runStack: string[] = [];
  private inferredParents: Map<string, string> = new Map();

  constructor(
    private tracer: Tracer,
    private rootSpan: Span,
  ) {
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

  private inferParentRunId(parentRunId?: string): string | undefined {
    if (parentRunId) return parentRunId;
    return this.runStack.length > 0
      ? this.runStack[this.runStack.length - 1]
      : undefined;
  }

  private pushRun(runId: string): void {
    this.runStack.push(runId);
  }

  private popRun(runId: string): void {
    const last = this.runStack[this.runStack.length - 1];
    if (last === runId) {
      this.runStack.pop();
      return;
    }
    const idx = this.runStack.lastIndexOf(runId);
    if (idx >= 0) {
      this.runStack.splice(idx, 1);
    }
  }

  async handleChainStart(
    chain: Serialized,
    inputs: ChainValues,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    runType?: string,
  ) {
    const metadataNodeName =
      typeof metadata?.langgraph_node === "string"
        ? (metadata.langgraph_node as string)
        : "";
    const runNameValue = typeof runName === "string" ? runName : "";
    const chainIdName =
      Array.isArray(chain.id) && chain.id.length > 0
        ? chain.id[chain.id.length - 1]
        : "";
    const nodeName = metadataNodeName || runNameValue || chainIdName || "Chain";
    const nodeType = chainIdName || "Unknown";

    if (process.env.NETRA_DEBUG_LOGS) {
      const metadataKeys =
        metadata && typeof metadata === "object"
          ? Object.keys(metadata as Record<string, unknown>).join(",")
          : "n/a";
      console.log(
        `[Netra Debug] NetraLanggraph handleChainStart: runId=${runId} parentRunId=${parentRunId} nodeName=${nodeName} nodeType=${nodeType} runName=${runNameValue || "n/a"} metadataKeys=${metadataKeys}`,
      );
    }

    if (
      !nodeName ||
      ["__start__"].includes(nodeName.toLowerCase())
    ) {
      return;
    }

    const effectiveParentRunId = this.inferParentRunId(parentRunId);
    if (
      !parentRunId &&
      effectiveParentRunId &&
      effectiveParentRunId !== runId
    ) {
      this.inferredParents.set(runId, effectiveParentRunId);
      if (process.env.NETRA_DEBUG_LOGS) {
        console.log(
          `[Netra Debug] NetraLanggraph inferred parent: runId=${runId} parentRunId=${effectiveParentRunId}`,
        );
      }
    }

    const parentSpan = this.getParentSpan(effectiveParentRunId);

    // Create span parented to the correct node/workflow
    const ctx = trace.setSpan(context.active(), parentSpan);
    const span = this.tracer.startSpan(`${nodeName}.task`, undefined, ctx);

    setChainInputAttributes(span, inputs, tags, metadata);

    this.spans.set(runId, span);
    this.pushRun(runId);
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
    this.nodeAttributes.delete(runId);
    this.inferredParents.delete(runId);
    this.popRun(runId);
  }

  async handleChainError(
    err: any,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: { inputs?: Record<string, unknown> },
  ) {
    const span = this.spans.get(runId);
    if (!span) return;
    span.recordException(err);
    span.end();
    this.spans.delete(runId);
    this.nodeAttributes.delete(runId);
    this.inferredParents.delete(runId);
    this.popRun(runId);
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
    const effectiveParentRunId =
      parentRunId ?? this.inferParentRunId(parentRunId);
    if (process.env.NETRA_DEBUG_LOGS) {
      const llmId = llm.id?.[llm.id.length - 1] || "llm";
      console.log(
        `[Netra Debug] NetraLanggraph handleLLMStart: runId=${runId} parentRunId=${effectiveParentRunId} llmId=${llmId}`,
      );
    }
    this.addNodeAttributes(runId, {
      llmIds: llm.id,
      metadata,
      prompts,
      extraParams,
      parentRunId: effectiveParentRunId, // Store parent ID to link back
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

    const effectiveParentRunId =
      parentRunId ??
      attributes.parentRunId ??
      this.inferredParents.get(runId);
    const parentSpan = this.getParentSpan(effectiveParentRunId);
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

  async handleLLMError(
    err: any,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    extraParams?: Record<string, unknown>,
  ) {
    const attributes = this.nodeAttributes.get(runId);
    if (!attributes) return;

    const llmIds = attributes.llmIds ?? [];
    const llmId = llmIds?.length > 0 ? llmIds[llmIds.length - 1] : "llm";

    const effectiveParentRunId =
      parentRunId ??
      attributes.parentRunId ??
      this.inferredParents.get(runId);
    const parentSpan = this.getParentSpan(effectiveParentRunId);
    const ctx = trace.setSpan(context.active(), parentSpan);

    const span = this.tracer.startSpan(`${llmId}.task`, undefined, ctx);
    span.recordException(err);
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

    const effectiveParentRunId =
      parentRunId ?? this.inferParentRunId(parentRunId);
    if (process.env.NETRA_DEBUG_LOGS) {
      const toolName = tool.id?.[tool.id.length - 1] || "tool";
      console.log(
        `[Netra Debug] NetraLanggraph handleToolStart: runId=${runId} parentRunId=${effectiveParentRunId} tool=${toolName}`,
      );
    }
    this.addNodeAttributes(runId, {
      input: parsedInput,
      metadata,
      tags,
      parentRunId: effectiveParentRunId,
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

    const effectiveParentRunId =
      parentRunId ??
      attributes.parentRunId ??
      this.inferredParents.get(runId);
    const parentSpan = this.getParentSpan(effectiveParentRunId);
    const ctx = trace.setSpan(context.active(), parentSpan);

    const span = this.tracer.startSpan(`${toolName}.tool`, undefined, ctx);
    setToolAttributes(span, toolName, input ?? {}, output, metadata, tags);
    span.end();

    this.nodeAttributes.delete(runId);
  }

  async handleToolError(
    err: any,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ) {
    const attributes = this.nodeAttributes.get(runId);
    if (!attributes) return;

    const toolName = attributes?.input?.name ?? "custom";
    const effectiveParentRunId =
      parentRunId ??
      attributes.parentRunId ??
      this.inferredParents.get(runId);
    const parentSpan = this.getParentSpan(effectiveParentRunId);
    const ctx = trace.setSpan(context.active(), parentSpan);
    const span = this.tracer.startSpan(`${toolName}.tool`, undefined, ctx);
    span.recordException(err);
    span.end();

    this.nodeAttributes.delete(runId);
  }
}

class LanggraphStreamingWrapper implements AsyncIterable<unknown> {
  private iterable: any;
  private output: Record<string, any> = {};

  constructor(
    private rootSpan: Span,
    private rootContext: Context,
  ) {}

  async startStream(
    originalFunc: (...args: any[]) => any,
    instance: unknown,
    input: any,
    config?: RunnableConfig,
    ...rest: any[]
  ) {
    this.iterable = await originalFunc.call(instance, input, config, ...rest);
    return this;
  }

  async *[Symbol.asyncIterator]() {
    const spanContext = trace.setSpan(this.rootContext, this.rootSpan);
    try {
      const iterator = await this.iterable[Symbol.asyncIterator]();
      while (true) {
        let result: any;
        await context.with(spanContext, async () => {
          result = await iterator.next();
        });
        if (result.done) break;
        const value = result?.value ?? {};
        this.output = { ...this.output, ...value };
        yield result;
      }
      this.rootSpan.setAttribute(
        NetraLanggraphAttributes.entityOutput,
        JSON.stringify({ outputs: this.output }),
      );
    } catch (error) {
      this.rootSpan.recordException(error as Error);
      throw error;
    } finally {
      this.rootSpan.end();
    }
  }
}

export class LanggraphWrapper {
  private spanName: string;

  constructor(private tracer: Tracer) {
    this.spanName = "Langgraph.workflow";
  }

  private getUpdatedConfig(
    config?: RunnableConfig,
    rootSpan?: Span,
  ): RunnableConfig {
    if (!rootSpan) return config || {};

    const callbackHandler = new NetraLanggraphCallbackHandler(
      this.tracer,
      rootSpan,
    );
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
    // Skip if instrumentation is suppressed or we're already inside a LangGraph instrumented call
    if (shouldSuppressInstrumentation() || context.active().getValue(LANGGRAPH_INSTRUMENTATION_ACTIVE)) {
      return await originalFunc.call(instance, input, config, ...rest);
    }

    const activeSpan = trace.getSpan(context.active());
    if (process.env.NETRA_DEBUG_LOGS) {
        console.log(`[Netra Debug] LangGraph invoke start. Active TraceId: ${activeSpan?.spanContext().traceId}, SpanId: ${activeSpan?.spanContext().spanId}`);
    }

    // Start metadata spanning for the workflow
    // We use context.active() to parent to the current active span (e.g. request handler)
    const span = this.tracer.startSpan(
      this.spanName,
      {
        kind: SpanKind.CLIENT,
      },
      context.active()
    );

    if (process.env.NETRA_DEBUG_LOGS) {
        console.log(`[Netra Debug] LangGraph span created. New TraceId: ${span.spanContext().traceId}, SpanId: ${span.spanContext().spanId}`);
    }

    // Set the active flag to prevent nested instrumentation (e.g., when invoke calls stream internally)
    const ctxWithSpan = trace.setSpan(context.active(), span);
    const ctxWithFlag = ctxWithSpan.setValue(LANGGRAPH_INSTRUMENTATION_ACTIVE, true);
    enterWithContext(ctxWithFlag);

    return context.with(ctxWithFlag, async () => {
      if (process.env.NETRA_DEBUG_LOGS) {
           const innerSpan = trace.getSpan(context.active());
           console.log(`[Netra Debug] Inside LangGraph context. Active TraceId: ${innerSpan?.spanContext().traceId}, SpanId: ${innerSpan?.spanContext().spanId}`);
      }
      try {
        setGraphInputAttributes(span, input);

        // Pass the workflow span as the root for the callback handler
        const updatedConfig = this.getUpdatedConfig(config, span);

        const output = await originalFunc.call(
          instance,
          input,
          updatedConfig,
          ...rest,
        );

        setGraphOutputAttributes(span, output);

        return output;
      } catch (e) {
        span.recordException(e as Error);
        throw e;
      } finally {
        span.end();
      }
    });
  }

  async stream(
    originalFunc: AsyncIterableFunc,
    instance: unknown,
    input: any,
    config?: RunnableConfig,
    ...rest: any[]
  ): Promise<unknown> {
    // Skip if instrumentation is suppressed or we're already inside a LangGraph instrumented call
    if (shouldSuppressInstrumentation() || context.active().getValue(LANGGRAPH_INSTRUMENTATION_ACTIVE)) {
      if (process.env.NETRA_DEBUG_LOGS) {
        console.log("[Netra Debug] LangGraph stream skipped (inside instrumented call)");
      }
      return await originalFunc.call(instance, input, config, ...rest);
    }

    if (process.env.NETRA_DEBUG_LOGS) {
      console.log("[Netra Debug] LangGraph stream starting instrumentation");
    }

    const span = this.tracer.startSpan(
      this.spanName,
      {
        kind: SpanKind.CLIENT,
      },
      context.active(),
    );
    setGraphInputAttributes(span, input);
    const updatedConfig = this.getUpdatedConfig(config, span);
    try {
      const ctxWithSpan = trace.setSpan(context.active(), span);
      const ctxWithFlag = ctxWithSpan.setValue(LANGGRAPH_INSTRUMENTATION_ACTIVE, true);
      enterWithContext(ctxWithFlag);
      const streamingWrapper = new LanggraphStreamingWrapper(span, ctxWithFlag);
      return streamingWrapper.startStream(
        originalFunc,
        instance,
        input,
        updatedConfig,
        ...rest,
      );
    } catch (error) {
      span.recordException(error as Error);
      span.end();
    }
  }
}
