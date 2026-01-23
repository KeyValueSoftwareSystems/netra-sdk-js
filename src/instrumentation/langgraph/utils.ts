import { Span } from "@opentelemetry/api";
import { ChainValues } from "@langchain/core/utils/types";
import { SpanAttributes } from "../span-attributes";

const NetraLanggraphAttributes = {
  spanType: "netra.span.type",
  entityInput: "netra.entity.input",
  entityOutput: "netra.entity.output",
} as const;

const tagFilter = (tag: string) => {
  const filterableTags = ["langsmith:hidden"];
  return !filterableTags.includes(tag);
};

const metadataFilter = (key: string) => {
  return !key.startsWith("__");
};

export function setInvokeInputAttributes(
  span: Span,
  inputs: Record<string, any>,
): void {
  span.setAttribute(
    NetraLanggraphAttributes.entityInput,
    JSON.stringify({ inputs }),
  );
}

export function setInvokeOutputAttributes(
  span: Span,
  outputs: Record<string, any>,
): void {
  span.setAttribute(
    NetraLanggraphAttributes.entityOutput,
    JSON.stringify({ outputs }),
  );
}

export function setLlmRequestAttributes(
  span: Span,
  metadata: Record<string, any>,
  prompts: string[],
  extraParams: Record<string, any>,
): void {
  setLlmPrompts(span, prompts);
  const attributeMappings = mapLlmAttributes(metadata, extraParams);
  for (let [key, value] of Object.entries(attributeMappings)) {
    if (value !== undefined) {
      span.setAttribute(key, value);
    }
  }
}

export function setChainInputAttributes(
  span: Span,
  inputs: ChainValues,
  tags?: string[],
  metadata?: Record<string, unknown>,
): void {
  const entityInputs: Record<string, any> = { inputs };

  if (tags) {
    const filteredTags = tags.filter(tagFilter);
    if (filteredTags.length > 0) {
      entityInputs["tags"] = filteredTags;
    }
  }

  if (metadata) {
    const filteredMetadata: Record<string, any> = {};
    const kwargs: Record<string, any> = {};

    for (const [key, value] of Object.entries(metadata)) {
      if (metadataFilter(key)) filteredMetadata[key] = value;
      if (key === "langgraph_node") kwargs.name = value;
    }

    entityInputs["metadata"] = filteredMetadata;
    if (Object.keys(kwargs).length > 0) {
      entityInputs["kwargs"] = kwargs;
    }
  }
  span.setAttribute(
    NetraLanggraphAttributes.entityInput,
    JSON.stringify(entityInputs),
  );
}

export function setChainOutputAttributes(
  span: Span,
  outputs: ChainValues,
  tags?: string[],
): void {
  const entityOutputs: Record<string, any> = { outputs };
  if (tags) {
    const filteredTags = tags.filter(tagFilter);
    if (filteredTags.length > 0) {
      console.log("FILTERED TAGS:", filteredTags);
      entityOutputs["kwargs"] = { tags: filteredTags };
    }
  }
  span.setAttribute(
    NetraLanggraphAttributes.entityOutput,
    JSON.stringify(entityOutputs),
  );
}

export function setToolAttributes(
  span: Span,
  toolName: string,
  input: Record<string, any>,
  output: string,
  metadata?: Record<string, any>,
  tags?: string[],
): void {
  span.setAttribute(NetraLanggraphAttributes.spanType, "TOOL");
  const filteredTags = tags?.filter(tagFilter) ?? [];
  const filteredMetadata: Record<string, any> = {};

  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (metadataFilter(key)) filteredMetadata[key] = value;
    }
  }

  const entityInputs: Record<string, any> = {
    input_str: JSON.stringify(input),
    metadata: filteredMetadata,
    tags: filteredTags,
  };

  const entityOutputs: Record<string, any> = {
    output,
    kwargs: { name: toolName, tags: filteredTags },
  };

  span.setAttribute(
    NetraLanggraphAttributes.entityInput,
    JSON.stringify(entityInputs),
  );
  span.setAttribute(
    NetraLanggraphAttributes.entityOutput,
    JSON.stringify(entityOutputs),
  );
}

function mapLlmAttributes(
  metadata: Record<string, any>,
  extraParams: Record<string, any>,
): Record<string, any> {
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

function setLlmPrompts(span: Span, prompts: string[]): void {
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
