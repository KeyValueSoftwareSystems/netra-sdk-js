import { Span } from "@opentelemetry/api";
import { SpanAttributes } from "../span-attributes";
import { isDict } from "../utils";

export function setRequestAttributes(
  span: Span,
  kwargs: Record<string, unknown>,
  requestType: string
): void {
  if (!span.isRecording()) {
    console.log("Span is not recording");
    return;
  }

  span.setAttribute(SpanAttributes.LLM_REQUEST_TYPE, requestType);
  span.setAttribute(SpanAttributes.LLM_SYSTEM, "groq");

  const attributeMappings = {
    model: SpanAttributes.LLM_REQUEST_MODEL,
    temperature: SpanAttributes.LLM_REQUEST_TEMPERATURE,
    max_tokens: SpanAttributes.LLM_REQUEST_MAX_TOKENS,
    max_completion_tokens: SpanAttributes.LLM_REQUEST_MAX_TOKENS,
    max_tokens_to_sample: SpanAttributes.LLM_REQUEST_MAX_TOKENS,
    frequency_penalty: SpanAttributes.LLM_FREQUENCY_PENALTY,
    presence_penalty: SpanAttributes.LLM_PRESENCE_PENALTY,
    reasoning_effort: SpanAttributes.LLM_REQUEST_REASONING_EFFORT,
    stop: SpanAttributes.LLM_CHAT_STOP_SEQUENCES,
    stream: SpanAttributes.LLM_IS_STREAMING,
    top_p: SpanAttributes.LLM_REQUEST_TOP_P,
  };

  for (let [key, attribute] of Object.entries(attributeMappings)) {
    const value: any = kwargs[key];
    if (value !== undefined) {
      span.setAttribute(attribute, value);
    }
  }

  if (Array.isArray(kwargs.messages)) {
    const messages = kwargs.messages;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!isDict(message)) {
        continue;
      }
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${i}.role`,
        message?.role ?? "user"
      );
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${i}.content`,
        String(message?.content ?? "")
      );
    }
  }

  if (typeof kwargs.prompt === "string") {
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.0.role`, "user");
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.0.content`, kwargs.prompt);
  }
}

export function setResponseAttributes(
  span: Span,
  response: Record<string, unknown>
): void {
  if (!span.isRecording()) {
    console.log("Span is not recording");
    return;
  }

  if (response.id) {
    span.setAttribute("llm.response.id", String(response.id));
  }

  if (response.model) {
    span.setAttribute(
      SpanAttributes.LLM_RESPONSE_MODEL,
      String(response.model)
    );
  }

  _setUsageAttributes(span, response);
  _setResponseMessageAttributes(span, response);
}

function _setUsageAttributes(
  span: Span,
  response: Record<string, unknown>
): void {
  const usage = response.usage as Record<string, unknown> | undefined;
  if (!usage) return;

  const promptTokens = usage.prompt_tokens || usage.input_tokens;
  if (promptTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_PROMPT_TOKENS,
      Number(promptTokens)
    );
  }

  const completionTokens = usage.completion_tokens || usage.output_tokens;
  if (completionTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_COMPLETION_TOKENS,
      Number(completionTokens)
    );
  }

  const totalTokens = usage.total_tokens;
  if (totalTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_TOTAL_TOKENS,
      Number(totalTokens)
    );
  }

  const cacheTokens = (
    (usage.prompt_tokens_details || usage.input_tokens_details) as {
      cached_tokens?: unknown;
    }
  )?.cached_tokens;
  if (cacheTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_CACHE_READ_INPUT_TOKENS,
      Number(cacheTokens)
    );
  }

  const reasoningTokens = (
    (usage.completion_tokens_details || usage.output_tokens_details) as {
      reasoning_tokens?: unknown;
    }
  )?.reasoning_tokens;
  if (reasoningTokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_REASONING_TOKENS,
      Number(reasoningTokens)
    );
  }
}

function _setResponseMessageAttributes(
  span: Span,
  response: Record<string, unknown>
): void {
  let messageIndex = 0;
  if (response.output_text) {
    span.setAttribute(
      `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.role`,
      "assistant"
    );
    span.setAttribute(
      `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.content`,
      String(response.output_text)
    );
  }

  if (response.output !== undefined) {
    for (let element of response.output as Array<Record<string, unknown>>) {
      if (element.content === undefined) continue;
      for (let chunk of element.content as Array<Record<string, unknown>>) {
        if (chunk.text === undefined) continue;
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.role`,
          "assistant"
        );
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.content`,
          String(chunk.text)
        );
        messageIndex += 1;
      }
    }
  }

  // Handle choices
  const choices = response.choices as Array<Record<string, any>> | undefined;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const message = choice.message;
      if (message !== undefined) {
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.role`,
          message.role ?? "assistant"
        );
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.content`,
          String(message.content ?? "")
        );
        messageIndex++;
      } else {
        const delta = choice.delta;
        if (delta !== undefined) {
          span.setAttribute(
            `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.role`,
            delta.role ?? "assistant"
          );
          span.setAttribute(
            `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.content`,
            String(delta.content ?? "")
          );
          messageIndex++;
        }
      }

      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${messageIndex}.finish_reason`,
          choice.finish_reason
        );
      }
    }
  }
}
