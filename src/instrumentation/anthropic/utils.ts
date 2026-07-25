import { Span, SpanStatusCode } from "@opentelemetry/api";
import { Logger } from "../../logger";
import {
  setRequestAttributes as setBaseRequestAttributes,
  setResponseAttributes as setBaseResponseAttributes,
} from "../utils";

/**
 * True when an Anthropic SSE event carries a piece of generated content —
 * assistant text, extended-thinking text, or streamed tool-call JSON. Used to
 * pin down the first-token moment; `message_start` and `content_block_start`
 * arrive before the model has produced anything.
 */
export function isContentDeltaChunk(chunk: any): boolean {
  if (chunk?.type !== "content_block_delta") return false;
  const delta = chunk.delta;
  return Boolean(delta?.text || delta?.partial_json || delta?.thinking);
}

/**
 * Accumulate a single Anthropic SSE chunk into `completeResponse`.
 * Safe against malformed events — all field access is guarded.
 */
export function processStreamChunk(
  completeResponse: Record<string, any>,
  chunk: any,
  span: Span,
): void {
  try {
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
        if (!block) break;
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
        if (
          !completeResponse.content ||
          completeResponse.content.length === 0
        ) {
          completeResponse.content = [{ type: "text", text: "" }];
        }
        const targetIndex =
          chunk.index ?? completeResponse.content.length - 1;
        const targetBlock = completeResponse.content[targetIndex];
        if (!targetBlock) break;

        if (
          chunk.delta?.type === "input_json_delta" &&
          targetBlock.type === "tool_use"
        ) {
          targetBlock.input += chunk.delta.partial_json ?? "";
        } else if (chunk.delta?.text) {
          targetBlock.text += chunk.delta.text;
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
        const usageData = chunk.usage ?? chunk.delta?.usage;
        if (usageData) {
          completeResponse.usage = {
            ...(completeResponse.usage ?? {}),
            ...usageData,
          };
        }
        break;
      }

      case "message_stop": {
        if (chunk.usage) {
          completeResponse.usage = {
            ...(completeResponse.usage ?? {}),
            ...chunk.usage,
          };
        }
        break;
      }
    }

    if (Logger.isDebugMode()) {
      span.addEvent("llm.content.completion.chunk", {
        "chunk.type": chunk.type,
      });
    }
  } catch (e) {
    Logger.error(
      "netra.instrumentation.anthropic: processStreamChunk error",
      e,
    );
  }
}

/**
 * Close out a streaming span: set response attributes, record duration, and end.
 */
export function finalizeStreamSpan(
  span: Span,
  completeResponse: Record<string, any>,
  startTime: number,
  code: SpanStatusCode,
): void {
  try {
    const endTime = Date.now();

    setResponseAttributes(span, {
      model: completeResponse.model,
      content: completeResponse.content,
      usage: completeResponse.usage,
      stop_reason: completeResponse.stop_reason,
    });

    span.setAttribute("llm.response.duration", (endTime - startTime) / 1000);
    span.setStatus({ code });
  } catch (e) {
    Logger.error(
      "netra.instrumentation.anthropic: finalizeStreamSpan error",
      e,
    );
  } finally {
    span.end();
  }
}

export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string,
): void {
  try {
    if (!span.isRecording()) {
      Logger.log("Span is not recording");
      return;
    }
    setBaseRequestAttributes(span, kwargs, requestType, "anthropic");
  } catch (e) {
    Logger.error(
      "netra.instrumentation.anthropic: setRequestAttributes error",
      e,
    );
  }
}

export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  try {
    if (!span.isRecording()) {
      Logger.log("Span is not recording");
      return;
    }
    if (response?.type === "message_batch") {
      span.setAttribute("status", response?.processing_status as string);
    }
    setBaseResponseAttributes(span, response);
  } catch (e) {
    Logger.error(
      "netra.instrumentation.anthropic: setResponseAttributes error",
      e,
    );
  }
}
