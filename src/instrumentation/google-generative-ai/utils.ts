/**
 * Utility functions for Google Generative AI instrumentation
 *
 * Google Generative AI has a different response format than OpenAI:
 * - Response: { response: EnhancedGenerateContentResponse }
 * - EnhancedGenerateContentResponse: { candidates, usageMetadata, promptFeedback }
 * - UsageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount, cachedContentTokenCount }
 */

import { Span } from "@opentelemetry/api";
import { SpanAttributes } from "../span-attributes";
import { isTraceContentEnabled } from "../utils";

function safeStringify(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Extract the model name from the model string.
 * @param model - The model string.
 * @returns The model name without the "models/" prefix if it exists.
 */
export function extractModelName(model: string): string {
  if (model && model.startsWith("models/")) {
    return model.replace(/^models\//, "");
  }
  return model;
}

/**
 * Normalize role values from Google Generative AI.
 *
 * Google Generative AI uses "model" to indicate the assistant role.
 * This function maps "model" → "assistant" and returns any other role unchanged in lowercase.
 */
function normalizeGenerativeAIRole(raw: string): string {
  const rawLower = raw.toLowerCase();
  return rawLower === "model" ? "assistant" : rawLower;
}

export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string,
  args: Record<string, unknown>,
): void {
  // Use a private property on the span to store kwargs temporarily for setResponseAttributes
  (span as any)._netra_kwargs = kwargs;
  if (!span.isRecording()) {
    return;
  }

  span.setAttribute(SpanAttributes.LLM_REQUEST_TYPE, requestType);
  span.setAttribute(SpanAttributes.LLM_SYSTEM, "google_generative_ai");

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
    _setPromptAttributes(span, kwargs, args);
  }
}

/**
 * Extract and set prompt content from Google Generative AI request
 */
function _setPromptAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  args: any,
): void {
  // For generateContent, the prompt can be:
  // 1. A string (simple prompt)
  // 2. An array of Parts (Array<string | Part>)
  // 3. A GenerateContentRequest object with contents array

  let promptIndex = 0;

  // 1. Add system instruction if present (from getGenerativeModel)
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
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.role`,
        "system",
      );
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.content`,
        systemContent,
      );
      promptIndex++;
    }
  }

  // 2. Chat history from startChat (multiturn context)
  if (kwargs.history && Array.isArray(kwargs.history)) {
    for (const turn of kwargs.history as Array<Record<string, unknown>>) {
      const role = normalizeGenerativeAIRole(String(turn.role ?? "user"));
      const parts = turn.parts as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(parts)) {
        const textContent = parts
          .filter((p) => p.text !== undefined)
          .map((p) => String(p.text))
          .join("");
        if (textContent) {
          span.setAttribute(
            `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.role`,
            role,
          );
          span.setAttribute(
            `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.content`,
            textContent,
          );
          promptIndex++;
        }
      }
    }
  }

  // 3. Add prompts from args (generateContent/embedContent call)
  if (!args) return;

  // Handle string prompt
  if (typeof args === "string") {
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.role`,
      "user",
    );
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.content`,
      args,
    );
    promptIndex++;
    return;
  }

  // Handle Array<string | Part>
  if (Array.isArray(args)) {
    const textParts = args
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p && typeof p.text === "string") return p.text;
        return "";
      })
      .filter(Boolean)
      .join(" ");

    if (textParts) {
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.role`,
        "user",
      );
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.content`,
        textParts,
      );
      promptIndex++;
    }
    return;
  }

  // Handle GenerateContentRequest object { contents: [...] }
  const contents = args.contents as Array<Record<string, unknown>> | undefined;
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

  // For embedContent, handle content object { parts: [...] } or string
  if (args.content !== undefined) {
    const content = args.content as Record<string, unknown> | string;
    if (typeof content === "string") {
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.content`,
        content,
      );
      promptIndex++;
    } else if (content.parts !== undefined) {
      const parts = content.parts as Array<Record<string, unknown>>;
      const textContent = parts
        .filter((p) => p.text !== undefined)
        .map((p) => String(p.text))
        .join("");
      if (textContent) {
        span.setAttribute(
          `${SpanAttributes.LLM_PROMPTS}.${promptIndex}.content`,
          textContent,
        );
        promptIndex++;
      }
    }
  }
}

/**
 * Set response attributes for Google Generative AI responses
 * Handles the specific structure of GenerateContentResult
 */
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  if (!span.isRecording()) {
    return;
  }

  // Google Generative AI returns { response: EnhancedGenerateContentResponse }
  // The response object itself is what we need to parse
  const actualResponse =
    (response.response as Record<string, unknown>) ?? response;

  // Set usage metadata -- try actualResponse first, fall back to top-level
  // response for embedding responses where usageMetadata may not survive
  // the response.response unwrap or modelAsDict serialization
  _setUsageAttributes(span, actualResponse);
  if (!actualResponse.usageMetadata && response.usageMetadata) {
    _setUsageAttributes(span, response);
  }

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

    const role = normalizeGenerativeAIRole(String(content.role ?? "model"));
    const parts = content.parts as Array<Record<string, unknown>> | undefined;

    if (!Array.isArray(parts)) continue;

    // Extract text from parts
    const textContent = parts
      .filter((p) => p.text !== undefined)
      .map((p) => String(p.text))
      .join("");

    if (textContent) {
      span.setAttribute(`${SpanAttributes.LLM_COMPLETIONS}.${i}.role`, role);
      span.setAttribute(
        `${SpanAttributes.LLM_COMPLETIONS}.${i}.content`,
        textContent,
      );
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
