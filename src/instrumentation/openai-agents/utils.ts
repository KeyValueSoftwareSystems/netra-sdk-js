import { Span as OTelSpan } from "@opentelemetry/api";
import { SpanType } from "../../types";
import { SpanAttributes } from "../span-attributes";
import {
  GEN_AI_AGENT_NAME,
  GEN_AI_RESPONSE_ID,
  GEN_AI_TOOL_NAME,
  NETRA_AGENT_HANDOFFS,
  NETRA_AGENT_NAME,
  NETRA_AGENT_OUTPUT_TYPE,
  NETRA_AGENT_TOOLS,
  NETRA_CUSTOM_DATA,
  NETRA_GUARDRAIL_NAME,
  NETRA_GUARDRAIL_TRIGGERED,
  NETRA_HANDOFF_SOURCE_AGENT,
  NETRA_HANDOFF_TARGET_AGENT,
  NETRA_MCP_DATA,
  NETRA_MCP_SERVER,
  NETRA_SPAN_NAME,
  NETRA_SPAN_TYPE_ATTR,
} from "./constants";
import { AgentSpan, SpanData } from "./types";

export function safeJsonStringify(obj: unknown): string {
  try {
    if (typeof obj === "string") return obj;
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

export function getNetraSpanType(data: SpanData): SpanType {
  switch (data.type) {
    case "agent":
      return SpanType.AGENT;
    case "generation":
    case "response":
      return SpanType.GENERATION;
    case "function":
    case "mcp_list_tools":
      return SpanType.TOOL;
    case "handoff":
      return SpanType.HANDOFF;
    case "guardrail":
      return SpanType.GUARDRAIL;
    default:
      return SpanType.SPAN;
  }
}

export function getSpanName(agentSpan: AgentSpan): string {
  const data = agentSpan.spanData;
  if (data.name) return data.name;
  if (data.type === "handoff" && data.to_agent) return `handoff to ${data.to_agent}`;
  return `openai.agents.${data.type}`;
}

export function setSpanDataAttributes(otelSpan: OTelSpan, agentSpan: AgentSpan): void {
  const data = agentSpan.spanData;
  otelSpan.setAttribute(NETRA_SPAN_TYPE_ATTR, getNetraSpanType(data));

  switch (data.type) {
    case "agent":
      setAgentAttributes(otelSpan, data);
      break;
    case "generation":
      setGenerationAttributes(otelSpan, data);
      break;
    case "response":
      setResponseAttributes(otelSpan, agentSpan);
      break;
    case "function":
      setFunctionAttributes(otelSpan, data);
      break;
    case "handoff":
      setHandoffAttributes(otelSpan, data);
      break;
    case "guardrail":
      setGuardrailAttributes(otelSpan, data);
      break;
    case "mcp_list_tools":
      setMCPListToolsAttributes(otelSpan, data);
      break;
    default:
      setCustomAttributes(otelSpan, data);
      break;
  }
}

function setAgentAttributes(span: OTelSpan, data: SpanData): void {
  if (data.name) {
    span.setAttribute(NETRA_AGENT_NAME, data.name);
    span.setAttribute(GEN_AI_AGENT_NAME, data.name);
  }
  if (data.handoffs && data.handoffs.length > 0) {
    span.setAttribute(NETRA_AGENT_HANDOFFS, data.handoffs.join(", "));
  }
  if (data.tools && data.tools.length > 0) {
    span.setAttribute(NETRA_AGENT_TOOLS, data.tools.join(", "));
  }
  if (data.output_type) {
    span.setAttribute(NETRA_AGENT_OUTPUT_TYPE, data.output_type);
  }
}

function setGenerationAttributes(span: OTelSpan, data: SpanData): void {
  span.setAttribute(SpanAttributes.LLM_SYSTEM, "openai");
  span.setAttribute(SpanAttributes.LLM_REQUEST_TYPE, "chat");

  if (data.model) {
    span.setAttribute(SpanAttributes.LLM_REQUEST_MODEL, data.model);
    span.setAttribute(SpanAttributes.LLM_RESPONSE_MODEL, data.model);
  }

  if (data.model_config) {
    const config = data.model_config;
    if (config.temperature !== undefined) {
      span.setAttribute(SpanAttributes.LLM_REQUEST_TEMPERATURE, Number(config.temperature));
    }
    if (config.max_tokens !== undefined) {
      span.setAttribute(SpanAttributes.LLM_REQUEST_MAX_TOKENS, Number(config.max_tokens));
    }
    if (config.top_p !== undefined) {
      span.setAttribute(SpanAttributes.LLM_REQUEST_TOP_P, Number(config.top_p));
    }
    if (config.frequency_penalty !== undefined) {
      span.setAttribute(SpanAttributes.LLM_FREQUENCY_PENALTY, Number(config.frequency_penalty));
    }
    if (config.presence_penalty !== undefined) {
      span.setAttribute(SpanAttributes.LLM_PRESENCE_PENALTY, Number(config.presence_penalty));
    }
    if (config.stop !== undefined) {
      span.setAttribute(SpanAttributes.LLM_CHAT_STOP_SEQUENCES, safeJsonStringify(config.stop));
    }
    if (config.reasoning_effort !== undefined) {
      span.setAttribute(SpanAttributes.LLM_REQUEST_REASONING_EFFORT, String(config.reasoning_effort));
    } else if (config.reasoning !== undefined) {
      span.setAttribute(SpanAttributes.LLM_REQUEST_REASONING_EFFORT, safeJsonStringify(config.reasoning));
    }
  }

  if (data.usage) {
    setUsageAttributes(span, data.usage);
  }

  if (data.input !== undefined) {
    setIndexedPromptAttributes(span, data.input);
  }
  if (data.output !== undefined) {
    setIndexedCompletionAttributes(span, data.output);
  }
}

function setResponseAttributes(span: OTelSpan, agentSpan: AgentSpan): void {
  const data = agentSpan.spanData;
  span.setAttribute(SpanAttributes.LLM_SYSTEM, "openai");
  span.setAttribute(SpanAttributes.LLM_REQUEST_TYPE, "response");

  if (data.response_id) {
    span.setAttribute(GEN_AI_RESPONSE_ID, data.response_id);
  }

  let promptStartIndex = 0;

  const instructions = extractInstructions(data._response);
  if (instructions) {
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.0.role`, "system");
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.0.content`, instructions);
    promptStartIndex = 1;
  }

  if (data._input !== undefined) {
    setIndexedPromptAttributes(span, data._input, promptStartIndex);
  }

  if (data._response) {
    setResponseObjectAttributes(span, data._response);
    setIndexedCompletionAttributes(span, data._response);
  }

  // Only fall back to data.usage if _response didn't already provide usage.
  // This avoids double-writing the same attributes with potentially different values.
  const resp = data._response as Record<string, unknown> | undefined;
  if (data.usage && !(resp && typeof resp === "object" && resp.usage)) {
    setUsageAttributes(span, data.usage);
  }
}

function setFunctionAttributes(span: OTelSpan, data: SpanData): void {
  if (data.name) {
    span.setAttribute(GEN_AI_TOOL_NAME, data.name);
  }
  if (data.mcp_data) {
    span.setAttribute(NETRA_MCP_DATA, data.mcp_data);
  }
  if (data.input !== undefined) {
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.0.role`, "tool");
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.0.content`, safeJsonStringify(data.input));
  }
  if (data.output !== undefined) {
    span.setAttribute(`${SpanAttributes.LLM_COMPLETIONS}.0.role`, "tool");
    span.setAttribute(`${SpanAttributes.LLM_COMPLETIONS}.0.content`, safeJsonStringify(data.output));
  }
}

