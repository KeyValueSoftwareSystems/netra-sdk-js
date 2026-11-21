import { Attributes } from "@opentelemetry/api";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  ReadableSpan,
  SimpleSpanProcessor,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { NetraInstruments } from "../config";
import { InstrumentationSpanProcessor } from "./instrumentation-span-processor";
import { SpanIOProcessor } from "./span-io-processor";

const OPENAI_SCOPE = "netra.instrumentation.openai";
const ANTHROPIC_SCOPE = "netra.instrumentation.anthropic";
const TRACELOOP_MISTRAL_SCOPE = "@traceloop/instrumentation-mistralai";
const MANUAL_SCOPE = "netra_sdk";

const CUSTOM_USAGE = JSON.stringify([
  { model: "anthropic/claude-sonnet-4.6", usage_type: "total", cost_in_usd: 0.14 },
]);

const USAGE_ATTRIBUTES: Attributes = {
  "netra.usage": CUSTOM_USAGE,
  "gen_ai.usage.prompt_tokens": 120,
  "gen_ai.usage.completion_tokens": 30,
  "gen_ai.usage.total_tokens": 150,
  "gen_ai.usage.input_tokens": 120,
  "gen_ai.usage.output_tokens": 30,
  "gen_ai.usage.cache_read_input_tokens": 10,
  "gen_ai.usage.cache_read.input_tokens": 10,
  "gen_ai.usage.cache_creation_input_tokens_5m": 4,
  "gen_ai.usage.prompt.character_count": 512,
  "llm.usage.total_tokens": 150,
  "gen_ai.audio.duration": 1.5,
};

// What a span keeps when nothing strips it: SpanIOProcessor renames the semconv
// input/output token keys to prompt/completion, which are already present.
const USAGE_AFTER_SPAN_IO: Attributes = Object.fromEntries(
  Object.entries(USAGE_ATTRIBUTES).filter(
    ([key]) => key !== "gen_ai.usage.input_tokens" && key !== "gen_ai.usage.output_tokens",
  ),
);

const KEPT_ATTRIBUTES: Attributes = {
  "gen_ai.request.model": "anthropic/claude-sonnet-4.6",
  "gen_ai.performance.time_to_first_token": 0.2,
  "netra.usage.source": "framework",
};

/**
 * Copies each span's attributes at export time. An exporter that kept the
 * span reference would also see attributes deleted after export started, so
 * it could not catch a strip that runs too late.
 */
class SnapshotExporter implements SpanExporter {
  readonly exported: Attributes[] = [];

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) {
      this.exported.push({ ...span.attributes });
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Mirrors production order: Traceloop registers the exporting processor before
 * Netra adds its own, and the SpanIO wrapper is registered before the
 * instrumentation processor.
 */
function buildProvider(
  exporter: SnapshotExporter,
  costExcludedInstruments?: Set<NetraInstruments>,
): BasicTracerProvider {
  return new BasicTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor(exporter),
      new SpanIOProcessor(),
      new InstrumentationSpanProcessor(costExcludedInstruments),
    ],
  });
}

