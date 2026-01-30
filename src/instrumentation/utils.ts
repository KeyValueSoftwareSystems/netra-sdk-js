/**
 * Shared utility functions for instrumentation
 * These functions can be reused across different provider instrumentations
 */

import { Span, context } from "@opentelemetry/api";
import { Config } from "../config";
import { SpanAttributes } from "./span-attributes";

// Suppression key for instrumentation
const SUPPRESS_INSTRUMENTATION_KEY = Symbol("netra.suppress_instrumentation");

/**
 * Check if instrumentation should be suppressed
 */
export function shouldSuppressInstrumentation(): boolean {
  const ctx = context.active();
  return ctx.getValue(SUPPRESS_INSTRUMENTATION_KEY) === true;
}

/**
 * Type guard that determines whether a value is a Promise.
 *
 * This is useful for distinguishing between synchronous return values
 * and Promise-based (asynchronous) results at runtime.
 *
 * @param value - The value to test.
 * @returns `true` if the value is a Promise instance.
 */
export function isPromise<T = unknown>(value: unknown): value is Promise<T> {
  return value instanceof Promise;
}

/**
 * Determines whether a value is a plain json object.
 *
 * This intended for validating JSON-style objects at runtime
 *
 * Excludes:
 * - `null`
 * - Arrays
 *
 * @param v - The value to test.
 * @returns `true` if the value is a non-null, non-array object.
 */
export function isDict(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Converts a model or response value into a plain dictionary object.
 *
 * This utility is intended for normalizing SDK models, class instances,
 * or arbitrary values into a JSON-compatible key–value structure suitable
 * for logging, tracing, or serialization.
 *
 * Conversion strategy (in order):
 * 1. Non-objects return an empty object.
 * 2. Objects with a `toJSON()` method use its output.
 * 3. Plain objects are shallow-copied.
 * 4. Other objects are serialized via `JSON.stringify` / `JSON.parse`.
 *
 * If conversion fails, an empty object is returned.
 *
 * @param obj - The value to convert.
 * @returns A plain dictionary representation of the input.
 */
export function modelAsDict(obj: unknown): Record<string, unknown> {
  if (obj == null || typeof obj !== "object") {
    return {};
  }

  // Prefer explicit JSON serialization when available
  if (
    "toJSON" in obj &&
    typeof (obj as { toJSON?: unknown }).toJSON === "function"
  ) {
    return (obj as { toJSON: () => unknown }).toJSON() as Record<
      string,
      unknown
    >;
  }

  // Fast path for plain objects
  if (Object.getPrototypeOf(obj) === Object.prototype) {
    return { ...(obj as Record<string, unknown>) };
  }

  // Fallback: attempt structural serialization
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return {};
  }
}

function isTraceContentEnabled(): boolean {
  const raw =
    process.env.TRACELOOP_TRACE_CONTENT ??
    process.env.NETRA_TRACE_CONTENT ??
    "";
  return ["1", "true"].includes(String(raw).toLowerCase());
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateAttribute(value: string, maxLen: number): string {
  if (!value) return value;
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + "...(truncated)";
}

function extractFirstCompletionText(
  response: Record<string, unknown>
): string | undefined {
  // Common: choices[0].message.content (chat) or choices[0].text (completion)
  const choices = response.choices as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    const message = first.message as Record<string, unknown> | undefined;
    if (message && message.content !== undefined) {
      return String(message.content);
    }
    if (first.text !== undefined) {
      return String(first.text);
    }
  }

  // Mistral/OpenAI response-like variants
  if (response.output_text !== undefined) {
    return String(response.output_text);
  }

  // Responses API style: output[].content[].text
  const output = response.output as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(output) && output.length > 0) {
    const firstOut = output[0];
    const content = firstOut.content as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(content) && content.length > 0) {
      const firstContent = content[0];
      if (firstContent.text !== undefined) {
        return String(firstContent.text);
      }
    }
  }

  return undefined;
}

/**
 * Set request attributes on span
 * These are shared across different LLM providers
 */