function setHandoffAttributes(span: OTelSpan, data: SpanData): void {
  if (data.from_agent) {
    span.setAttribute(NETRA_HANDOFF_SOURCE_AGENT, data.from_agent);
  }
  if (data.to_agent) {
    span.setAttribute(NETRA_HANDOFF_TARGET_AGENT, data.to_agent);
  }
}

function setGuardrailAttributes(span: OTelSpan, data: SpanData): void {
  if (data.name) {
    span.setAttribute(NETRA_GUARDRAIL_NAME, data.name);
  }
  if (data.triggered !== undefined) {
    span.setAttribute(NETRA_GUARDRAIL_TRIGGERED, data.triggered);
  }
}

function setMCPListToolsAttributes(span: OTelSpan, data: SpanData): void {
  if (data.server) {
    span.setAttribute(GEN_AI_TOOL_NAME, data.server);
    span.setAttribute(NETRA_MCP_SERVER, data.server);
  }
}

function setCustomAttributes(span: OTelSpan, data: SpanData): void {
  if (data.name) {
    span.setAttribute(NETRA_SPAN_NAME, data.name);
  }
  if (data.data !== undefined) {
    span.setAttribute(NETRA_CUSTOM_DATA, safeJsonStringify(data.data));
  }
}

function setUsageAttributes(
  span: OTelSpan,
  usage: NonNullable<SpanData["usage"]>,
): void {
  if (usage.input_tokens !== undefined) {
    span.setAttribute(SpanAttributes.LLM_USAGE_PROMPT_TOKENS, usage.input_tokens);
  }
  if (usage.output_tokens !== undefined) {
    span.setAttribute(SpanAttributes.LLM_USAGE_COMPLETION_TOKENS, usage.output_tokens);
  }
  if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
    span.setAttribute(
      SpanAttributes.LLM_USAGE_TOTAL_TOKENS,
      usage.input_tokens + usage.output_tokens,
    );
  }

  if (usage.details) {
    const details = usage.details;
    if (details.cached_tokens !== undefined) {
      span.setAttribute(SpanAttributes.LLM_USAGE_CACHE_READ_INPUT_TOKENS, Number(details.cached_tokens));
    }
    if (details.reasoning_tokens !== undefined) {
      span.setAttribute(SpanAttributes.LLM_USAGE_REASONING_TOKENS, Number(details.reasoning_tokens));
    }
  }
}

