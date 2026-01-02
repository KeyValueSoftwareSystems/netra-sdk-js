/**
 * MistralAI-specific utility functions for instrumentation
 * Extends the shared utilities with MistralAI-specific logic
 */

import { Span } from "@opentelemetry/api";
import {
  shouldSuppressInstrumentation,
  modelAsDict,
  setRequestAttributes as setBaseRequestAttributes,
  setResponseAttributes as setBaseResponseAttributes,
} from "../utils";

// Re-export common utilities for convenience
export { shouldSuppressInstrumentation, modelAsDict };

/**
 * Set request attributes on span for MistralAI
 * Includes MistralAI-specific attributes
 */
export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string
): void {
  // Set common attributes first
  setBaseRequestAttributes(span, kwargs, requestType, "mistralai");

  // MistralAI-specific: Agent ID
  if (kwargs.agentId) {
    span.setAttribute("gen_ai.agent.id", String(kwargs.agentId));
    span.setAttribute("llm.agent.id", String(kwargs.agentId));
  }

  // MistralAI-specific: Safe prompt
  if (kwargs.safePrompt !== undefined) {
    span.setAttribute("gen_ai.mistral.safe_prompt", Boolean(kwargs.safePrompt));
  }

  // MistralAI-specific: Random seed
  if (kwargs.randomSeed !== undefined && kwargs.randomSeed !== null) {
    span.setAttribute("gen_ai.mistral.random_seed", Number(kwargs.randomSeed));
  }

  // MistralAI FIM-specific: prompt and suffix
  if (kwargs.prompt !== undefined) {
    span.setAttribute("llm.request.has_prompt", true);
  }
  if (kwargs.suffix !== undefined && kwargs.suffix !== null) {
    span.setAttribute("llm.request.has_suffix", true);
  }
}

/**
 * Set response attributes on span for MistralAI
 * Uses common response attributes
 */
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>
): void {
  // Use common response attributes - handles both snake_case and camelCase
  setBaseResponseAttributes(span, response);
}
