export type GoogleGenAIRequestType = "chat" | "embedding";

export const SPAN_NAMES = {
  CHAT: "google_genai.chat",
  EMBEDDING: "google_genai.embedding",
} as const;
