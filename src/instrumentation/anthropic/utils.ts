import {
  Context,
  Span,
  SpanKind,
  SpanStatusCode,
  Tracer,
  context,
  trace,
} from "@opentelemetry/api";
import { Logger } from "../../logger";
import { SpanAttributes } from "../span-attributes";
import {
  setRequestAttributes as setBaseRequestAttributes,
  setResponseAttributes as setBaseResponseAttributes,
} from "../utils";

function toolSafeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Wrap each tool's `run()` method so that every invocation creates a
 * real-time TOOL span with actual start/end timestamps. Works with
 * `BetaRunnableTool` objects passed to `toolRunner()`.
 */
export function wrapRunnableTools(
  tools: any[],
  tracer: Tracer,
  parentContext: Context,
): any[] {
  return tools.map((tool) => {
    if (typeof tool.run !== "function") return tool;

    const originalRun = tool.run;
    const toolName = tool.name ?? "unknown_tool";

    const wrappedRun = async function (this: any, input: any, runContext?: any) {
      const toolUseId = runContext?.toolUse?.id ?? runContext?.toolUseBlock?.id;
      const span = tracer.startSpan(
        toolName,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "netra.span.type": "TOOL",
            [SpanAttributes.LLM_REQUEST_TOOL_NAME]: toolName,
            ...(toolUseId ? { [SpanAttributes.LLM_REQUEST_TOOL_ID]: toolUseId } : {}),
            input: toolSafeStringify(input),
          },
        },
        parentContext,
      );

      const spanCtx = trace.setSpan(parentContext, span);
      try {
        const result = await context.with(spanCtx, () =>
          originalRun.call(this, input, runContext),
        );
        span.setAttribute("output", toolSafeStringify(result));
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    };

    return { ...tool, run: wrappedRun };
  });
}

/**
 * Accumulate a single Anthropic SSE chunk into `completeResponse`.
 * MessageStreamWrapper delegates here for chunk-level processing.
 */
export function processStreamChunk(
  completeResponse: Record<string, any>,
  chunk: any,
  span: Span,
): void {
  switch (chunk.type) {
    case "message_start": {
      if (chunk.message?.model) {
        completeResponse.model = chunk.message.model;
      }
      if (chunk.message?.usage) {
        completeResponse.usage = chunk.message.usage;
      }
      break;
    }

    case "content_block_start": {
      if (!completeResponse.content) {
        completeResponse.content = [];
      }
      const block = chunk.content_block;
      if (block.type === "tool_use") {
        completeResponse.content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: "",
        });
      } else {
        completeResponse.content.push({
          type: block.type,
          text: "",
        });
      }
      break;
    }

    case "content_block_delta": {
      if (!completeResponse.content || completeResponse.content.length === 0) {
        completeResponse.content = [{ type: "text", text: "" }];
      }
      const lastBlock =
        completeResponse.content[completeResponse.content.length - 1];

      if (
        chunk.delta?.type === "input_json_delta" &&
        lastBlock?.type === "tool_use"
      ) {
        lastBlock.input += chunk.delta.partial_json ?? "";
      } else if (lastBlock && chunk.delta?.text) {
        lastBlock.text += chunk.delta.text;
      }
      break;
    }

    case "content_block_stop": {
      const blocks = completeResponse.content;
      if (blocks && blocks.length > 0) {
        const finishedBlock = blocks[blocks.length - 1];
        if (
          finishedBlock?.type === "tool_use" &&
          typeof finishedBlock.input === "string"
        ) {
          try {
            finishedBlock.input = JSON.parse(finishedBlock.input);
          } catch {
            Logger.warn(
              "netra.instrumentation.anthropic: Failed to parse tool use input",
              finishedBlock.input,
            );
          }
        }
      }
      break;
    }

    case "message_delta": {
      if (chunk.delta?.stop_reason) {
        completeResponse.stop_reason = chunk.delta.stop_reason;
      }
      if (chunk.usage) {
        completeResponse.usage = {
          ...(completeResponse.usage ?? {}),
          ...chunk.usage,
        };
      }
      break;
    }

    case "message_stop": {
      if (chunk.usage) {
        completeResponse.usage = chunk.usage;
      }
      break;
    }
  }

  span.addEvent("llm.content.completion.chunk", {
    "chunk.type": chunk.type,
  });
}

/**
 * Close out a streaming span: set response attributes, record duration,
 * and end the span.
 */
export function finalizeStreamSpan(
  span: Span,
  completeResponse: Record<string, any>,
  startTime: number,
  _parentContext: any,
  code: SpanStatusCode,
): void {
  const endTime = Date.now();

  setResponseAttributes(span, {
    model: completeResponse.model,
    content: completeResponse.content,
    usage: completeResponse.usage,
    stop_reason: completeResponse.stop_reason,
  });

  span.setAttribute("llm.response.duration", (endTime - startTime) / 1000);
  span.setStatus({ code });
  span.end();
}

export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string
): void {
  if (!span.isRecording()) {
    Logger.log("Span is not recording");
    return;
  }
  setBaseRequestAttributes(span, kwargs, requestType, "anthropic");
}

export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>
): void {
  if (!span.isRecording()) {
    Logger.log("Span is not recording");
    return;
  }
  if(response?.type === 'message_batch'){
    span.setAttribute("status", response?.processing_status as string);
  }
  setBaseResponseAttributes(span, response);
}
