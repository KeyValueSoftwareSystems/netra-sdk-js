/**
 * Provider-specific utilities for @google/genai instrumentation.
 *
 * The @google/genai SDK uses a different request/response shape from OpenAI:
 *   Request:  { model, contents, config: { temperature, topP, ... } }
 *   Response: GenerateContentResponse with usageMetadata, candidates[], text accessor
 *   Embed:    EmbedContentResponse with embeddings[]
 *
 * Because these shapes differ from OpenAI's flat kwargs and usage.prompt_tokens
 * convention, we do custom mapping here rather than delegating fully to the
 * shared setBaseRequestAttributes / setBaseResponseAttributes.
 */

import { Span } from "@opentelemetry/api";
import { Logger } from "../../logger";
import { safeStringify } from "../../utils/serialization";
import type { FirstTokenTracker } from "../../utils/span-timing";
import { SpanAttributes } from "../span-attributes";
import {
  TracedMessage,
  hasContent,
  isDict,
  isTraceContentEnabled,
  writeCompletionAttributes,
  writePromptAttributes,
} from "../utils";

const LOG_PREFIX = "netra.instrumentation.google_genai";

/**
 * Flatten @google/genai params into the kwargs shape expected by the shared
 * PARAM_ATTRIBUTE_MAP, then set provider-specific extras.
 *
 * @param params - The raw GenerateContentParameters / EmbedContentParameters
 *                 object the user passed to the SDK method.
 */
export function setRequestAttributes(
  span: Span,
  params: Record<string, unknown>,
  requestType: string,
): void {
  try {
    if (!span.isRecording()) return;

    span.setAttribute(SpanAttributes.LLM_REQUEST_TYPE, requestType);
    span.setAttribute(SpanAttributes.LLM_SYSTEM, "google_genai");

    if (params.model) {
      span.setAttribute(
        SpanAttributes.LLM_REQUEST_MODEL,
        extractModelName(String(params.model)),
      );
    }

    const cfg = (params.config ?? {}) as Record<string, unknown>;

    if (cfg.temperature !== undefined) {
      span.setAttribute(
        SpanAttributes.LLM_REQUEST_TEMPERATURE,
        Number(cfg.temperature),
      );
    }
    if (cfg.topP !== undefined) {
      span.setAttribute(SpanAttributes.LLM_REQUEST_TOP_P, Number(cfg.topP));
    }
    if (cfg.topK !== undefined) {
      span.setAttribute(SpanAttributes.LLM_REQUEST_TOP_K, Number(cfg.topK));
    }
    if (cfg.maxOutputTokens !== undefined) {
      span.setAttribute(
        SpanAttributes.LLM_REQUEST_MAX_TOKENS,
        Number(cfg.maxOutputTokens),
      );
    }
    if (cfg.frequencyPenalty !== undefined) {
      span.setAttribute(
        SpanAttributes.LLM_FREQUENCY_PENALTY,
        Number(cfg.frequencyPenalty),
      );
    }
    if (cfg.presencePenalty !== undefined) {
      span.setAttribute(
        SpanAttributes.LLM_PRESENCE_PENALTY,
        Number(cfg.presencePenalty),
      );
    }
    if (cfg.stopSequences !== undefined) {
      span.setAttribute(
        SpanAttributes.LLM_CHAT_STOP_SEQUENCES,
        safeStringify(cfg.stopSequences),
      );
    }

    if (isTraceContentEnabled()) {
      const messages = buildGoogleInputMessages(params, cfg);
      writePromptAttributes(span, messages);
    }
  } catch (e) {
    Logger.error(`${LOG_PREFIX}: setRequestAttributes error`, e);
  }
}

/**
 * Strips common prefix patterns from Google model identifiers.
 * "models/gemini-2.0-flash" -> "gemini-2.0-flash"
 */
