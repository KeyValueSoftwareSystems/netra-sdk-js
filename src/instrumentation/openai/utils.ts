import { Span } from "@opentelemetry/api";
import {
  setRequestAttributes as setBaseRequestAttributes,
  setResponseAttributes as setBaseResponseAttributes,
} from "../utils";

/**
 * OpenAI-specific request attributes.
 * Calls the shared base implementation with "openai" as the system identifier,
 * then adds any OpenAI-only fields.
 */
export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string,
): void {
  if (!span.isRecording()) return;
  setBaseRequestAttributes(span, kwargs, requestType, "openai");

  // Embeddings-only: output dimension hint
  if (kwargs.dimensions !== undefined) {
    span.setAttribute("gen_ai.request.dimensions", Number(kwargs.dimensions));
  }
}

/**
 * OpenAI-specific response attributes.
 * Delegates entirely to the shared base implementation.
 */
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  if (!span.isRecording()) return;
  setBaseResponseAttributes(span, response);
}
