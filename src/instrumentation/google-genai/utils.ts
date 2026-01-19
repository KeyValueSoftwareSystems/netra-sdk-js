/**
 * Utility functions for Google GenAI instrumentation
 *
 * Google GenAI has a different response format than OpenAI:
 * - Response: { response: EnhancedGenerateContentResponse }
 * - EnhancedGenerateContentResponse: { candidates, usageMetadata, promptFeedback }
 * - UsageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount, cachedContentTokenCount }
 */

import { Span } from "@opentelemetry/api";
import { SpanAttributes } from "../span-attributes";

interface ConversationMessage {
  type: "input" | "output";
  role: string;
  content: string;
  format: string;
}

// Config for content tracing
function isTraceContentEnabled(): boolean {
  return true;
}

/**
 * Build conversation attribute array from request and response
 */
function buildConversationAttribute(
  kwargs: Record<string, unknown>,
  response: Record<string, unknown>,
): ConversationMessage[] {
  const conversation: ConversationMessage[] = [];

  // 1. Add system instruction if present
  if (kwargs.systemInstruction !== undefined) {
    const systemInstruction = kwargs.systemInstruction as any;
    let systemContent = "";

    if (typeof systemInstruction === "string") {
      systemContent = systemInstruction;
    } else if (
      systemInstruction.parts &&
      Array.isArray(systemInstruction.parts)
    ) {
      systemContent = systemInstruction.parts
        .filter((p: any) => p.text !== undefined)
        .map((p: any) => String(p.text))
        .join("");
    } else if (systemInstruction.text) {
      systemContent = String(systemInstruction.text);
    } else {
      systemContent = JSON.stringify(systemInstruction);
    }

    if (systemContent) {
      conversation.push({
        type: "input",
        role: "System",
        content: systemContent,
        format: "text",
      });
    }
  }

  // 2. Add user messages
  if (typeof kwargs.prompt === "string") {
    conversation.push({
      type: "input",
      role: "User",
      content: kwargs.prompt,
      format: "text",
    });
  } else if (Array.isArray(kwargs.contents)) {
    for (const content of kwargs.contents as Array<Record<string, unknown>>) {
      const role = String(content.role ?? "user");
      const parts = content.parts as Array<Record<string, unknown>> | undefined;

      if (Array.isArray(parts)) {
        const textParts = parts
          .filter((p) => p.text !== undefined)
          .map((p) => String(p.text))
          .join("");

        if (textParts) {
          conversation.push({
            type: "input",
            role: role === "user" ? "User" : role,
            content: textParts,
            format: "text",
          });
        }
      }
    }
  } else if (kwargs.parts && Array.isArray(kwargs.parts)) {
    // Handle case where parts is passed directly (Array<string | Part>)
    const textParts = kwargs.parts
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p && typeof p.text === "string") return p.text;
        return "";
      })
      .filter(Boolean)
      .join("");

    if (textParts) {
      conversation.push({
        type: "input",
        role: "User",
        content: textParts,
        format: "text",
      });
    }
  }

  // 3. Add assistant response from candidates
  const actualResponse =
    (response.response as Record<string, unknown>) ?? response;
  const candidates = actualResponse.candidates as
    | Array<Record<string, unknown>>
    | undefined;

  if (Array.isArray(candidates) && candidates.length > 0) {
    for (const candidate of candidates) {
      const content = candidate.content as Record<string, unknown> | undefined;
      if (!content) continue;

      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parts)) continue;

      const textContent = parts
        .filter((p) => p.text !== undefined)
        .map((p) => String(p.text))
        .join("");

      if (textContent) {
        conversation.push({
          type: "output",
          role: "Assistant",
          content: textContent,
          format: "text",
        });
      }
    }
  }

  return conversation;
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string,
): void {
  // Use a private property on the span to store kwargs temporarily for setResponseAttributes
  (span as any)._netra_kwargs = kwargs;
  if (!span.isRecording()) {
    return;
  }

  span.setAttribute(SpanAttributes.LLM_REQUEST_TYPE, requestType);
  span.setAttribute(SpanAttributes.LLM_SYSTEM, "google_genai");

  // Model is set on the GenerativeModel instance, not in the request kwargs
  // We need to access it from `this.model` in the wrapper if available
  // For now, set from kwargs if provided
  if (kwargs.model !== undefined) {
    span.setAttribute(SpanAttributes.LLM_REQUEST_MODEL, String(kwargs.model));
  }

  // Generation config parameters (from generationConfig object or direct kwargs)
  const generationConfig =
    (kwargs.generationConfig as Record<string, unknown>) ?? kwargs;

  if (generationConfig.temperature !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_REQUEST_TEMPERATURE,
      Number(generationConfig.temperature),
    );
  }

  if (generationConfig.topP !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_REQUEST_TOP_P,
      Number(generationConfig.topP),
    );
  }

  if (generationConfig.topK !== undefined) {
    span.setAttribute("gen_ai.request.top_k", Number(generationConfig.topK));
  }

  if (generationConfig.maxOutputTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_REQUEST_MAX_TOKENS,
      Number(generationConfig.maxOutputTokens),
    );
  }

  if (generationConfig.stopSequences !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_CHAT_STOP_SEQUENCES,
      safeStringify(generationConfig.stopSequences),
    );
  }

  // Candidate count
  if (generationConfig.candidateCount !== undefined) {
    span.setAttribute(
      "gen_ai.request.candidate_count",
      Number(generationConfig.candidateCount),
    );
  }

  // Presence/frequency penalty
  if (generationConfig.presencePenalty !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_PRESENCE_PENALTY,
      Number(generationConfig.presencePenalty),
    );
  }
  if (generationConfig.frequencyPenalty !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_FREQUENCY_PENALTY,
      Number(generationConfig.frequencyPenalty),
    );
  }

  // Embedding dimensions
  if (kwargs.dimensions !== undefined) {
    span.setAttribute("gen_ai.request.dimensions", Number(kwargs.dimensions));
  }

  // Tools
  if (Array.isArray(kwargs.tools) && kwargs.tools.length > 0) {
    span.setAttribute("gen_ai.request.tools_count", kwargs.tools.length);
  }

  // Tool config
  if (kwargs.toolConfig !== undefined) {
    span.setAttribute(
      "gen_ai.request.tool_config",
      safeStringify(kwargs.toolConfig),
    );
  }

  // Safety settings
  if (
    Array.isArray(kwargs.safetySettings) &&
    kwargs.safetySettings.length > 0
  ) {
    span.setAttribute(
      "gen_ai.request.safety_settings_count",
      kwargs.safetySettings.length,
    );
  }

  // System instruction
  if (kwargs.systemInstruction !== undefined) {
    if (isTraceContentEnabled()) {
      span.setAttribute(
        "gen_ai.request.system_instruction",
        safeStringify(kwargs.systemInstruction),
      );
    }
    span.setAttribute("gen_ai.request.has_system_instruction", true);
  }

  // Content tracing - prompts
  if (isTraceContentEnabled()) {
    _setPromptAttributes(span, kwargs);
  }
}

