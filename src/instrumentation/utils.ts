/**
 * Shared utility functions for instrumentation.
 * Handles setting OTel span attributes for LLM request/response tracing.
 */

import { Span, context } from "@opentelemetry/api";
import { Config } from "../config";
import { Logger } from "../logger";
import { SpanAttributes } from "./span-attributes";
/**
 * Controls where native traces are sent.
 *
 * - `"netra"` -- Replace the SDK's default processors so traces go
 *   only to Netra. If the SDK does not expose the required APIs, falls back
 *   to additive mode (both Netra and native) and logs a warning.
 * - `"netra-strict"` (default) -- Same replacement as `"netra"`, but if the SDK APIs
 *   are unavailable the processor is **not** registered at all, ensuring
 *   traces never reach native even at the cost of no tracing.
 * - `"both"` -- The Netra processor is added alongside the native defaults;
 *   traces go to both Netra and native.
 *
 * Can also be set via the `NATIVE_TRACING_MODE` environment
 * variable using the same string values.
 */
export type NativeTracingMode = "both" | "netra" | "netra-strict";

const VALID_NATIVE_TRACING_MODES = new Set<string>(["both", "netra", "netra-strict"]);

export function parseNativeTracingEnv(name: string): NativeTracingMode | undefined {
  const val = process.env[name];
  if (val === undefined || val === "") return undefined;
  if (VALID_NATIVE_TRACING_MODES.has(val)) return val as NativeTracingMode;
  return undefined;
}

// Suppression
const SUPPRESS_INSTRUMENTATION_KEY = Symbol("netra.suppress_instrumentation");

export function shouldSuppressInstrumentation(): boolean {
  const ctx = context.active();
  return ctx.getValue(SUPPRESS_INSTRUMENTATION_KEY) === true;
}

// Type Utilities
export function isPromise<T = unknown>(value: unknown): value is Promise<T> {
  return value instanceof Promise;
}

/**
 * Define a non-enumerable, writable, configurable property on `target`.
 * Used to hide OTel internals (spans, contexts) from JSON.stringify
 * while keeping them accessible to instance methods.
 */
