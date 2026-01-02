/**
 * MistralAI-specific utility functions for instrumentation.
 *
 * This file extends the shared instrumentation utilities with Mistral-only
 * fields while keeping attribute naming consistent across providers.
 */

import { Span } from "@opentelemetry/api";
import {
  modelAsDict,
  setRequestAttributes as setBaseRequestAttributes,
  setResponseAttributes as setBaseResponseAttributes,
  shouldSuppressInstrumentation,
} from "../utils";

// Re-export common utilities for convenience
export { modelAsDict, shouldSuppressInstrumentation };

export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string
): void {
  // Set shared/common attributes first
  setBaseRequestAttributes(span, kwargs, requestType, "mistralai");

  // MistralAI-specific: Agent ID (agents API)
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

}

/**
 * Set response attributes on span for MistralAI
 * Uses the shared response attributes (supports snake_case + camelCase).
 */
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>
): void {
  setBaseResponseAttributes(span, response);
}