function extractModelName(model: string): string {
  const MODEL_PREFIX = "models/";
  const TUNED_MODELS_PREFIX = "tunedModels/";
  const PUBLISHERS_PREFIX = "publishers/";
  const PROJECTS_PREFIX = "projects/";
  const MODELS_SEGMENT = "/models/";

  if (model.startsWith(MODEL_PREFIX)) return model.slice(MODEL_PREFIX.length);

  if (model.startsWith(TUNED_MODELS_PREFIX)) return model;

  const publisherIdx = model.indexOf(PUBLISHERS_PREFIX);
  if (publisherIdx !== -1) {
    const modelsIdx = model.indexOf(MODELS_SEGMENT, publisherIdx);
    if (modelsIdx !== -1) return model.slice(modelsIdx + MODELS_SEGMENT.length);
  }

  const slashIdx = model.indexOf("/");
  if (slashIdx !== -1 && !model.startsWith(PROJECTS_PREFIX)) {
    return model.slice(slashIdx + 1);
  }

  return model;
}

/**
 * Build TracedMessage[] from @google/genai request params.
 *
 * `contents` can be: string, Part, Part[], Content, Content[]
 * Each Content has { role, parts: Part[] }, each Part has { text? } or other fields.
 */
function buildGoogleInputMessages(
  params: Record<string, unknown>,
  cfg: Record<string, unknown>,
): TracedMessage[] {
  const messages: TracedMessage[] = [];

  // System instruction
  if (hasContent(cfg.systemInstruction)) {
    const sysContent =
      typeof cfg.systemInstruction === "string"
        ? cfg.systemInstruction
        : safeStringify(cfg.systemInstruction);
    messages.push({ role: "system", content: sysContent });
  }

  // Multi-turn chat history (injected by the wrapper from Chat instance)
  const history = params._history as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(history)) {
    for (const turn of history) {
      const role = normalizeRole(String(turn.role ?? "user"));
      const parts = turn.parts as unknown[] | undefined;
      if (Array.isArray(parts)) {
        const text = extractTextFromParts(parts);
        if (text) messages.push({ role, content: text });
      }
    }
  }

  const contents = params.contents ?? params.message;
  if (!hasContent(contents)) return messages;

  if (typeof contents === "string") {
    messages.push({ role: "user", content: contents });
    return messages;
  }

  if (Array.isArray(contents)) {
    for (const item of contents) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (isDict(item) && item.role && Array.isArray(item.parts)) {
        // Content object: { role, parts }
        const role = normalizeRole(String(item.role));
        const text = extractTextFromParts(item.parts as unknown[]);
        if (text) messages.push({ role, content: text });
      } else if (isDict(item) && item.text !== undefined) {
        // Bare Part with text
        messages.push({ role: "user", content: String(item.text) });
      } else {
        messages.push({
          role: "user",
          content: safeStringify(item),
        });
      }
    }
  } else if (isDict(contents) && Array.isArray((contents as any).parts)) {
    // Single Content object
    const role = normalizeRole(String((contents as any).role ?? "user"));
    const text = extractTextFromParts((contents as any).parts as unknown[]);
    if (text) messages.push({ role, content: text });
  } else if (isDict(contents) && (contents as any).text !== undefined) {
    // Single Part object with text
    messages.push({ role: "user", content: String((contents as any).text) });
  } else {
    messages.push({
      role: "user",
      content: safeStringify(contents),
    });
  }

  return messages;
}

function normalizeRole(role: string): string {
  if (role === "model") return "assistant";
  return role;
}

function extractTextFromParts(parts: unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (!isDict(part)) continue;
    if (typeof part.text === "string") {
      texts.push(part.text);
    } else if (part.functionCall) {
      texts.push(safeStringify(part.functionCall));
    } else if (part.functionResponse) {
      texts.push(
        safeStringify(part.functionResponse),
      );
    }
  }
  return texts.join("");
}

/**
 * Extract and set span attributes from a GenerateContentResponse or
 * EmbedContentResponse.
 *
 * GenerateContentResponse:
 *   { responseId, modelVersion, candidates, usageMetadata, text, functionCalls }
 *
 * EmbedContentResponse:
 *   { embeddings: ContentEmbedding[] }
 */
export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  try {
    if (!span.isRecording()) return;

    if (response.responseId) {
      span.setAttribute("llm.response.id", String(response.responseId));
    }
    if (response.modelVersion) {
      span.setAttribute(
        SpanAttributes.LLM_RESPONSE_MODEL,
        String(response.modelVersion),
      );
    }

    setUsageAttributes(span, response);
    setFinishReason(span, response);
    setEmbeddingMeta(span, response);

    if (isTraceContentEnabled()) {
      const messages = buildGoogleOutputMessages(response);
      writeCompletionAttributes(span, messages);
    }
  } catch (e) {
    Logger.error(`${LOG_PREFIX}: setResponseAttributes error`, e);
  }
}

