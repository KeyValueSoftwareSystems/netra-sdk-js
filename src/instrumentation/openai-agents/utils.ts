import { SpanType } from "../../types";
import { AgentSpan, SpanData } from "./types";
import { safeStringify } from "../../utils/serialization";

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
  if (data.type === "handoff" && data.to_agent)
    return `handoff to ${data.to_agent}`;
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
    return texts.length > 0 ? texts.join(" ") : safeStringify(content);
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
