import { SpanType } from "../../types";
import { MAX_STRINGIFY_LENGTH } from "./constants";
import { AgentSpan, SpanData } from "./types";

export function safeJsonStringify(obj: unknown, maxLength: number = MAX_STRINGIFY_LENGTH): string {
  try {
    if (typeof obj === "string") {
      return maxLength > 0 && obj.length > maxLength ? obj.slice(0, maxLength) : obj;
    }
    const s = JSON.stringify(obj);
    return maxLength > 0 && s.length > maxLength ? s.slice(0, maxLength) : s;
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

export function extractContentString(content: unknown): string {
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

export function extractInstructions(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const resp = response as Record<string, unknown>;
  if (typeof resp.instructions === "string" && resp.instructions.length > 0) {
    return resp.instructions;
  }
  return undefined;
}