interface ResponseObject {
  model?: string;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  reasoning?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    name?: string;
    arguments?: string;
    call_id?: string;
    id?: string;
  }>;
}

function setResponseObjectAttributes(span: OTelSpan, response: unknown): void {
  if (!response || typeof response !== "object") return;
  const resp = response as ResponseObject;

  if (resp.model) {
    span.setAttribute(SpanAttributes.LLM_REQUEST_MODEL, resp.model);
    span.setAttribute(SpanAttributes.LLM_RESPONSE_MODEL, resp.model);
  }

  if (resp.temperature !== undefined) {
    span.setAttribute(SpanAttributes.LLM_REQUEST_TEMPERATURE, resp.temperature);
  }
  if (resp.top_p !== undefined) {
    span.setAttribute(SpanAttributes.LLM_REQUEST_TOP_P, resp.top_p);
  }
  if (resp.frequency_penalty !== undefined) {
    span.setAttribute(SpanAttributes.LLM_FREQUENCY_PENALTY, resp.frequency_penalty);
  }
  if (resp.presence_penalty !== undefined) {
    span.setAttribute(SpanAttributes.LLM_PRESENCE_PENALTY, resp.presence_penalty);
  }
  if (resp.reasoning !== undefined) {
    span.setAttribute(SpanAttributes.LLM_REQUEST_REASONING_EFFORT, safeJsonStringify(resp.reasoning));
  }

  // Usage from the response object is set here; the caller should NOT also
  // call setUsageAttributes for the same span to avoid double-writes.
  if (resp.usage) {
    setResponseObjectUsageAttributes(span, resp.usage);
  }
}

function setResponseObjectUsageAttributes(
  span: OTelSpan,
  usage: NonNullable<ResponseObject["usage"]>,
): void {
  if (usage.input_tokens !== undefined) {
    span.setAttribute(SpanAttributes.LLM_USAGE_PROMPT_TOKENS, usage.input_tokens);
  }
  if (usage.output_tokens !== undefined) {
    span.setAttribute(SpanAttributes.LLM_USAGE_COMPLETION_TOKENS, usage.output_tokens);
  }
  if (usage.total_tokens !== undefined) {
    span.setAttribute(SpanAttributes.LLM_USAGE_TOTAL_TOKENS, usage.total_tokens);
  } else if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
    span.setAttribute(SpanAttributes.LLM_USAGE_TOTAL_TOKENS, usage.input_tokens + usage.output_tokens);
  }
  if (usage.input_tokens_details?.cached_tokens !== undefined) {
    span.setAttribute(SpanAttributes.LLM_USAGE_CACHE_READ_INPUT_TOKENS, usage.input_tokens_details.cached_tokens);
  }
  if (usage.output_tokens_details?.reasoning_tokens !== undefined) {
    span.setAttribute(SpanAttributes.LLM_USAGE_REASONING_TOKENS, usage.output_tokens_details.reasoning_tokens);
  }
}

function extractInstructions(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const resp = response as Record<string, unknown>;
  if (typeof resp.instructions === "string" && resp.instructions.length > 0) {
    return resp.instructions;
  }
  return undefined;
}

