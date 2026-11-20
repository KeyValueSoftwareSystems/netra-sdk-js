export type GoogleGenAIRequestType = "chat" | "embedding" | "decision";

export const SPAN_NAMES = {
  CHAT: "google_genai.chat",
  EMBEDDING: "google_genai.embedding",
  DECISION: "google_genai.decision",
} as const;
