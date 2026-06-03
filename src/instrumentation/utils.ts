/**
 * Shared utility functions for instrumentation.
 * Handles setting OTel span attributes for LLM request/response tracing.
 */

import { Span, context } from "@opentelemetry/api";
import { Config } from "../config";
import { SpanAttributes } from "./span-attributes";

const SUPPRESS_INSTRUMENTATION_KEY = Symbol("netra.suppress_instrumentation");

export function shouldSuppressInstrumentation(): boolean {
  const ctx = context.active();
  return ctx.getValue(SUPPRESS_INSTRUMENTATION_KEY) === true;
}

export function isPromise<T = unknown>(value: unknown): value is Promise<T> {
  return value instanceof Promise;
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
function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

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

  // Content tracing (guarded by config/env)
  if (isTraceContentEnabled()) {
    setPromptContent(span, kwargs, requestType);
  }
}

function setPromptContent(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string,
): void {
  if (requestType === "chat") {
    setChatPromptAttributes(span, kwargs);
  } else if (requestType === "response") {
    setResponsesApiPromptAttributes(span, kwargs);
  } else if (kwargs.prompt !== undefined) {
    setSinglePromptAttribute(span, kwargs);
  } else {
    setEmbeddingPromptAttribute(span, kwargs);
  }
}

/**
 * Chat Completions API: messages[] → gen_ai.prompt.{i}.role / .content
 */
function setChatPromptAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
): void {
  const messages = kwargs.messages;
  if (!Array.isArray(messages)) return;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isDict(msg)) continue;

    if (!hasContent(msg.role) || !hasContent(msg.content)) {
      continue;
    }

    const content = msg.content;
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${i}.role`, msg.role);
    if (typeof content === "string") {
      span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${i}.content`, content);
    } else if (Array.isArray(content)) {
      setArrayContentBlocks(span, i, content);
    } else {
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${i}.content`,
        JSON.stringify(content),
      );
    }
  }
}

/**
 * Handles multimodal/tool_result content blocks within a single message.
 */
function setArrayContentBlocks(
  span: Span,
  messageIndex: number,
  blocks: Array<any>,
): void {
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    if (block.type === "tool_result") {
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${messageIndex}.tool_result.${b}.tool_use_id`,
        block.tool_use_id,
      );
      if (hasContent(block.content)) {
        span.setAttribute(
          `${SpanAttributes.LLM_PROMPTS}.${messageIndex}.tool_result.${b}.content`,
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content),
        );
      }
    } else if (block.type === "text" && hasContent(block.text)) {
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${messageIndex}.content.${b}`,
        block.text,
      );
    }
  }
}

/**
 * Responses API: instructions + input → gen_ai.prompt.{i}.*
 */
function setResponsesApiPromptAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
): void {
  let idx = 0;

  if (hasContent(kwargs.instructions)) {
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${idx}.role`, "system");
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${idx}.content`,
      String(kwargs.instructions),
    );
    idx++;
  }

  const input = kwargs.input;
  if (typeof input === "string" && input.length > 0) {
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${idx}.role`, "user");
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${idx}.content`, input);
  } else if (Array.isArray(input)) {
    for (const msg of input) {
      if (!isDict(msg)) continue;
      const content = msg.content;
      if (!hasContent(content)) continue;
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${idx}.role`,
        msg.role ?? "user",
      );
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${idx}.content`,
        safeStringify(content),
      );
      idx++;
    }
  }
}

/**
 * Simple single-prompt case (e.g., legacy completions).
 */
function setSinglePromptAttribute(
  span: Span,
  kwargs: Record<string, unknown>,
): void {
  const content = String(kwargs.prompt);
  if (content.length === 0) return;
  span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.0.role`, "user");
  span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.0.content`, content);
}

/**
 * Embedding input as a single prompt attribute.
 */
function setEmbeddingPromptAttribute(
  span: Span,
  kwargs: Record<string, unknown>,
): void {
  const content = kwargs.input ?? kwargs.inputs;
  if (!hasContent(content)) return;
  const prompt = truncate(safeStringify(content), Config.CONVERSATION_MAX_LEN);
  span.setAttribute(SpanAttributes.LLM_PROMPTS, prompt);
  span.setAttribute("llm.request.input", prompt);
}

export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  if (!span.isRecording()) return;

  // Response ID
  if (response.id) {
    span.setAttribute("llm.response.id", String(response.id));
  }

  // Model
  const model = response.model || (response.response_metadata as any)?.model;
  if (model) {
    span.setAttribute(SpanAttributes.LLM_RESPONSE_MODEL, String(model));
  }

  // Token usage
  setUsageAttributes(span, response);

  // Finish reason (from first choice)
  setFinishReason(span, response);

  // Completion content (guarded)
  if (isTraceContentEnabled()) {
    setCompletionContent(span, response);
  }

  // Embedding metadata
  setEmbeddingResponseMeta(span, response);
}

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

/**
 * Populates gen_ai.completion.{i}.role and .content from the response.
 * Handles three response shapes:
 *   1. Scalar output_text (Responses API shorthand)
 *   2. Array content blocks (Anthropic-style / Responses API output[])
 *   3. Choices array (Chat Completions API)
 *
 * Skips setting attributes when content is empty to avoid polluting traces.
 */
function setCompletionContent(
  span: Span,
  response: Record<string, unknown>,
): void {
  let idx = 0;

  // 1. Scalar output_text (highest priority, single completion)
  if (
    typeof response.output_text === "string" &&
    response.output_text.length > 0
  ) {
    span.setAttribute(
      `${SpanAttributes.LLM_COMPLETIONS}.${idx}.role`,
      "assistant",
    );
    span.setAttribute(
      `${SpanAttributes.LLM_COMPLETIONS}.${idx}.content`,
      response.output_text,
    );
    idx++;
  }

  // 2. Array content blocks (e.g., Anthropic response.content)
  if (Array.isArray(response.content)) {
    idx = setContentBlockCompletions(span, response.content, idx);
  }

  // 3. Responses API: output[].content[]
  if (Array.isArray(response.output)) {
    for (const element of response.output as Array<Record<string, unknown>>) {
      if (!Array.isArray(element.content)) continue;
      for (const chunk of element.content as Array<Record<string, unknown>>) {
        if (!hasContent(chunk.text)) continue;
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${idx}.role`,
          "assistant",
        );
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${idx}.content`,
          String(chunk.text),
        );
        idx++;
      }
    }
  }

  // 4. Chat Completions API: choices[]
  const choices = response.choices as Array<Record<string, any>> | undefined;
  if (Array.isArray(choices)) {
    idx = setChoiceCompletions(span, choices, idx);
  }
}

/**
 * Processes array-style content blocks (text + tool_use).
 */
function setContentBlockCompletions(
  span: Span,
  content: Array<any>,
  startIdx: number,
): number {
  let idx = startIdx;
  let toolCallIndex = 0;

  for (const block of content) {
    if (block.type === "text" && hasContent(block.text)) {
      span.setAttribute(
        `${SpanAttributes.LLM_COMPLETIONS}.${idx}.role`,
        "assistant",
      );
      span.setAttribute(
        `${SpanAttributes.LLM_COMPLETIONS}.${idx}.content`,
        String(block.text),
      );
      idx++;
    } else if (block.type === "tool_use") {
      span.setAttribute(
        `gen_ai.response.tool_calls.${toolCallIndex}.name`,
        block.name,
      );
      span.setAttribute(
        `gen_ai.response.tool_calls.${toolCallIndex}.id`,
        block.id,
      );
      span.setAttribute(
        `gen_ai.response.tool_calls.${toolCallIndex}.input`,
        JSON.stringify(block.input),
      );
      toolCallIndex++;
    }
  }

  if (toolCallIndex > 0) {
    span.setAttribute("gen_ai.response.tool_calls_count", toolCallIndex);
  }

  return idx;
}

/**
 * Processes Chat Completions API choices[].message or choices[].delta.
 * Only sets content when it is non-empty.
 */
function setChoiceCompletions(
  span: Span,
  choices: Array<Record<string, any>>,
  startIdx: number,
): number {
  let idx = startIdx;

  for (const choice of choices) {
    const msg = choice.message ?? choice.delta;
    if (!msg) continue;

    const content = msg.content;
    if (!hasContent(content)) continue;

    span.setAttribute(
      `${SpanAttributes.LLM_COMPLETIONS}.${idx}.role`,
      msg.role ?? "assistant",
    );
    span.setAttribute(
      `${SpanAttributes.LLM_COMPLETIONS}.${idx}.content`,
      String(content),
    );
    idx++;
  }

  return idx;
}
