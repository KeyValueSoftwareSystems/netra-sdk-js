import { TracerProvider } from "@opentelemetry/api";

export type AnthropicRequestType = "chat" | "beta" | "batches";

export const SPAN_NAMES = {
  CHAT: "anthropic.chat",
  BETA: "anthropic.beta",
  BATCHES: "anthropic.batches",
  STREAM: "anthropic.stream",
  BETA_STREAM: "anthropic.beta.stream",
  TOOL_RUNNER: "anthropic.toolRunner",
} as const;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}
