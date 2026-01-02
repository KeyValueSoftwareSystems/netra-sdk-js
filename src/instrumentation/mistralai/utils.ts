/**
 * Utility functions for MistralAI instrumentation
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

/**
 * Set request attributes on span for MistralAI
 */
export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string
): void {
  span.setAttribute("llm.request.type", requestType);
  span.setAttribute("gen_ai.system", "mistralai");

  if (kwargs.model) {
    span.setAttribute("gen_ai.request.model", String(kwargs.model));
    span.setAttribute("llm.request.model", String(kwargs.model));
  }

  // For agents - agentId is the identifier
  if (kwargs.agentId) {
    span.setAttribute("gen_ai.agent.id", String(kwargs.agentId));
    span.setAttribute("llm.agent.id", String(kwargs.agentId));
  }

  if (kwargs.temperature !== undefined && kwargs.temperature !== null) {
    span.setAttribute("gen_ai.request.temperature", Number(kwargs.temperature));
    span.setAttribute("llm.request.temperature", Number(kwargs.temperature));
  }

  if (kwargs.maxTokens !== undefined && kwargs.maxTokens !== null) {
    span.setAttribute("gen_ai.request.max_tokens", Number(kwargs.maxTokens));
    span.setAttribute("llm.request.max_tokens", Number(kwargs.maxTokens));
  }

  if (kwargs.topP !== undefined) {
    span.setAttribute("gen_ai.request.top_p", Number(kwargs.topP));
    span.setAttribute("llm.request.top_p", Number(kwargs.topP));
  }

  if (kwargs.frequencyPenalty !== undefined) {
    span.setAttribute("llm.request.frequency_penalty", Number(kwargs.frequencyPenalty));
  }

  if (kwargs.presencePenalty !== undefined) {
    span.setAttribute("llm.request.presence_penalty", Number(kwargs.presencePenalty));
  }

  if (kwargs.stream !== undefined) {
    span.setAttribute("llm.request.stream", Boolean(kwargs.stream));
  }

  if (kwargs.safePrompt !== undefined) {
    span.setAttribute("gen_ai.mistral.safe_prompt", Boolean(kwargs.safePrompt));
  }

  if (kwargs.randomSeed !== undefined && kwargs.randomSeed !== null) {
    span.setAttribute("gen_ai.mistral.random_seed", Number(kwargs.randomSeed));
  }

  // For embeddings - inputs
  if (kwargs.inputs !== undefined) {
    if (Array.isArray(kwargs.inputs)) {
      span.setAttribute("llm.request.input_count", kwargs.inputs.length);
    } else {
      span.setAttribute("llm.request.input_count", 1);
    }
  }

  // For chat - message count
  if (Array.isArray(kwargs.messages)) {
    span.setAttribute("llm.request.message_count", kwargs.messages.length);
  }

  // For FIM - prompt
  if (kwargs.prompt !== undefined) {
    span.setAttribute("llm.request.has_prompt", true);
  }
  if (kwargs.suffix !== undefined && kwargs.suffix !== null) {
    span.setAttribute("llm.request.has_suffix", true);
  }

  // For tools
  if (Array.isArray(kwargs.tools) && kwargs.tools.length > 0) {
    span.setAttribute("gen_ai.request.tools_count", kwargs.tools.length);
  }

  if (kwargs.toolChoice !== undefined) {
    span.setAttribute(
      "gen_ai.request.tool_choice",
      typeof kwargs.toolChoice === "string"
        ? kwargs.toolChoice
        : JSON.stringify(kwargs.toolChoice)
    );
  }
}

/**
 * Set response attributes on span for MistralAI
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

  // Handle usage - MistralAI uses camelCase
  const usage = response.usage as Record<string, unknown> | undefined;
  if (usage) {
    if (usage.promptTokens !== undefined) {
      span.setAttribute("gen_ai.usage.prompt_tokens", Number(usage.promptTokens));
      span.setAttribute("llm.usage.prompt_tokens", Number(usage.promptTokens));
    }
    if (usage.completionTokens !== undefined) {
      span.setAttribute("gen_ai.usage.completion_tokens", Number(usage.completionTokens));
      span.setAttribute("llm.usage.completion_tokens", Number(usage.completionTokens));
    }
    if (usage.totalTokens !== undefined) {
      span.setAttribute("gen_ai.usage.total_tokens", Number(usage.totalTokens));
      span.setAttribute("llm.usage.total_tokens", Number(usage.totalTokens));
    }
  }

  // Handle choices
  const choices = response.choices as Array<Record<string, unknown>> | undefined;
  if (choices && choices.length > 0) {
    const firstChoice = choices[0];
    if (firstChoice.finishReason) {
      span.setAttribute("gen_ai.response.finish_reason", String(firstChoice.finishReason));
      span.setAttribute("llm.response.finish_reason", String(firstChoice.finishReason));
    }
  }

  // For embeddings
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

