import { TracerProvider } from "@opentelemetry/api";

export type GoogleGenAIRequestType = "chat" | "embedding";

export const SPAN_NAMES = {
  CHAT: "google_genai.chat",
  EMBEDDING: "google_genai.embedding",
} as const;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}
