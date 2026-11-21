/**
 * Instrumentation Span Processor
 *
 * OpenTelemetry span processor that records the raw instrumentation scope
 * name for each span. This enables downstream processors and the dashboard
 * to identify which provider/framework produced a given span.
 *
 * It also drops the usage attributes of spans from cost-excluded
 * instrumentations (`costExcludedInstruments`), so the backend records no cost
 * for them and the call is priced only from the span the user reports it on.
 */

import { AttributeValue, Attributes, Context, Span } from "@opentelemetry/api";
import { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Config, NetraInstruments } from "../config";
import { NetraLogger } from "../netraLogger";
import { canonicalInstrumentName } from "./root-instrument-filter-processor";

type SetAttributeFn = (key: string, value: AttributeValue) => Span;

// Usage attributes the backend prices a span from. `netra.usage` is matched
// exactly, so `netra.usage.source` (not priced) is kept.
const CUSTOM_USAGE_ATTRIBUTE = `${Config.LIBRARY_NAME}.usage`;
const AUDIO_DURATION_ATTRIBUTE = "gen_ai.audio.duration";
// Prefixes rather than a key list: every instrumentation writes usage under
// different keys, and the backend reads both cache spellings and the per-TTL counts.
const USAGE_ATTRIBUTE_PREFIXES = ["gen_ai.usage.", "llm.usage."];

function isUsageAttribute(key: string): boolean {
  return (
    key === CUSTOM_USAGE_ATTRIBUTE ||
    key === AUDIO_DURATION_ATTRIBUTE ||
    USAGE_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * Canonical names of the cost-excluded instrumentations. `ALL` expands to
 * every instrumentation, the same way `blockInstruments` treats it.
 */
function resolveCostExcludedNames(
  costExcludedInstruments: ReadonlySet<NetraInstruments> | undefined,
): ReadonlySet<string> {
  if (!costExcludedInstruments || costExcludedInstruments.size === 0) {
    return new Set();
  }
  const instruments = costExcludedInstruments.has(NetraInstruments.ALL)
    ? Object.values(NetraInstruments).filter((member) => member !== NetraInstruments.ALL)
    : [...costExcludedInstruments];
  return new Set(instruments.map((member) => canonicalInstrumentName(member)));
}

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
  private readonly costExcludedNames: ReadonlySet<string>;

  /**
   * @param costExcludedInstruments Instrumentations whose spans are exported
   *   without usage attributes. Omitted or empty excludes nothing.
   */
  constructor(costExcludedInstruments?: ReadonlySet<NetraInstruments>) {
    this.costExcludedNames = resolveCostExcludedNames(costExcludedInstruments);
  }

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
              NetraLogger.debug("InstrumentationSpanProcessor: Error extracting base name:", name);
            }
          }
          return name;
        }
      }
    } catch {
      NetraLogger.debug("InstrumentationSpanProcessor: Error detecting instrumentation name");
    }
    return null;
  }

  onStart(span: Span, _parentContext: Context): void {
    try {
      const name = this.detectRawInstrumentationName(span);
      if (name && this.costExcludedNames.has(canonicalInstrumentName(name))) {
        this.dropUsageAttributes(span);
      }
      if (name && ALLOWED_INSTRUMENTATION_NAMES.has(name.toLowerCase())) {
        span.setAttribute(`${Config.LIBRARY_NAME}.instrumentation.name`, name);
      }
    } catch (e) {
      NetraLogger.error(
        "InstrumentationSpanProcessor: Error on span start:",
        e,
      );
    }
  }

  /**
   * Removes usage attributes already on the span and drops any written later.
   *
   * This runs at write time, not in `onEnd`: Traceloop registers the exporting
   * processor before Netra's, so its `onEnd` runs first, and with
   * `disableBatch` `SimpleSpanProcessor` starts the export there. This
   * processor is registered after the setAttribute wrappers, so this wrapper is
   * the outermost one and usage keys never reach SpanIOProcessor's aliasing.
   * OTel's `setAttributes` loops over `setAttribute`, so it is covered too.
   */
  private dropUsageAttributes(span: Span): void {
    // Attributes passed to startSpan are written in the Span constructor,
    // before onStart; the SDK span keeps them on a mutable `attributes` object.
    const existing = (span as Partial<Pick<ReadableSpan, "attributes">>).attributes;
    if (existing) {
      const mutable = existing as Attributes;
      for (const key of Object.keys(mutable).filter(isUsageAttribute)) {
        delete mutable[key];
      }
    }

    const original: SetAttributeFn = span.setAttribute.bind(span);
    const dropping = (key: string, value: AttributeValue): Span =>
      isUsageAttribute(key) ? span : original(key, value);
    (span as { setAttribute: SetAttributeFn }).setAttribute = dropping;
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