function emitSpan(
  provider: BasicTracerProvider,
  scope: string,
  options: { setLater?: Attributes; atCreation?: Attributes; viaSetAttributes?: boolean } = {},
): void {
  const span = provider.getTracer(scope).startSpan("chat", { attributes: options.atCreation });
  const later = options.setLater ?? {};
  if (options.viaSetAttributes) {
    span.setAttributes(later);
  } else {
    for (const [key, value] of Object.entries(later)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
  }
  span.end();
}

function onlyExported(exporter: SnapshotExporter): Attributes {
  expect(exporter.exported).toHaveLength(1);
  return exporter.exported[0] ?? {};
}

function usageKeysPresent(attributes: Attributes): string[] {
  return Object.keys(USAGE_ATTRIBUTES).filter((key) => key in attributes);
}

function pick(attributes: Attributes, keys: string[]): Attributes {
  return Object.fromEntries(keys.map((key) => [key, attributes[key]]));
}

describe("InstrumentationSpanProcessor cost exclusion", () => {
  it("strips usage attributes from an excluded instrumentation's span before export", () => {
    const exporter = new SnapshotExporter();
    emitSpan(buildProvider(exporter, new Set([NetraInstruments.OPENAI])), OPENAI_SCOPE, {
      setLater: { ...USAGE_ATTRIBUTES, ...KEPT_ATTRIBUTES },
    });

    expect(usageKeysPresent(onlyExported(exporter))).toEqual([]);
  });

  it("keeps model, latency, usage source and instrumentation name on an excluded span", () => {
    const exporter = new SnapshotExporter();
    emitSpan(buildProvider(exporter, new Set([NetraInstruments.OPENAI])), OPENAI_SCOPE, {
      setLater: { ...USAGE_ATTRIBUTES, ...KEPT_ATTRIBUTES },
    });

    const attributes = onlyExported(exporter);
    expect(pick(attributes, Object.keys(KEPT_ATTRIBUTES))).toEqual(KEPT_ATTRIBUTES);
    expect(attributes["netra.instrumentation.name"]).toBe("openai");
  });

  it("strips usage passed at span creation", () => {
    const exporter = new SnapshotExporter();
    emitSpan(buildProvider(exporter, new Set([NetraInstruments.OPENAI])), OPENAI_SCOPE, {
      atCreation: { ...USAGE_ATTRIBUTES, ...KEPT_ATTRIBUTES },
    });

    const attributes = onlyExported(exporter);
    expect(usageKeysPresent(attributes)).toEqual([]);
    expect(attributes["gen_ai.request.model"]).toBe(KEPT_ATTRIBUTES["gen_ai.request.model"]);
  });

  it("strips usage set through setAttributes", () => {
    const exporter = new SnapshotExporter();
    emitSpan(buildProvider(exporter, new Set([NetraInstruments.OPENAI])), OPENAI_SCOPE, {
      setLater: USAGE_ATTRIBUTES,
      viaSetAttributes: true,
    });

    expect(usageKeysPresent(onlyExported(exporter))).toEqual([]);
  });

  it("strips usage when the scope name and enum value differ only by underscores", () => {
    const exporter = new SnapshotExporter();
    emitSpan(buildProvider(exporter, new Set([NetraInstruments.MISTRAL])), TRACELOOP_MISTRAL_SCOPE, {
      setLater: USAGE_ATTRIBUTES,
    });

    expect(usageKeysPresent(onlyExported(exporter))).toEqual([]);
  });

  it("keeps usage on a span from an instrumentation that is not excluded", () => {
    const exporter = new SnapshotExporter();
    emitSpan(buildProvider(exporter, new Set([NetraInstruments.OPENAI])), ANTHROPIC_SCOPE, {
      setLater: USAGE_ATTRIBUTES,
    });

    expect(onlyExported(exporter)).toMatchObject(USAGE_AFTER_SPAN_IO);
  });

  it.each([
    ["omitted", undefined],
    ["empty", new Set<NetraInstruments>()],
  ])("keeps usage when the excluded set is %s", (_label, excluded) => {
    const exporter = new SnapshotExporter();
    emitSpan(buildProvider(exporter, excluded), OPENAI_SCOPE, { setLater: USAGE_ATTRIBUTES });

    expect(onlyExported(exporter)).toMatchObject(USAGE_AFTER_SPAN_IO);
  });

  it("strips usage from every instrumentation when ALL is excluded", () => {
    const exporter = new SnapshotExporter();
    const provider = buildProvider(exporter, new Set([NetraInstruments.ALL]));
    emitSpan(provider, OPENAI_SCOPE, { setLater: USAGE_ATTRIBUTES });
    emitSpan(provider, ANTHROPIC_SCOPE, { setLater: USAGE_ATTRIBUTES });

    expect(exporter.exported.map(usageKeysPresent)).toEqual([[], []]);
  });

  it("keeps usage on a manual span when ALL is excluded", () => {
    const exporter = new SnapshotExporter();
    emitSpan(buildProvider(exporter, new Set([NetraInstruments.ALL])), MANUAL_SCOPE, {
      setLater: { "netra.usage": CUSTOM_USAGE },
    });

    expect(onlyExported(exporter)["netra.usage"]).toBe(CUSTOM_USAGE);
  });
});
