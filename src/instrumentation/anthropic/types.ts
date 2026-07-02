import { TracerProvider } from "@opentelemetry/api";

export type AnthropicRequestType = "chat" | "beta" | "batches";

export const SPAN_NAMES = {
  CHAT: "anthropic.chat",
  STREAM: "anthropic.stream",
  BATCHES: "anthropic.batches",
  BETA: "anthropic.beta",
  BETA_STREAM: "anthropic.beta.stream",
  BETA_TOOL_RUNNER: "anthropic.beta.tool.runner",
} as const;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}
