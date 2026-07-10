/**
 * Instrumentation Span Processor
 *
 * OpenTelemetry span processor that records the raw instrumentation scope
 * name for each span. This enables downstream processors and the dashboard
 * to identify which provider/framework produced a given span.
 */

import { Context, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Config } from "../config";
import { Logger } from "../logger";

// Allowed instrumentation names that we recognize and tag
const ALLOWED_INSTRUMENTATION_NAMES = new Set([
  "openai",
  "openai_agents",
  "groq",
  "mistral_ai",
  "mistralai",
  "google_genai",
  "google_generative_ai",
  "langchain",
  "llama_index",
  "pinecone",
  "qdrant",
  "chromadb",
  "together",
  "vertexai",
  "cohere_ai",
  "litellm",
  "dspy",
  "pydantic_ai",
  "weaviate_db",
  "fastapi",
  "adk",
  "httpx",
  "aiohttp",
  "undici",
  "fetch",
  "cerebras",
  "deepgram",
  "cartesia",
  "elevenlabs",
]);

export class InstrumentationSpanProcessor implements SpanProcessor {
  private detectRawInstrumentationName(span: Span): string | null {
    try {
      const spanAny = span as any;
      const scope =
        spanAny.instrumentationLibrary || spanAny.instrumentationScope;

      if (scope) {
        const name = scope.name;
        if (typeof name === "string" && name) {
          // Extract the base name from fully qualified names
          if (
            name.startsWith("opentelemetry.instrumentation.") ||
            name.startsWith("netra.instrumentation.") ||
            name.startsWith("@opentelemetry/instrumentation-") ||
            name.startsWith("@traceloop/instrumentation-")
          ) {
            try {
              // Get the last segment
              const segments = name.split(/[./\-]/);
              const base = segments[segments.length - 1]?.trim();
              if (base) {
                return base;
              }
            } catch {
              Logger.warn("InstrumentationSpanProcessor: Error extracting base name:", name);
            }
          }
          return name;
        }
      }
    } catch {
      Logger.warn("InstrumentationSpanProcessor: Error detecting instrumentation name:", span);
    }
    return null;
  }

  onStart(span: Span, _parentContext: Context): void {
    try {
      const name = this.detectRawInstrumentationName(span);
      if (name && ALLOWED_INSTRUMENTATION_NAMES.has(name.toLowerCase())) {
        span.setAttribute(`${Config.LIBRARY_NAME}.instrumentation.name`, name);
      }
    } catch (e) {
      Logger.error(
        "InstrumentationSpanProcessor: Error on span start:",
        e,
      );
    }
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