/**
 * Map @google/genai usageMetadata to OTel GenAI token attributes.
 *
 * UsageMetadata fields: promptTokenCount, candidatesTokenCount,
 * totalTokenCount, cachedContentTokenCount, thoughtsTokenCount
 */
function setUsageAttributes(
  span: Span,
  response: Record<string, unknown>,
): void {
  const usage = response.usageMetadata as Record<string, unknown> | undefined;
  if (!usage) return;

  if (usage.promptTokenCount !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_PROMPT_TOKENS,
      Number(usage.promptTokenCount),
    );
  }
  if (usage.candidatesTokenCount !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_COMPLETION_TOKENS,
      Number(usage.candidatesTokenCount),
    );
  }
  if (usage.totalTokenCount !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_TOTAL_TOKENS,
      Number(usage.totalTokenCount),
    );
  }
  if (usage.cachedContentTokenCount !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_CACHE_READ_INPUT_TOKENS,
      Number(usage.cachedContentTokenCount),
    );
  }
  if (usage.thoughtsTokenCount !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_REASONING_TOKENS,
      Number(usage.thoughtsTokenCount),
    );
  }
}

function setFinishReason(span: Span, response: Record<string, unknown>): void {
  const candidates = response.candidates as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) return;

  const reason = candidates[0].finishReason;
  if (reason) {
    span.setAttribute(
      SpanAttributes.LLM_RESPONSE_FINISH_REASON,
      String(reason),
    );
    span.setAttribute("gen_ai.response.finish_reason", String(reason));
  }
}

function setEmbeddingMeta(span: Span, response: Record<string, unknown>): void {
  // Single embedding response
  const singleEmbed = response.embedding as Record<string, unknown> | undefined;
  if (singleEmbed?.values !== undefined) {
    const values = singleEmbed.values as number[];
    span.setAttribute("gen_ai.response.embedding_dimensions", values.length);

    const stats = singleEmbed.statistics as Record<string, unknown> | undefined;
    if (stats?.tokenCount !== undefined) {
      const tokenCount = Number(stats.tokenCount);
      span.setAttribute(SpanAttributes.LLM_USAGE_PROMPT_TOKENS, tokenCount);
      span.setAttribute(SpanAttributes.LLM_USAGE_TOTAL_TOKENS, tokenCount);
    }
    return;
  }

  // Batch embedding response
  const embeddings = response.embeddings as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(embeddings) || embeddings.length === 0) return;

  span.setAttribute("gen_ai.response.embedding_count", embeddings.length);

  const first = embeddings[0];
  const values = first?.values as number[] | undefined;
  if (Array.isArray(values)) {
    span.setAttribute("gen_ai.response.embedding_dimensions", values.length);
  }

  // Aggregate token counts across all embeddings in the batch
  let totalTokens = 0;
  let hasTokenCount = false;
  for (const emb of embeddings) {
    const stats = emb.statistics as Record<string, unknown> | undefined;
    if (stats?.tokenCount !== undefined) {
      totalTokens += Number(stats.tokenCount);
      hasTokenCount = true;
    }
  }
  if (hasTokenCount) {
    span.setAttribute(SpanAttributes.LLM_USAGE_PROMPT_TOKENS, totalTokens);
    span.setAttribute(SpanAttributes.LLM_USAGE_TOTAL_TOKENS, totalTokens);
  }
}

/**
 * Build TracedMessage[] from @google/genai response.
 * Handles both text output and function calls.
 */
