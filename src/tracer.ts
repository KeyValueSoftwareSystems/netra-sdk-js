import { trace, Tracer as OtelTracer } from "@opentelemetry/api";
import { Config } from "./config";

export class Tracer {
  readonly tracer: OtelTracer;

  constructor(cfg: Config, effectiveProvider?: any) {
    if (effectiveProvider && typeof effectiveProvider.getTracer === "function") {
      this.tracer = effectiveProvider.getTracer(Config.LIBRARY_NAME, Config.LIBRARY_VERSION);
    } else {
      this.tracer = trace.getTracer(Config.LIBRARY_NAME, Config.LIBRARY_VERSION);
    }
  }
}
