import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  Span,
  SpanKind,
  Tracer,
  context,
  trace,
} from "@opentelemetry/api";
import { ContextStore } from "../../context-store";
import {
  setNetraAttributes, shouldSuppressInstrumentation
} from "../utils";

type AnyFunc = (...args: any[]) => any;

/**
 * Wraps a node functionality to ensure proper context propagation.
 * This ensures that any operations (LLM calls, etc.) inside the node
 * are properly parented to the node's span.
 */
export function wrapNode(tracer: Tracer, originalNode: any, nodeName: string): any {
  if (typeof originalNode !== "function") {
    // If it's a Runnable or object, we might not be able to easily wrap execution
    // unless we wrap .invoke. For now, we focus on function nodes.
    return originalNode;
  }

  return async function (this: any, state: any, config?: RunnableConfig) {
    // Start a span for the node
    return tracer.startActiveSpan(
      `${nodeName}.task`,
      { kind: SpanKind.INTERNAL },
      async (span) => {
        try {
          // Set standard attributes
          setNetraAttributes(span, "langgraph");
          span.setAttribute("langgraph.node", nodeName);
          
          // Execute the original node function within the span context
          // We pass 'this' regarding the binding.
          const result = await originalNode.call(this, state, config);
          
          return result;
        } catch (error) {
          span.recordException(error as Error);
          throw error;
        } finally {
          span.end();
        }
      }
    );
  };
}

/**
 * Handler only for adding attributes to existing spans, if necessary.
 * With wrapping, we rely on standard instrumentation for child spans.
 */
class NetraLanggraphCallbackHandler extends BaseCallbackHandler {
  name = "netra-langgraph-callback-handler";

  constructor(private tracer: Tracer) {
    super();
  }

  // We no longer create spans here because we use wrapNode for creating active spans
  // that properly propagate context to children.
}

export class LanggraphWrapper {
  private spanName: string;

  constructor(
    private tracer: Tracer,
    private originalFunc: AnyFunc,
  ) {
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
    instance: unknown,
    input: any,
    config?: RunnableConfig,
    ...rest: any[]
  ): Promise<unknown> {
    if (shouldSuppressInstrumentation()) {
      return await this.originalFunc.call(instance, input, config, ...rest);
    }

    // Ensure we have an isolated context for this invocation
    const hasExistingContext = ContextStore.hasContext();

    const executeInvoke = async () => {
      // Use startActiveSpan to properly set this span as the active parent
      return this.tracer.startActiveSpan(
        this.spanName,
        { kind: SpanKind.CLIENT },
        async (span: Span) => {
          try {
            setNetraAttributes(span, "langgraph");
            const updatedConfig = this.getUpdatedConfig(config);

            // Execute the graph within the span's context
            return await context.with(
              trace.setSpan(context.active(), span),
              async () => {
                return await this.originalFunc.call(
                  instance,
                  input,
                  updatedConfig,
                  ...rest,
                );
              }
            );
          } finally {
            span.end();
          }
        }
      );
    };

    // If no context exists, create one for this invocation
    if (hasExistingContext) {
      return executeInvoke();
    } else {
      return ContextStore.runWithNewContext(() => executeInvoke());
    }
  }
}