export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string,
  system: string
): void {
  if (!span.isRecording()) {
    console.log("Span is not recording");
    return;
  }

  span.setAttribute(SpanAttributes.LLM_REQUEST_TYPE, requestType);
  span.setAttribute(SpanAttributes.LLM_SYSTEM, system);

  if (kwargs.model) {
    span.setAttribute("gen_ai.request.model", String(kwargs.model));
    span.setAttribute("llm.request.model", String(kwargs.model));
  }

  _setAttributeMappings(span, kwargs);

  if (Array.isArray(kwargs.messages)) {
    span.setAttribute("llm.request.message_count", kwargs.messages.length);
  }

  if (kwargs.reasoning !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_REQUEST_REASONING_EFFORT,
      JSON.stringify(kwargs.reasoning)
    );
  }

  // Input count (for embeddings - handle both input and inputs)
  const inputs = kwargs.input ?? kwargs.inputs;
  if (inputs !== undefined) {
    if (Array.isArray(inputs)) {
      span.setAttribute("llm.request.input_count", inputs.length);
    } else {
      span.setAttribute("llm.request.input_count", 1);
    }
  }

  // Tools count and definitions
  if (Array.isArray(kwargs.tools) && kwargs.tools.length > 0) {
    span.setAttribute("gen_ai.request.tools_count", kwargs.tools.length);

    // Add individual tool definitions
    kwargs.tools.forEach((tool: any, index: number) => {
      if (tool.name) {
        span.setAttribute(`gen_ai.request.tools.${index}.name`, tool.name);
      }
      if (tool.description) {
        span.setAttribute(`gen_ai.request.tools.${index}.description`, tool.description);
      }
      if (tool.input_schema) {
        span.setAttribute(
          `gen_ai.request.tools.${index}.input_schema`,
          JSON.stringify(tool.input_schema)
        );
      }
    });
  }

  // Tool choice (handle both snake_case and camelCase)
  const toolChoice = kwargs.tool_choice ?? kwargs.toolChoice;
  if (toolChoice !== undefined) {
    span.setAttribute(
      "gen_ai.request.tool_choice",
      typeof toolChoice === "string" ? toolChoice : JSON.stringify(toolChoice)
    );
  }

  // Content tracing (guarded by config/env)
  if (isTraceContentEnabled()) {
    if (requestType === "chat") {
      _setChatCompletionAPIAttributes(span, kwargs);
    } else if (requestType === "response") {
      _setResponseAPIAttributes(span, kwargs);
    } else if (kwargs.prompt !== undefined) {
      span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.0.role`, "user");
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.0.content`,
        String(kwargs.prompt)
      );
    } else {
      // Handles Embeddings / generic inputs
      const content = kwargs.input ?? kwargs.inputs;
      if (content !== undefined) {
        const prompt = truncateAttribute(
          safeStringify(content),
          Config.CONVERSATION_MAX_LEN
        );
        span.setAttribute("gen_ai.prompt", prompt);
        span.setAttribute("llm.request.input", prompt);
      }
    }

    // FIM suffix (if present)
    if (kwargs.suffix !== undefined) {
      const suffix = truncateAttribute(
        safeStringify(kwargs.suffix),
        Config.CONVERSATION_MAX_LEN
      );
      span.setAttribute("llm.request.suffix", suffix);
    }
  }
}

