/**
 * Shared utility functions for instrumentation
 * These functions can be reused across different provider instrumentations
 */

import { Span, context } from "@opentelemetry/api";
import { Config } from "../config";

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
 * Convert a model/response object to a plain dictionary
 * Works with SDK response objects that have toJSON methods or plain objects
 */
export function modelAsDict(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== "object") {
    return {};
  }

  // If it has a toJSON method (like SDK responses), use it
  if ("toJSON" in obj && typeof (obj as any).toJSON === "function") {
    return (obj as any).toJSON();
  }

  // If it's already a plain object, return a shallow copy
  if (obj.constructor === Object) {
    return { ...obj } as Record<string, unknown>;
  }

  // Try to convert class instance to plain object
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
  const choices = response.choices as Array<Record<string, unknown>> | undefined;
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
    const content = firstOut.content as Array<Record<string, unknown>> | undefined;
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
  span.setAttribute("llm.request.type", requestType);
  span.setAttribute("gen_ai.system", system);

  if (kwargs.model) {
    span.setAttribute("gen_ai.request.model", String(kwargs.model));
    span.setAttribute("llm.request.model", String(kwargs.model));
  }

  // Temperature (handle both snake_case and camelCase)
  const temperature = kwargs.temperature;
  if (temperature !== undefined && temperature !== null) {
    span.setAttribute("gen_ai.request.temperature", Number(temperature));
    span.setAttribute("llm.request.temperature", Number(temperature));
  }

  // Max tokens (handle both max_tokens and maxTokens)
  const maxTokens = kwargs.max_tokens ?? kwargs.maxTokens;
  if (maxTokens !== undefined && maxTokens !== null) {
    span.setAttribute("gen_ai.request.max_tokens", Number(maxTokens));
    span.setAttribute("llm.request.max_tokens", Number(maxTokens));
  }

  // Top P (handle both top_p and topP)
  const topP = kwargs.top_p ?? kwargs.topP;
  if (topP !== undefined) {
    span.setAttribute("gen_ai.request.top_p", Number(topP));
    span.setAttribute("llm.request.top_p", Number(topP));
  }

  // Frequency penalty (handle both snake_case and camelCase)
  const frequencyPenalty = kwargs.frequency_penalty ?? kwargs.frequencyPenalty;
  if (frequencyPenalty !== undefined) {
    span.setAttribute("llm.request.frequency_penalty", Number(frequencyPenalty));
  }

  // Presence penalty (handle both snake_case and camelCase)
  const presencePenalty = kwargs.presence_penalty ?? kwargs.presencePenalty;
  if (presencePenalty !== undefined) {
    span.setAttribute("llm.request.presence_penalty", Number(presencePenalty));
  }

  // Stream flag
  if (kwargs.stream !== undefined) {
    span.setAttribute("llm.request.stream", Boolean(kwargs.stream));
  }

  // Message count (for chat requests)
  if (Array.isArray(kwargs.messages)) {
    span.setAttribute("llm.request.message_count", kwargs.messages.length);
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

  // Tools count
  if (Array.isArray(kwargs.tools) && kwargs.tools.length > 0) {
    span.setAttribute("gen_ai.request.tools_count", kwargs.tools.length);
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
    const maxLen = Config.CONVERSATION_MAX_LEN;

    if (Array.isArray(kwargs.messages)) {
      const promptJson = truncateAttribute(safeStringify(kwargs.messages), maxLen);
      span.setAttribute("gen_ai.prompt", promptJson);
      span.setAttribute("llm.request.messages", promptJson);
    } else if (kwargs.prompt !== undefined) {
      const prompt = truncateAttribute(safeStringify(kwargs.prompt), maxLen);
      span.setAttribute("gen_ai.prompt", prompt);
      span.setAttribute("llm.request.prompt", prompt);
    } else {
      // Embeddings / generic inputs
      const content = kwargs.input ?? kwargs.inputs;
      if (content !== undefined) {
        const prompt = truncateAttribute(safeStringify(content), maxLen);
        span.setAttribute("gen_ai.prompt", prompt);
        span.setAttribute("llm.request.input", prompt);
      }
    }

    // FIM suffix (if present)
    if (kwargs.suffix !== undefined) {
      const suffix = truncateAttribute(safeStringify(kwargs.suffix), maxLen);
      span.setAttribute("llm.request.suffix", suffix);
    }
  }
}

/**
 * Set response attributes on span
 * These are shared across different LLM providers
 */
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>
): void {
  if (response.id) {
    span.setAttribute("gen_ai.response.id", String(response.id));
    span.setAttribute("llm.response.id", String(response.id));
  }

  if (response.model) {
    span.setAttribute("gen_ai.response.model", String(response.model));
    span.setAttribute("llm.response.model", String(response.model));
  }

  // Handle usage - support both snake_case and camelCase
  const usage = response.usage as Record<string, unknown> | undefined;
  if (usage) {
    // Prompt tokens (snake_case or camelCase)
    const promptTokens = usage.prompt_tokens ?? usage.promptTokens;
    if (promptTokens !== undefined) {
      span.setAttribute("gen_ai.usage.prompt_tokens", Number(promptTokens));
      span.setAttribute("llm.usage.prompt_tokens", Number(promptTokens));
    }

    // Completion tokens (snake_case or camelCase)
    const completionTokens = usage.completion_tokens ?? usage.completionTokens;
    if (completionTokens !== undefined) {
      span.setAttribute("gen_ai.usage.completion_tokens", Number(completionTokens));
      span.setAttribute("llm.usage.completion_tokens", Number(completionTokens));
    }

    // Total tokens (snake_case or camelCase)
    const totalTokens = usage.total_tokens ?? usage.totalTokens;
    if (totalTokens !== undefined) {
      span.setAttribute("gen_ai.usage.total_tokens", Number(totalTokens));
      span.setAttribute("llm.usage.total_tokens", Number(totalTokens));
    }

    // Input/output tokens (for responses API)
    if (usage.input_tokens !== undefined) {
      span.setAttribute("gen_ai.usage.input_tokens", Number(usage.input_tokens));
      span.setAttribute("llm.usage.input_tokens", Number(usage.input_tokens));
    }
    if (usage.output_tokens !== undefined) {
      span.setAttribute("gen_ai.usage.output_tokens", Number(usage.output_tokens));
      span.setAttribute("llm.usage.output_tokens", Number(usage.output_tokens));
    }
  }

  // Handle choices - support both snake_case and camelCase finish reason
  const choices = response.choices as Array<Record<string, unknown>> | undefined;
  if (choices && choices.length > 0) {
    const firstChoice = choices[0];
    const finishReason = firstChoice.finish_reason ?? firstChoice.finishReason;
    if (finishReason) {
      span.setAttribute("gen_ai.response.finish_reason", String(finishReason));
      span.setAttribute("llm.response.finish_reason", String(finishReason));
    }
  }

  // Content tracing (guarded by config/env)
  if (isTraceContentEnabled()) {
    const completion = extractFirstCompletionText(response);
    if (completion) {
      const maxLen = Config.CONVERSATION_MAX_LEN;
      const value = truncateAttribute(String(completion), maxLen);
      span.setAttribute("gen_ai.completion", value);
      span.setAttribute("llm.response.completion", value);
    }
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
        span.setAttribute("llm.response.embedding_dimensions", embedding.length);
      }
    }
  }
}