function setIndexedPromptAttributes(span: OTelSpan, input: unknown, startIndex = 0): void {
  if (!input) return;

  if (typeof input === "string") {
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${startIndex}.role`, "user");
    span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${startIndex}.content`, input);
    return;
  }

  if (!Array.isArray(input)) return;

  let index = startIndex;
  for (const message of input) {
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    const msgType = msg.type as string | undefined;

    if (msgType === "function_call") {
      span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${index}.role`, "assistant");
      span.setAttribute(
        `${SpanAttributes.LLM_PROMPTS}.${index}.content`,
        safeJsonStringify({ name: msg.name, arguments: msg.arguments }),
      );
    } else if (msgType === "function_call_output" || msgType === "function_call_result") {
      span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${index}.role`, "tool");
      const output = msg.output;
      const outputText = output && typeof output === "object" && (output as Record<string, unknown>).text
        ? String((output as Record<string, unknown>).text)
        : String(output ?? "");
      span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${index}.content`, outputText);
    } else {
      const role = (msg.role as string) || "user";
      const content = extractContentString(msg.content);
      span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${index}.role`, role);
      span.setAttribute(`${SpanAttributes.LLM_PROMPTS}.${index}.content`, content);
    }
    index++;
  }
}

function extractContentString(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        const part = item as Record<string, unknown>;
        if (part.text !== undefined) {
          texts.push(String(part.text));
        }
      }
    }
    return texts.length > 0 ? texts.join(" ") : safeJsonStringify(content);
  }
  return String(content);
}

function setIndexedCompletionAttributes(span: OTelSpan, responseData: unknown): void {
  if (!responseData || typeof responseData !== "object") return;
  const resp = responseData as Record<string, unknown>;

  // Responses API format: output[] with message and function_call items
  if (Array.isArray(resp.output)) {
    let index = 0;
    for (const item of resp.output) {
      if (!item || typeof item !== "object") continue;
      const element = item as Record<string, unknown>;

      if (element.type === "message" && Array.isArray(element.content)) {
        for (const contentItem of element.content as Array<Record<string, unknown>>) {
          if (contentItem.type === "output_text" && contentItem.text) {
            span.setAttribute(`${SpanAttributes.LLM_COMPLETIONS}.${index}.role`, "assistant");
            span.setAttribute(`${SpanAttributes.LLM_COMPLETIONS}.${index}.content`, String(contentItem.text));
            index++;
          }
        }
      } else if (element.type === "function_call") {
        span.setAttribute(`${SpanAttributes.LLM_COMPLETIONS}.${index}.role`, "assistant");
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${index}.content`,
          safeJsonStringify({ name: element.name, arguments: element.arguments }),
        );
        const toolCallId = element.call_id || element.id;
        if (toolCallId) {
          span.setAttribute(`${SpanAttributes.LLM_COMPLETIONS}.${index}.tool_call_id`, String(toolCallId));
        }
        index++;
      }
    }
    return;
  }

  // Chat Completions format: choices[] with message/delta
  if (Array.isArray(resp.choices)) {
    let index = 0;
    for (const choice of resp.choices) {
      if (!choice || typeof choice !== "object") continue;
      const c = choice as Record<string, unknown>;
      const message = (c.message || c.delta) as Record<string, unknown> | undefined;
      const startIndex = index;

      if (message) {
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${index}.role`,
          String(message.role ?? "assistant"),
        );
        span.setAttribute(
          `${SpanAttributes.LLM_COMPLETIONS}.${index}.content`,
          String(message.content ?? ""),
        );
        index++;

        const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            const func = (tc.function || {}) as Record<string, unknown>;
            span.setAttribute(`${SpanAttributes.LLM_COMPLETIONS}.${index}.role`, "assistant");
            span.setAttribute(
              `${SpanAttributes.LLM_COMPLETIONS}.${index}.content`,
              safeJsonStringify({ name: func.name ?? "", arguments: func.arguments ?? "" }),
            );
            if (tc.id) {
              span.setAttribute(`${SpanAttributes.LLM_COMPLETIONS}.${index}.tool_call_id`, String(tc.id));
            }
            index++;
          }
        }
      }

      if (c.finish_reason) {
        span.setAttribute(`${SpanAttributes.LLM_COMPLETIONS}.${startIndex}.finish_reason`, String(c.finish_reason));
      }
    }
  }
}
