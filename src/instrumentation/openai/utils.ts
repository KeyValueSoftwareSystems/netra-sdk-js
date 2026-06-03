import { Span } from "@opentelemetry/api";
import {
  isDict,
  setRequestAttributes as setBaseRequestAttributes,
  setResponseAttributes as setBaseResponseAttributes,
} from "../utils";
import { Message, OpenAIRequestType } from "./types";


function isTraceContentEnabled(): boolean {
  const raw =
    process.env.TRACELOOP_TRACE_CONTENT ?? process.env.NETRA_TRACE_CONTENT ?? "";
  return ["1", "true"].includes(String(raw).toLowerCase());
}

function toContentString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildInputMessages(
  kwargs: Record<string, unknown>,
  requestType: OpenAIRequestType
): Message[] {
  const messages: Message[] = [];

  if (requestType === "chat") {
    const rawMessages = kwargs.messages;
    if (!Array.isArray(rawMessages)) return messages;
    for (const msg of rawMessages) {
      if (!isDict(msg)) continue;
      messages.push({
        role: String(msg.role ?? "user"),
        content: toContentString(msg.content ?? ""),
      });
    }
  } else if (requestType === "response") {
    if (kwargs.instructions !== undefined) {
      messages.push({ role: "system", content: String(kwargs.instructions) });
    }
    const input = kwargs.input;
    if (typeof input === "string") {
      messages.push({ role: "user", content: input });
    } else if (Array.isArray(input)) {
      for (const msg of input) {
        if (!isDict(msg)) continue;
        messages.push({
          role: String(msg.role ?? "user"),
          content: toContentString(msg.content ?? ""),
        });
      }
    }
  } else if (requestType === "embedding") {
    const input = kwargs.input ?? kwargs.inputs;
    if (input !== undefined) {
      messages.push({ role: "user", content: toContentString(input) });
    }
  }

  return messages;
}

function buildOutputMessages(response: Record<string, unknown>): Message[] {
  const messages: Message[] = [];

  // Chat completions API: choices[].message
  const choices = response.choices as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const message = choice.message as Record<string, unknown> | undefined;
      if (!message) continue;
      messages.push({
        role: String(message.role ?? "assistant"),
        content: toContentString(message.content ?? ""),
      });
      // Tool calls as additional assistant messages
      const toolCalls = message.tool_calls as
        | Array<Record<string, unknown>>
        | undefined;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const fn = tc.function as Record<string, unknown> | undefined;
          messages.push({
            role: "assistant",
            content: JSON.stringify({
              name: fn?.name ?? "",
              arguments: fn?.arguments ?? "",
            }),
          });
        }
      }
    }
  }

  // Responses API: output[].content[].text
  const output = response.output as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(output)) {
    for (const element of output) {
      const content = element.content as
        | Array<Record<string, unknown>>
        | undefined;
      if (!Array.isArray(content)) continue;
      for (const chunk of content) {
        if (chunk.text !== undefined) {
          messages.push({ role: "assistant", content: String(chunk.text) });
        }
      }
    }
  }

  return messages;
}

export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string
): void {
  if (!span.isRecording()) return;
  setBaseRequestAttributes(span, kwargs, requestType, "openai");
  if (kwargs.dimensions !== undefined) {
    span.setAttribute("gen_ai.request.dimensions", Number(kwargs.dimensions));
  }
}

export function setInputAttribute(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: OpenAIRequestType
): void {
  if (!span.isRecording() || !isTraceContentEnabled()) return;
  const messages = buildInputMessages(kwargs, requestType);
  if (messages.length > 0) {
    span.setAttribute("input", JSON.stringify(messages));
  }
}

export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>
): void {
  if (!span.isRecording()) return;
  setBaseResponseAttributes(span, response);
}

export function setOutputAttribute(
  span: Span,
  response: Record<string, unknown>
): void {
  if (!span.isRecording() || !isTraceContentEnabled()) return;
  const messages = buildOutputMessages(response);
  if (messages.length > 0) {
    span.setAttribute("output", JSON.stringify(messages));
  }
}
