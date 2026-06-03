import { Tracer, TracerProvider } from "@opentelemetry/api";

export type OpenAIRequestType = "chat" | "embedding" | "response";

export interface Message {
  role: string;
  content: string;
}

export type WrapperFn = (
  wrapped: (...args: unknown[]) => unknown,
  instance: unknown,
  args: unknown[],
  kwargs: Record<string, unknown> & { stream?: boolean },
) => unknown;

export type StreamResponse = {
  choices: Array<Record<string, unknown>>;
  model: string;
  usage?: unknown;
};

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

export interface PatchTarget {
  key: string;
  getPrototype: (OpenAI: any) => any;
  wrapperFactory: (tracer: Tracer) => WrapperFn;
  optional?: boolean;
}