/**
 * Extract and set prompt content from Google GenAI request
 */
function _setPromptAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
): void {
  // For generateContent, the prompt can be:
  // 1. A string (simple prompt)
  // 2. An array of Parts
  // 3. A GenerateContentRequest object with contents array

  let promptIndex = 0;

  // Handle string prompt
  if (typeof kwargs === "string") {
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.role`,
      "user",
    );
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.content`,
      kwargs,
    );
    return;
  }

  // Handle contents array (standard format)
  const contents = kwargs.contents as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(contents)) {
    for (const content of contents) {
      const role = String(content.role ?? "user");
      const parts = content.parts as Array<Record<string, unknown>> | undefined;

      if (Array.isArray(parts)) {
        const textParts = parts
          .filter((p) => p.text !== undefined)
          .map((p) => String(p.text))
          .join("");

        if (textParts) {
          span.setAttribute(
            `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.role`,
            role,
          );
          span.setAttribute(
            `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.content`,
            textParts,
          );
          promptIndex++;
        }

        // Track non-text parts
        const inlineDataParts = parts.filter((p) => p.inlineData !== undefined);
        if (inlineDataParts.length > 0) {
          span.setAttribute(
            `gen_ai.prompt.${promptIndex - 1}.has_inline_data`,
            true,
          );
          span.setAttribute(
            `gen_ai.prompt.${promptIndex - 1}.inline_data_count`,
            inlineDataParts.length,
          );
        }
      }
    }
  }

  // For embedContent, handle content differently
  if (kwargs.content !== undefined) {
    const content = kwargs.content as Record<string, unknown> | string;
    if (typeof content === "string") {
      span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.0.content`, content);
    } else if (content.parts !== undefined) {
      const parts = content.parts as Array<Record<string, unknown>>;
      const textContent = parts
        .filter((p) => p.text !== undefined)
        .map((p) => String(p.text))
        .join("");
      if (textContent) {
        span.setAttribute(
          `${SpanAttributes.LLM_PROMPTS}.0.content`,
          textContent,
        );
      }
    }
  }
}

/**
 * Set response attributes for Google GenAI responses
 * Handles the specific structure of GenerateContentResult
 */
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  if (!span.isRecording()) {
    return;
  }

  // Google GenAI returns { response: EnhancedGenerateContentResponse }
  // The response object itself is what we need to parse
  const actualResponse =
    (response.response as Record<string, unknown>) ?? response;

  // Set usage metadata
  _setUsageAttributes(span, actualResponse);

  // Set candidate attributes
  _setCandidateAttributes(span, actualResponse);

  // Set prompt feedback if present (content filtering)
  _setPromptFeedbackAttributes(span, actualResponse);

  // Set completion content if tracing is enabled
  if (isTraceContentEnabled()) {
    _setCompletionAttributes(span, actualResponse);
  }

  // Handle embedding response
  _setEmbeddingResponseAttributes(span, actualResponse);

  // Build and set conversation attribute
  if (isTraceContentEnabled()) {
    const kwargs = (span as any)._netra_kwargs || {};
    const conversation = buildConversationAttribute(kwargs, response);
    span.setAttribute("conversation", JSON.stringify(conversation));
    // Clean up
    delete (span as any)._netra_kwargs;
  }
}

/**
 * Extract and set token usage from usageMetadata
 */
function _setUsageAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  const usageMetadata = response.usageMetadata as
    | Record<string, unknown>
    | undefined;
  if (!usageMetadata) return;

  // Prompt tokens
  if (usageMetadata.promptTokenCount !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_PROMPT_TOKENS,
      Number(usageMetadata.promptTokenCount),
    );
  }

  // Completion/candidates tokens
  if (usageMetadata.candidatesTokenCount !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_COMPLETION_TOKENS,
      Number(usageMetadata.candidatesTokenCount),
    );
  }

  // Total tokens
  if (usageMetadata.totalTokenCount !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_TOTAL_TOKENS,
      Number(usageMetadata.totalTokenCount),
    );
  }

  // Cached content tokens
  if (usageMetadata.cachedContentTokenCount !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_CACHE_READ_INPUT_TOKENS,
      Number(usageMetadata.cachedContentTokenCount),
    );
  }
}

/**
 * Extract and set attributes from candidates
 */
function _setCandidateAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  const candidates = response.candidates as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) return;

  span.setAttribute("gen_ai.response.candidate_count", candidates.length);

  const firstCandidate = candidates[0];

  // Finish reason
  if (firstCandidate.finishReason !== undefined) {
    span.setAttribute(
      "gen_ai.response.finish_reason",
      String(firstCandidate.finishReason),
    );
  }

  // Average log probs (if present)
  if (firstCandidate.avgLogprobs !== undefined) {
    span.setAttribute(
      "gen_ai.response.avg_logprobs",
      Number(firstCandidate.avgLogprobs),
    );
  }

  // Safety ratings
  const safetyRatings = firstCandidate.safetyRatings as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(safetyRatings) && safetyRatings.length > 0) {
    span.setAttribute(
      "gen_ai.response.safety_ratings_count",
      safetyRatings.length,
    );

    // Set individual safety ratings
    for (let i = 0; i < safetyRatings.length; i++) {
      const rating = safetyRatings[i];
      if (rating.category !== undefined) {
        span.setAttribute(
          `gen_ai.response.safety_rating.${i}.category`,
          String(rating.category),
        );
      }
      if (rating.probability !== undefined) {
        span.setAttribute(
          `gen_ai.response.safety_rating.${i}.probability`,
          String(rating.probability),
        );
      }
    }
  }

  // Citation metadata
  const citationMetadata = firstCandidate.citationMetadata as
    | Record<string, unknown>
    | undefined;
  if (citationMetadata?.citationSources !== undefined) {
    const sources = citationMetadata.citationSources as Array<unknown>;
    span.setAttribute("gen_ai.response.citation_count", sources.length);
  }

  // Grounding metadata
  if (firstCandidate.groundingMetadata !== undefined) {
    span.setAttribute("gen_ai.response.has_grounding", true);
  }
}

/**
 * Set prompt feedback attributes (content filtering info)
 */
function _setPromptFeedbackAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  const promptFeedback = response.promptFeedback as
    | Record<string, unknown>
    | undefined;
  if (!promptFeedback) return;

  if (promptFeedback.blockReason !== undefined) {
    span.setAttribute(
      "gen_ai.response.prompt_block_reason",
      String(promptFeedback.blockReason),
    );
  }

  if (promptFeedback.blockReasonMessage !== undefined) {
    span.setAttribute(
      "gen_ai.response.prompt_block_message",
      String(promptFeedback.blockReasonMessage),
    );
  }

  const safetyRatings = promptFeedback.safetyRatings as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(safetyRatings)) {
    span.setAttribute(
      "gen_ai.response.prompt_safety_ratings_count",
      safetyRatings.length,
    );
  }
}

/**
 * Extract and set completion content from candidates
 */
function _setCompletionAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  const candidates = response.candidates as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(candidates)) return;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const content = candidate.content as Record<string, unknown> | undefined;

    if (!content) continue;

    const role = String(content.role ?? "model");
    const parts = content.parts as Array<Record<string, unknown>> | undefined;

    if (!Array.isArray(parts)) continue;

    // Extract text from parts
    const textContent = parts
      .filter((p) => p.text !== undefined)
      .map((p) => String(p.text))
      .join("");

    if (textContent) {
      span.setAttribute(`${SpanAttributes.LLM_COMPLETIONS}.${i}.role`, role);
      // Content is removed here as it is redundant with the 'conversation' attribute
    }

    // Track function calls
    const functionCalls = parts.filter((p) => p.functionCall !== undefined);
    if (functionCalls.length > 0) {
      span.setAttribute(
        `gen_ai.completion.${i}.function_call_count`,
        functionCalls.length,
      );

      for (let j = 0; j < functionCalls.length; j++) {
        const fc = functionCalls[j].functionCall as Record<string, unknown>;
        if (fc.name !== undefined) {
          span.setAttribute(
            `gen_ai.completion.${i}.function_call.${j}.name`,
            String(fc.name),
          );
        }
      }
    }
  }
}

/**
 * Set attributes for embedding responses
 */
function _setEmbeddingResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  // Single embedding response
  const embedding = response.embedding as Record<string, unknown> | undefined;
  if (embedding?.values !== undefined) {
    const values = embedding.values as number[];
    span.setAttribute("gen_ai.response.embedding_dimensions", values.length);
  }

  // Batch embedding response
  const embeddings = response.embeddings as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(embeddings)) {
    span.setAttribute("gen_ai.response.embedding_count", embeddings.length);
    if (embeddings.length > 0 && embeddings[0].values !== undefined) {
      const values = embeddings[0].values as number[];
      span.setAttribute("gen_ai.response.embedding_dimensions", values.length);
    }
  }
}