function buildGoogleOutputMessages(
  response: Record<string, unknown>,
): TracedMessage[] {
  const messages: TracedMessage[] = [];

  // text accessor (available on GenerateContentResponse)
  const text = response.text;
  if (typeof text === "string" && text.length > 0) {
    messages.push({ role: "assistant", content: text });
  }

  // Function calls
  const functionCalls = response.functionCalls as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(functionCalls)) {
    for (const fc of functionCalls) {
      messages.push({
        role: "tool",
        content: safeStringify(
          { name: fc.name, arguments: fc.args },
        ),
      });
    }
  }

  // If text accessor wasn't available, fall back to candidates
  if (messages.length === 0) {
    const candidates = response.candidates as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(candidates)) {
      for (const candidate of candidates) {
        const content = candidate.content as
          | Record<string, unknown>
          | undefined;
        if (!content || !Array.isArray(content.parts)) continue;
        for (const part of content.parts as Array<Record<string, unknown>>) {
          if (typeof part.text === "string" && part.text.length > 0) {
            messages.push({ role: "assistant", content: part.text });
          }
          if (part.functionCall && isDict(part.functionCall)) {
            const fc = part.functionCall as Record<string, unknown>;
            messages.push({
              role: "tool",
              content: safeStringify(
                { name: fc.name, arguments: fc.args },
              ),
            });
          }
        }
      }
    }
  }

  // Embedding responses: generate structured output for the Netra output field.
  if (messages.length === 0) {
    // Single embedding: { embedding: { values: [...] } }
    const singleEmbed = response.embedding as
      | Record<string, unknown>
      | undefined;
    if (singleEmbed?.values !== undefined) {
      const values = singleEmbed.values as number[];
      messages.push({
        role: "assistant",
        content: safeStringify({
          dimensions: values.length,
          preview: values.slice(0, 5),
        }),
      });
    }

    // Batch embeddings: { embeddings: [ { values: [...] }, ... ] }
    const embeddings = response.embeddings as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(embeddings) && embeddings.length > 0) {
      for (let i = 0; i < embeddings.length; i++) {
        const values = (embeddings[i]?.values ?? []) as number[];
        messages.push({
          role: "assistant",
          content: safeStringify({
            index: i,
            dimensions: values.length,
            preview: values.slice(0, 5),
          }),
        });
      }
    }
  }

  return messages;
}

/**
 * Accumulate a single streamed GenerateContentResponse chunk into a
 * synthetic response dict.  Safe against malformed chunks.
 *
 * @param accumulated - Mutable dict built up across chunks.
 * @param chunk       - A single GenerateContentResponse chunk from the stream.
 * @param span        - The active span (for time-to-first-token recording).
 * @param startTime   - Request start timestamp in ms.
 */
export function processStreamChunk(
  accumulated: Record<string, any>,
  chunk: any,
  span: Span,
  startTime: number,
  tokenTracker?: FirstTokenTracker,
): void {
  try {
    if (chunk.modelVersion) {
      accumulated.modelVersion = chunk.modelVersion;
    }
    if (chunk.responseId) {
      accumulated.responseId = chunk.responseId;
    }

    // Accumulate text
    const chunkText = typeof chunk.text === "string" ? chunk.text : undefined;
    if (chunkText && chunkText.length > 0) {
      if (!accumulated._text) {
        accumulated._text = chunkText;
        tokenTracker?.markFirstToken();
      } else {
        accumulated._text += chunkText;
      }
    }

    // Accumulate function calls
    const fcs = chunk.functionCalls;
    if (Array.isArray(fcs) && fcs.length > 0) {
      if (!accumulated._functionCalls) accumulated._functionCalls = [];
      accumulated._functionCalls.push(...fcs);
    }

    // Usage metadata -- later chunks overwrite; final chunk has full counts
    if (chunk.usageMetadata) {
      accumulated.usageMetadata = chunk.usageMetadata;
    }

    // Finish reason from candidates
    if (Array.isArray(chunk.candidates) && chunk.candidates.length > 0) {
      const reason = chunk.candidates[0]?.finishReason;
      if (reason) {
        if (!accumulated.candidates) accumulated.candidates = [{}];
        accumulated.candidates[0].finishReason = reason;
      }
    }

    if (Logger.isDebugMode()) {
      span.addEvent("llm.content.completion.chunk");
    }
  } catch (e) {
    Logger.error(`${LOG_PREFIX}: processStreamChunk error`, e);
  }
}

/**
 * Convert accumulated stream data into the shape expected by
 * setResponseAttributes.  Called once when the stream completes.
 */
export function buildAccumulatedResponse(
  accumulated: Record<string, any>,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    responseId: accumulated.responseId,
    modelVersion: accumulated.modelVersion,
    usageMetadata: accumulated.usageMetadata,
    candidates: accumulated.candidates,
  };

  if (accumulated._text) {
    response.text = accumulated._text;
  }
  if (accumulated._functionCalls) {
    response.functionCalls = accumulated._functionCalls;
  }

  return response;
}