export function defineHidden<T>(target: object, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export function isDict(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function modelAsDict(obj: unknown): Record<string, unknown> {
  if (obj == null || typeof obj !== "object") return {};

  if (
    "toJSON" in obj &&
    typeof (obj as { toJSON?: unknown }).toJSON === "function"
  ) {
    return (obj as { toJSON: () => unknown }).toJSON() as Record<
      string,
      unknown
    >;
  }

  if (Object.getPrototypeOf(obj) === Object.prototype) {
    return { ...(obj as Record<string, unknown>) };
  }

  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return {};
  }
}

/**
 * A normalized input or output message used for span attribute recording.
 * Providers can build TracedMessage[] using their own extraction logic and
 * pass it directly to writePromptAttributes / writeCompletionAttributes.
 */
export interface TracedMessage {
  role: string;
  content: string;
}

// Internal Helpers
function isTraceContentEnabled(): boolean {
  const raw =
    process.env.TRACELOOP_TRACE_CONTENT ??
    process.env.NETRA_TRACE_CONTENT ??
    "";
  return ["1", "true"].includes(String(raw).toLowerCase());
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, maxLen: number): string {
  if (!value || value.length <= maxLen) return value;
  return value.slice(0, maxLen) + "...(truncated)";
}

/**
 * Returns true if `value` represents meaningful content worth recording.
 * Guards against setting empty-string attributes on spans.
 */
export function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// Attribute Mapping (model params → span attributes)
const PARAM_ATTRIBUTE_MAP: Record<string, string> = {
  model: SpanAttributes.LLM_REQUEST_MODEL,
  temperature: SpanAttributes.LLM_REQUEST_TEMPERATURE,
  max_tokens: SpanAttributes.LLM_REQUEST_MAX_TOKENS,
  max_completion_tokens: SpanAttributes.LLM_REQUEST_MAX_TOKENS,
  max_output_tokens: SpanAttributes.LLM_REQUEST_MAX_TOKENS,
  max_tokens_to_sample: SpanAttributes.LLM_REQUEST_MAX_TOKENS,
  frequency_penalty: SpanAttributes.LLM_FREQUENCY_PENALTY,
  presence_penalty: SpanAttributes.LLM_PRESENCE_PENALTY,
  reasoning_effort: SpanAttributes.LLM_REQUEST_REASONING_EFFORT,
  stop: SpanAttributes.LLM_CHAT_STOP_SEQUENCES,
  stream: SpanAttributes.LLM_IS_STREAMING,
  top_p: SpanAttributes.LLM_REQUEST_TOP_P,
};

function setModelParams(span: Span, kwargs: Record<string, unknown>): void {
  for (const [key, attr] of Object.entries(PARAM_ATTRIBUTE_MAP)) {
    const value = kwargs[key];
    if (value !== undefined) {
      span.setAttribute(attr, value as any);
    }
  }
}

/**
 * Extracts input messages for OpenAI-compatible request shapes:
 *   - "chat": messages[] (standard Chat Completions API)
 *   - "response": instructions + input (Responses API)
 *   - everything else: prompt string or embedding input
 *
 * Google GenAI and other providers with different shapes should build their
 * own TracedMessage[] and call writePromptAttributes directly.
 */
export function buildInputMessages(
  kwargs: Record<string, unknown>,
  requestType: string,
): TracedMessage[] {
  const messages: TracedMessage[] = [];

  if (requestType === "chat") {
    if (hasContent(kwargs.system)) {
      const systemContent =
        typeof kwargs.system === "string"
          ? kwargs.system
          : safeStringify(kwargs.system);
      messages.push({ role: "system", content: systemContent });
    }

    const rawMessages = kwargs.messages;
    if (!Array.isArray(rawMessages)) return messages;
    for (const msg of rawMessages) {
      if (!isDict(msg)) continue;
      if (hasContent(msg.role) && hasContent(msg.content)) {
        messages.push({
          role: msg.role,
          content: safeStringify(msg.content),
        });
      }
    }
  } else if (requestType === "response") {
    if (hasContent(kwargs.instructions)) {
      messages.push({ role: "system", content: String(kwargs.instructions) });
    }
    const input = kwargs.input;
    if (typeof input === "string" && input.length > 0) {
      messages.push({ role: "user", content: input });
    } else if (Array.isArray(input)) {
      for (const msg of input) {
        if (!isDict(msg)) continue;
        if (hasContent(msg.role) && hasContent(msg.content)) {
          messages.push({
            role: msg.role,
            content: safeStringify(msg.content),
          });
        }
      }
    }
  } else if (kwargs.prompt !== undefined) {
    // Legacy single-prompt (e.g.,completions)
    const content = String(kwargs.prompt);
    if (content.length > 0) {
      messages.push({ role: "user", content });
    }
  } else {
    // Embeddings / genericinput
    const input = kwargs.input ?? kwargs.inputs;
    if (hasContent(input)) {
      const content = truncate(
        safeStringify(input),
        Config.CONVERSATION_MAX_LEN,
      );
      messages.push({ role: "user", content });
    }
  }

  return messages;
}

/**
 * Extracts output messages for OpenAI-compatible response shapes:
 *   - choices[].message (Chat Completions API) — with optional tool_calls
 *   - output[].content[].text (Responses API)
 *   - content[] text/tool_use blocks (Anthropic-style)
 *   - scalar output_text shorthand
 *
 * Skips messages with empty content to avoid polluting traces.
 */
export function buildOutputMessages(
  response: Record<string, unknown>,
): TracedMessage[] {
  const messages: TracedMessage[] = [];

  // Priority 1: Chat Completions API (choices[]) — mutually exclusive with all others.
  // A response carrying choices[] is definitively a Chat Completions response; stop here.
  if (Array.isArray(response.choices)) {
    for (const choice of response.choices as Array<Record<string, any>>) {
      const msg = choice.message ?? choice.delta;
      if (!msg) continue;

      if (hasContent(msg.role) && hasContent(msg.content)) {
        messages.push({ role: msg.role, content: String(msg.content) });
      }

      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined;
          messages.push({
            role: "tool",
            content: JSON.stringify({
              name: fn?.name ?? "",
              arguments: fn?.arguments ?? "",
            }),
          });
        }
      }
    }
    return messages;
  }

  // Priority 2: Responses API — output_text and/or output[].
  // output_text is a scalar shorthand that mirrors the text portions of output[].
  // When both are present, use output_text for text and output[] only for tool calls
  // to avoid duplicating the same text content.
  const hasOutputText =
    typeof response.output_text === "string" && response.output_text.length > 0;
  const hasOutputArray = Array.isArray(response.output);

  if (hasOutputText || hasOutputArray) {
    if (hasOutputText) {
      messages.push({
        role: "assistant",
        content: response.output_text as string,
      });
    }

    if (hasOutputArray) {
      for (const element of response.output as Array<Record<string, unknown>>) {
        if (!Array.isArray(element.content)) continue;
        for (const chunk of element.content as Array<Record<string, unknown>>) {
          // Only include text from output[] when output_text has not already covered it
          if (!hasOutputText && hasContent(chunk.text)) {
            messages.push({ role: "assistant", content: String(chunk.text) });
          }
          // Always capture tool_use blocks — output_text never contains these
          if (
            (chunk as any).type === "tool_use" &&
            (chunk as any).name
          ) {
            messages.push({
              role: "tool",
              content: JSON.stringify({
                name: (chunk as any).name,
                input: (chunk as any).input,
              }),
            });
          }
        }
      }
    }
    return messages;
  }

  // Priority 3: Anthropic-style content[] blocks — only reached when neither
  // Chat Completions nor Responses API fields are present.
  if (Array.isArray(response.content)) {
    for (const block of response.content as Array<any>) {
      if (block.type === "text" && hasContent(block.text)) {
        messages.push({ role: "assistant", content: String(block.text) });
      } else if (block.type === "tool_use" && block.name) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ name: block.name, input: block.input }),
        });
      }
    }
  }

  return messages;
}