function _setAttributeMappings(span: Span, kwargs: Record<string, unknown>) {
  const attributeMappings = {
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

  for (let [key, attribute] of Object.entries(attributeMappings)) {
    const value: any = kwargs[key];
    if (value !== undefined) {
      span.setAttribute(attribute, value);
    }
  }
}

function _setChatCompletionAPIAttributes(
  span: Span,
  kwargs: Record<string, unknown>
) {
  const messages = kwargs.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isDict(message)) {
      continue;
    }
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${i}.role`,
      message?.role ?? "user"
    );

    // Handle content - can be string or array
    const content = message?.content;
    if (typeof content === 'string') {
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${i}.content`,
        content
      );
    } else if (Array.isArray(content)) {
      // Handle array content (tool results, multimodal content, etc.)
      content.forEach((block: any, blockIndex: number) => {
        if (block.type === 'tool_result') {
          span.setAttribute(
            `${SpanAttributes.LLM_PROMPTS}.${i}.tool_result.${blockIndex}.tool_use_id`,
            block.tool_use_id
          );
          span.setAttribute(
            `${SpanAttributes.LLM_PROMPTS}.${i}.tool_result.${blockIndex}.content`,
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          );
        } else if (block.type === 'text') {
          span.setAttribute(
            `${SpanAttributes.LLM_PROMPTS}.${i}.content.${blockIndex}`,
            block.text || ''
          );
        }
      });
    } else {
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${i}.content`,
        String(content ?? "")
      );
    }
  }
}

function _setResponseAPIAttributes(
  span: Span,
  kwargs: Record<string, unknown>
) {
  let messageIndex = 0;
  if (kwargs.instructions !== undefined) {
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${messageIndex}.role`,
      "system"
    );
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${messageIndex}.content`,
      kwargs.instructions as any
    );
    messageIndex++;
  }

  const inputData = kwargs.input;
  if (inputData !== undefined) {
    if (typeof inputData === "string") {
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${messageIndex}.role`,
        "user"
      );
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${messageIndex}.content`,
        inputData
      );
    } else if (Array.isArray(inputData)) {
      for (let message of inputData) {
        if (!isDict(message)) {
          continue;
        }
        span.setAttribute(
          `${SpanAttributes.LLM_PROMPTS}.${messageIndex}.role`,
          message?.role ?? "user"
        );
        span.setAttribute(
          `${SpanAttributes.LLM_PROMPTS}.${messageIndex}.content`,
          String(message?.content ?? "")
        );
      }
    }
  }
}

/**
 * Set response attributes on span
 * These are shared across different LLM providers
 */
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  if (!span.isRecording()) {
    console.log("Span is not recording");
    return;
  }

  if (response.id) {
    span.setAttribute("llm.response.id", String(response.id));
  }

  const model = response?.model || (response?.response_metadata as any)?.model;
  if (model) {
    span.setAttribute(SpanAttributes.LLM_RESPONSE_MODEL, String(model));
  }

  _setUsageAttributes(span, response);

  const choices = response.choices as
    | Array<Record<string, unknown>>
    | undefined;
  if (choices && choices.length > 0) {
    const firstChoice = choices[0];
    const finishReason = firstChoice.finish_reason ?? firstChoice.finishReason;
    if (finishReason) {
      span.setAttribute("gen_ai.response.finish_reason", String(finishReason));
      span.setAttribute("llm.response.finish_reason", String(finishReason));
    }
  }

  if (isTraceContentEnabled()) {
    _setResponseMessageAttributes(span, response);
  }

  // For embeddings - handle data array
  const data = response.data as Array<unknown> | undefined;
  if (data) {
    span.setAttribute("llm.response.embedding_count", data.length);
    // Get embedding dimensions from first item if available
    if (data.length > 0) {
      const firstItem = data[0] as Record<string, unknown>;
      const embedding = firstItem.embedding as number[] | undefined;
      if (embedding && Array.isArray(embedding)) {
        span.setAttribute(
          "llm.response.embedding_dimensions",
          embedding.length
        );
      }
    }
  }
}

function _setUsageAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  if (!response.usage && !response.usage_metadata) return;

  const usage = (response.usage ?? response.usage_metadata) as Record<
    string,
    unknown
  >;

  const promptTokens = usage.prompt_tokens ?? usage.input_tokens;
  if (promptTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_PROMPT_TOKENS,
      Number(promptTokens)
    );
  }

  const completionTokens = usage.completion_tokens ?? usage.output_tokens;
  if (completionTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_COMPLETION_TOKENS,
      Number(completionTokens)
    );
  }

  const totalTokens = usage.total_tokens;
  if (totalTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_TOTAL_TOKENS,
      Number(totalTokens)
    );
  }

  const cacheTokens = (
    (usage.prompt_tokens_details ?? usage.input_tokens_details) as {
      cached_tokens?: unknown;
    }
  )?.cached_tokens;
  if (cacheTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_CACHE_READ_INPUT_TOKENS,
      Number(cacheTokens)
    );
  }

  const reasoningTokens = (
    (usage.completion_tokens_details ?? usage.output_tokens_details) as {
      reasoning_tokens?: unknown;
    }
  )?.reasoning_tokens;
  if (reasoningTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_REASONING_TOKENS,
      Number(reasoningTokens)
    );
  }
}

function _setResponseMessageAttributes(
  span: Span,
  response: Record<string, unknown>
): void {
  let messageIndex = 0;
  const messageContent = response.output_text ?? response.content;
  if (messageContent) {
    span.setAttribute(
      `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.role`,
      "assistant"
    );
    span.setAttribute(
      `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.content`,
      String(messageContent)
    );
  }

  if (response.content && Array.isArray(response.content)) {
      let toolCallIndex = 0;
      response.content.forEach((contentBlock: any) => {
        if (contentBlock.type === 'text' && contentBlock.text) {
          span.setAttribute(
            `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.role`,
            "assistant"
          );
          span.setAttribute(
            `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.content`,
            String(contentBlock.text)
          );
          messageIndex += 1;
        } else if (contentBlock.type === 'tool_use') {
          // Capture tool use information
          span.setAttribute(
            `gen_ai.response.tool_calls.${toolCallIndex}.name`,
            contentBlock.name
          );
          span.setAttribute(
            `gen_ai.response.tool_calls.${toolCallIndex}.id`,
            contentBlock.id
          );
          span.setAttribute(
            `gen_ai.response.tool_calls.${toolCallIndex}.input`,
            JSON.stringify(contentBlock.input)
          );
          toolCallIndex += 1;
        }
      });

      // Set total tool calls count if any
      if (toolCallIndex > 0) {
        span.setAttribute("gen_ai.response.tool_calls_count", toolCallIndex);
      }
    }

  if (response.output !== undefined) {
    for (let element of response.output as Array<Record<string, unknown>>) {
      if (element.content === undefined) continue;
      for (let chunk of element.content as Array<Record<string, unknown>>) {
        if (chunk.text === undefined) continue;
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.role`,
          "assistant"
        );
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.content`,
          String(chunk.text)
        );
        messageIndex += 1;
      }
    }
  }

  // Handle choices
  const choices = response.choices as Array<Record<string, any>> | undefined;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const message = choice.message;
      if (message !== undefined) {
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.role`,
          message.role ?? "assistant"
        );
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.content`,
          String(message.content ?? "")
        );
        messageIndex++;
      } else {
        const delta = choice.delta;
        if (delta !== undefined) {
          span.setAttribute(
            `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.role`,
            delta.role ?? "assistant"
          );
          span.setAttribute(
            `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.content`,
            String(delta.content ?? "")
          );
          messageIndex++;
        }
      }
    }
  }
}
