import { context, Context, Span } from "@opentelemetry/api";
import { SpanAttributes } from "../span-attributes";

export function runWithContext(func: () => any, spanContext?: Context) {
  return spanContext ? context.with(spanContext, func) : func();
}

export function setLlmRequestAttributes(
  span: Span,
  metadata: Record<string, any>,
  prompts: string[],
  extraParams: Record<string, any>,
) {
  setLlmPrompts(span, prompts);
  const attributeMappings = mapLlmAttributes(metadata, extraParams);
  for (let [key, value] of Object.entries(attributeMappings)) {
    if (value !== undefined) {
      span.setAttribute(key, value);
    }
  }
}

function mapLlmAttributes(
  metadata: Record<string, any>,
  extraParams: Record<string, any>,
) {
  const options = extraParams?.invocation_params?.options || {};

  return {
    [SpanAttributes.LLM_REQUEST_MODEL]: options.model || metadata.ls_model_name,
    [SpanAttributes.LLM_REQUEST_TEMPERATURE]:
      options.temperature ?? metadata.ls_temperature,
    [SpanAttributes.LLM_REQUEST_MAX_TOKENS]:
      options.num_predict ?? metadata.ls_max_tokens,
    [SpanAttributes.LLM_FREQUENCY_PENALTY]: options.frequency_penalty,
    [SpanAttributes.LLM_PRESENCE_PENALTY]: options.presence_penalty,
    [SpanAttributes.LLM_CHAT_STOP_SEQUENCES]: options.stop ?? metadata.ls_stop,
    [SpanAttributes.LLM_REQUEST_TOP_P]: options.top_p,
  };
}

function setLlmPrompts(span: Span, prompts: string[]) {
  const seperator = ":";
  const roleMap: Record<string, string> = { human: "user" };

  prompts.forEach((prompt, index) => {
    const [role, ...rest] = prompt.split(seperator);
    const content = rest.join(seperator);

    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${index}.role`,
      roleMap[role.toLowerCase()] ?? role,
    );
    span.setAttribute(
      `${SpanAttributes.LLM_PROMPTS}.${index}.content`,
      content,
    );
  });
}
