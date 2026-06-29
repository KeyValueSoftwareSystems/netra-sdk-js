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

interface PendingToolCall {
  id: string;
  name: string;
  input: unknown;
  responseEndTime: number;
}

interface PendingToolCycle {
  parentContext: Context;
  toolCalls: PendingToolCall[];
  createdAt: number;
}

export interface ToolResultBlock {
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

const pendingToolCycles = new Map<string, PendingToolCycle>();
const TTL_MS = 5 * 60 * 1000;

function millisToHrTime(millis: number): [number, number] {
  const seconds = Math.floor(millis / 1000);
  const nanos = (millis % 1000) * 1_000_000;
  return [seconds, nanos];
}

function toolSafeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function evictStaleEntries(): void {
  const now = Date.now();
  for (const [key, cycle] of pendingToolCycles) {
    if (now - cycle.createdAt > TTL_MS) {
      pendingToolCycles.delete(key);
    }
  }
}

export function registerPendingToolCalls(
  traceId: string,
  parentContext: Context,
  toolUseBlocks: Array<Record<string, unknown>>,
  responseEndTime: number,
): void {
  evictStaleEntries();

  const toolCalls: PendingToolCall[] = toolUseBlocks.map((block) => ({
    id: String(block.id ?? ""),
    name: String(block.name ?? "unknown"),
    input: block.input,
    responseEndTime,
  }));

  pendingToolCycles.set(traceId, {
    parentContext,
    toolCalls,
    createdAt: Date.now(),
  });

  Logger.debug(
    `tool-call-tracker: registered ${toolCalls.length} pending tool calls for trace ${traceId}`,
  );
}

export function resolveToolCalls(
  traceId: string,
  tracer: Tracer,
  toolResults: ToolResultBlock[],
  requestStartTime: number,
): void {
  const cycle = pendingToolCycles.get(traceId);
  if (!cycle) return;

  pendingToolCycles.delete(traceId);

  const resultMap = new Map<string, ToolResultBlock>();
  for (const result of toolResults) {
    resultMap.set(result.tool_use_id, result);
  }

  for (const pending of cycle.toolCalls) {
    try {
      const toolSpan = tracer.startSpan(
        pending.name,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "netra.span.type": "TOOL",
            [SpanAttributes.LLM_REQUEST_TOOL_NAME]: pending.name,
            [SpanAttributes.LLM_REQUEST_TOOL_ID]: pending.id,
            input: toolSafeStringify(pending.input),
          },
        },
        cycle.parentContext,
      );

      const matched = resultMap.get(pending.id);
      if (matched) {
        toolSpan.setAttribute("output", toolSafeStringify(matched.content));
        if (matched.is_error) {
          toolSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: "Tool returned an error",
          });
        } else {
          toolSpan.setStatus({ code: SpanStatusCode.OK });
        }
      } else {
        toolSpan.setStatus({ code: SpanStatusCode.OK });
      }

      toolSpan.end(millisToHrTime(requestStartTime));
    } catch (error) {
      Logger.error(
        `tool-call-tracker: failed to create span for tool ${pending.name}:`,
        error,
      );
    }
  }

  Logger.debug(
    `tool-call-tracker: resolved ${cycle.toolCalls.length} tool calls for trace ${traceId}`,
  );
}

export function extractToolResults(
  messages: Array<Record<string, unknown>>,
): ToolResultBlock[] {
  const results: ToolResultBlock[] = [];
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === "tool_result" && block.tool_use_id) {
        results.push({
          tool_use_id: String(block.tool_use_id),
          content: block.content,
          is_error: block.is_error === true,
        });
      }
    }
  }
  return results;
}

export function clearPendingToolCycles(): void {
  pendingToolCycles.clear();
}

/**
 * If the outgoing request carries tool_result blocks, resolve the pending
 * tool cycle for the active trace — creating retroactive tool spans.
 */
export function resolveToolCycle(
  messages: unknown,
  tracer: Tracer,
): void {
  const activeSpan = trace.getSpan(context.active());
  const traceId = activeSpan?.spanContext().traceId;
  if (!traceId || !Array.isArray(messages)) return;

  const toolResults = extractToolResults(
    messages as Array<Record<string, unknown>>,
  );
  if (toolResults.length > 0) {
    resolveToolCalls(traceId, tracer, toolResults, Date.now());
  }
}

/**
 * If the LLM response has stop_reason === "tool_use", register the
 * tool_use blocks so the next request can create retroactive tool spans.
 */
export function registerToolCycle(
  response: Record<string, unknown>,
  span: Span,
  parentContext: Context,
  endTime: number,
): void {
  if (response.stop_reason !== "tool_use" || !Array.isArray(response.content))
    return;

  const toolUseBlocks = (
    response.content as Array<Record<string, unknown>>
  ).filter((b) => b.type === "tool_use");

  if (toolUseBlocks.length > 0) {
    registerPendingToolCalls(
      span.spanContext().traceId,
      parentContext,
      toolUseBlocks,
      endTime,
    );
  }
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
      if (chunk.delta?.usage) {
        completeResponse.usage = {
          ...(completeResponse.usage ?? {}),
          ...chunk.delta.usage,
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
 * Close out a streaming span: set response attributes, register any
 * pending tool cycle, record duration, and end the span.
 */
export function finalizeStreamSpan(
  span: Span,
  completeResponse: Record<string, any>,
  startTime: number,
  parentContext: any,
  code: SpanStatusCode,
): void {
  const endTime = Date.now();

  setResponseAttributes(span, {
    model: completeResponse.model,
    content: completeResponse.content,
    usage: completeResponse.usage,
    stop_reason: completeResponse.stop_reason,
  });

  registerToolCycle(completeResponse, span, parentContext, endTime);

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
