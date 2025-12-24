/**
 * Utility functions for OpenAI instrumentation
 */

import { Span, context } from "@opentelemetry/api";

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
 */
export function modelAsDict(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== "object") {
    return {};
  }

  // If it has a toJSON method (like OpenAI SDK responses), use it
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

/**
 * Set request attributes on span
 */
export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string
): void {
  span.setAttribute("llm.request.type", requestType);
  span.setAttribute("gen_ai.system", "openai");

  if (kwargs.model) {
    span.setAttribute("gen_ai.request.model", String(kwargs.model));
    span.setAttribute("llm.request.model", String(kwargs.model));
  }

  if (kwargs.temperature !== undefined) {
    span.setAttribute("gen_ai.request.temperature", Number(kwargs.temperature));
    span.setAttribute("llm.request.temperature", Number(kwargs.temperature));
  }

  if (kwargs.max_tokens !== undefined) {
    span.setAttribute("gen_ai.request.max_tokens", Number(kwargs.max_tokens));
    span.setAttribute("llm.request.max_tokens", Number(kwargs.max_tokens));
  }

  if (kwargs.top_p !== undefined) {
    span.setAttribute("gen_ai.request.top_p", Number(kwargs.top_p));
    span.setAttribute("llm.request.top_p", Number(kwargs.top_p));
  }

  if (kwargs.frequency_penalty !== undefined) {
    span.setAttribute("llm.request.frequency_penalty", Number(kwargs.frequency_penalty));
  }

  if (kwargs.presence_penalty !== undefined) {
    span.setAttribute("llm.request.presence_penalty", Number(kwargs.presence_penalty));
  }

  if (kwargs.stream !== undefined) {
    span.setAttribute("llm.request.stream", Boolean(kwargs.stream));
  }

  // For embeddings
  if (kwargs.input !== undefined) {
    if (Array.isArray(kwargs.input)) {
      span.setAttribute("llm.request.input_count", kwargs.input.length);
    } else {
      span.setAttribute("llm.request.input_count", 1);
    }
  }

  // For chat - message count
  if (Array.isArray(kwargs.messages)) {
    span.setAttribute("llm.request.message_count", kwargs.messages.length);
  }
}

/**
 * Set response attributes on span
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

  // Handle usage
  const usage = response.usage as Record<string, unknown> | undefined;
  if (usage) {
    if (usage.prompt_tokens !== undefined) {
      span.setAttribute("gen_ai.usage.prompt_tokens", Number(usage.prompt_tokens));
      span.setAttribute("llm.usage.prompt_tokens", Number(usage.prompt_tokens));
    }
    if (usage.completion_tokens !== undefined) {
      span.setAttribute("gen_ai.usage.completion_tokens", Number(usage.completion_tokens));
      span.setAttribute("llm.usage.completion_tokens", Number(usage.completion_tokens));
    }
    if (usage.total_tokens !== undefined) {
      span.setAttribute("gen_ai.usage.total_tokens", Number(usage.total_tokens));
      span.setAttribute("llm.usage.total_tokens", Number(usage.total_tokens));
    }
    // For responses API
    if (usage.input_tokens !== undefined) {
      span.setAttribute("gen_ai.usage.input_tokens", Number(usage.input_tokens));
      span.setAttribute("llm.usage.input_tokens", Number(usage.input_tokens));
    }
    if (usage.output_tokens !== undefined) {
      span.setAttribute("gen_ai.usage.output_tokens", Number(usage.output_tokens));
      span.setAttribute("llm.usage.output_tokens", Number(usage.output_tokens));
    }
  }

  // Handle choices
  const choices = response.choices as Array<Record<string, unknown>> | undefined;
  if (choices && choices.length > 0) {
    const firstChoice = choices[0];
    if (firstChoice.finish_reason) {
      span.setAttribute("gen_ai.response.finish_reason", String(firstChoice.finish_reason));
      span.setAttribute("llm.response.finish_reason", String(firstChoice.finish_reason));
    }
  }

  // For embeddings
  const data = response.data as Array<unknown> | undefined;
  if (data) {
    span.setAttribute("llm.response.embedding_count", data.length);
  }
}

