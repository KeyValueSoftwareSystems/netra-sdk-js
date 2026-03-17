import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import {
  MeterProvider,
  PeriodicExportingMetricReader
} from "@opentelemetry/sdk-metrics";
import { Config } from "./config";

export class MeterSetup {
  static setup(config: Config): MeterProvider | undefined {
    if (!config.enableMetrics) {
      return undefined;
    }

    const endpoint = config.formatOtlpMetricsEndpoint();
    if (!endpoint) {
      console.warn(
        "Metrics enabled but OTLP endpoint is not configured; skipping meter setup.",
      );
      return undefined;
    }

    const exporterOptions: Record<string, unknown> = {
      url: endpoint,
      headers: config.headers
    };

    // Keep this as a runtime-compatible assignment for OTel package version differences.
    (exporterOptions as any).temporalityPreference = "delta";

    const exporter = new OTLPMetricExporter(exporterOptions as any);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: config.metricsExportIntervalMs
    });

    const meterProvider = new MeterProvider({
      readers: [reader]
    });

    metrics.setGlobalMeterProvider(meterProvider);
    return meterProvider;
  }
}