/**
 * Writes a TracedMessage[] in two formats:
 *   1. gen_ai.prompt.{i}.role / gen_ai.prompt.{i}.content  (OTel GenAI conventions)
 *   2. "input" JSON blob (Netra dashboard attribute)
 */
export function writePromptAttributes(
  span: Span,
  messages: TracedMessage[],
): void {
  if (messages.length === 0) return;

  for (let i = 0; i < messages.length; i++) {
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${i}.role`,
      messages[i].role,
    );
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${i}.content`,
      messages[i].content,
    );
  }

  span.setAttribute("input", JSON.stringify(messages));
}

/**
 * Writes a TracedMessage[] in two formats:
 *   1. gen_ai.completion.{i}.role / gen_ai.completion.{i}.content  (OTel GenAI conventions)
 *   2. "output" JSON blob (Netra dashboard attribute)
 *
 * Tool-call blocks in the messages are also written to gen_ai.response.tool_calls.*.
 */
export function writeCompletionAttributes(
  span: Span,
  messages: TracedMessage[],
): void {
  if (messages.length === 0) return;

  let completionIdx = 0;

  for (const msg of messages) {
    if (msg.role === "tool") {
      // Tool entries are emitted as tool_call attributes, not completion entries
      try {
        const parsed = JSON.parse(msg.content) as Record<string, unknown>;
        const toolData = {
          name: parsed.name,
          id: parsed.id,
          input: parsed.input,
          arguments: parsed.arguments,
        };
        span.setAttribute(
          `gen_ai.response.completion.${completionIdx}.role`,
          "tool",
        );
        span.setAttribute(
          `gen_ai.response.completion.${completionIdx}.content`,
          JSON.stringify(toolData),
        );
        completionIdx++;
      } catch (error) {
        Logger.error("Error parsing tool content:", error);
      }
    } else {
      span.setAttribute(
        `${SpanAttributes.LLM_COMPLETIONS}.${completionIdx}.role`,
        msg.role,
      );
      span.setAttribute(
        `${SpanAttributes.LLM_COMPLETIONS}.${completionIdx}.content`,
        msg.content,
      );
      completionIdx++;
    }
  }

  span.setAttribute("output", JSON.stringify(messages));
}


