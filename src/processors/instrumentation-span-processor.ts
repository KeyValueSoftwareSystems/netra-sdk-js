/**
 * Instrumentation Span Processor
 * 
 * OpenTelemetry span processor that:
 * 1. Records the raw instrumentation scope name for each span
 * 2. Truncates attribute values to prevent oversized payloads
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
  private maxAttributeLength: number;

  constructor(maxAttributeLength?: number) {
    this.maxAttributeLength = maxAttributeLength ?? Config.ATTRIBUTE_MAX_LEN;
  }

  /**
   * Detect the raw instrumentation name from the span's instrumentation scope.
   */
  private detectRawInstrumentationName(span: Span): string | null {
    try {
      // Access the instrumentation scope from the span
      // In JS SDK, this is typically available via the span's internal properties
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
              // Fall through to return the full name
            }
          }
          return name;
        }
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /**
   * Truncate a value to the maximum allowed length.
   * Handles strings, bytes, and recursively handles lists and objects.
   */
  private truncateValue(value: unknown): unknown {
    try {
      if (typeof value === "string") {
        return value.length <= this.maxAttributeLength
          ? value
          : value.substring(0, this.maxAttributeLength);
      }

      if (Array.isArray(value)) {
        return value.map((v) =>
          typeof v === "string" ? this.truncateValue(v) : v
        );
      }

      if (typeof value === "object" && value !== null) {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
          result[k] = typeof v === "string" ? this.truncateValue(v) : v;
        }
        return result;
      }
    } catch {
      return value;
    }
    return value;
  }

  /**
   * Called when a span starts. Wraps setAttribute to truncate values
   * and records the instrumentation name.
   */
  onStart(span: Span, parentContext: Context): void {
    try {
      // Wrap setAttribute to truncate values
      const originalSetAttribute = span.setAttribute.bind(span);

      span.setAttribute = (key: string, value: unknown): Span => {
        try {
          const truncated = this.truncateValue(value);
          return originalSetAttribute(key, truncated as any);
        } catch {
          // Best-effort; never break span
          try {
            return originalSetAttribute(key, value as any);
          } catch {
            return span;
          }
        }
      };

      // Set instrumentation name attribute
      const name = this.detectRawInstrumentationName(span);
      if (name && ALLOWED_INSTRUMENTATION_NAMES.has(name.toLowerCase())) {
        span.setAttribute(`${Config.LIBRARY_NAME}.instrumentation.name`, name);
      }
    } catch (e) {
      Logger.error(
        "InstrumentationSpanProcessor: Error on span start:",
        e
      );
    }
  }

  /**
   * Called when a span ends. No-op for this processor.
   */
  onEnd(span: ReadableSpan): void {
    // No-op
  }

  /**
   * Shuts down the processor.
   */
  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Forces a flush of any pending spans.
   */
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