// Request Attributes
export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string,
  system: string,
): void {
  if (!span.isRecording()) return;

  // Core identifiers
  span.setAttribute(SpanAttributes.LLM_REQUEST_TYPE, requestType);
  span.setAttribute(SpanAttributes.LLM_SYSTEM, system);

  if (kwargs.model) {
    span.setAttribute(SpanAttributes.LLM_REQUEST_MODEL, String(kwargs.model));
  }

  // Standard model parameters
  setModelParams(span, kwargs);

  // Reasoning config
  if (kwargs.reasoning !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_REQUEST_REASONING,
      JSON.stringify(kwargs.reasoning),
    );
  }

  // Content tracing — extract once, write in bothformats
  if (isTraceContentEnabled()) {
    const messages = buildInputMessages(kwargs, requestType);
    writePromptAttributes(span, messages);

    // Legacy: FIMsuffix
    if (kwargs.suffix !== undefined) {
      span.setAttribute(
        "llm.request.suffix",
        truncate(safeStringify(kwargs.suffix), Config.CONVERSATION_MAX_LEN),
      );
    }
  }
}

// Response Attributes
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  if (!span.isRecording()) return;

  // ResponseID
  if (response.id) {
    span.setAttribute("llm.response.id", String(response.id));
  }

  // Model
  const model = response.model || (response.response_metadata as any)?.model;
  if (model) {
    span.setAttribute(SpanAttributes.LLM_RESPONSE_MODEL, String(model));
  }

  // Tokenusage
  setUsageAttributes(span, response);

  // Finish reason (from firstchoice)
  setFinishReason(span, response);

  // Embeddingmetadata
  setEmbeddingResponseMeta(span, response);

  // Content tracing — extract once, write in bothformats
  if (isTraceContentEnabled()) {
    const messages = buildOutputMessages(response);
    writeCompletionAttributes(span, messages);
  }
}

// Response Sub-helpers
function setFinishReason(span: Span, response: Record<string, unknown>): void {
  const choices = response.choices as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(choices) || choices.length === 0) return;

  const reason = choices[0].finish_reason ?? choices[0].finishReason;
  if (reason) {
    span.setAttribute("gen_ai.response.finish_reason", String(reason));
    span.setAttribute("llm.response.finish_reason", String(reason));
  }
}

function setUsageAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  const usage = (response.usage ?? response.usage_metadata) as
    | Record<string, unknown>
    | undefined;
  if (!usage) return;

  const promptTokens = usage.prompt_tokens ?? usage.input_tokens;
  if (promptTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_PROMPT_TOKENS,
      Number(promptTokens),
    );
  }

  const completionTokens = usage.completion_tokens ?? usage.output_tokens;
  if (completionTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_COMPLETION_TOKENS,
      Number(completionTokens),
    );
  }

  const totalTokens = usage.total_tokens;
  if (totalTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_TOTAL_TOKENS,
      Number(totalTokens),
    );
  }

  const cacheTokens = (
    (usage.prompt_tokens_details ?? usage.input_tokens_details) as
      | { cached_tokens?: unknown }
      | undefined
  )?.cached_tokens;
  if (cacheTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_CACHE_READ_INPUT_TOKENS,
      Number(cacheTokens),
    );
  }

  const reasoningTokens = (
    (usage.completion_tokens_details ?? usage.output_tokens_details) as
      | { reasoning_tokens?: unknown }
      | undefined
  )?.reasoning_tokens;
  if (reasoningTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_REASONING_TOKENS,
      Number(reasoningTokens),
    );
  }
}

function setEmbeddingResponseMeta(
  span: Span,
  response: Record<string, unknown>,
): void {
  const data = response.data as Array<unknown> | undefined;
  if (!Array.isArray(data) || data.length === 0) return;

  span.setAttribute("llm.response.embedding_count", data.length);

  const firstItem = data[0] as Record<string, unknown>;
  const embedding = firstItem?.embedding as number[] | undefined;
  if (Array.isArray(embedding)) {
    span.setAttribute("llm.response.embedding_dimensions", embedding.length);
  }
}
