import { trace, Tracer as OtelTracer } from "@opentelemetry/api";
import { Config, NetraInstruments } from "./config";
import { initInstrumentations } from "./instrumentation";

export class Tracer {
  readonly tracer: OtelTracer;

  constructor(
    cfg: Config,
    instruments?: Set<NetraInstruments>,
    blockInstruments?: Set<NetraInstruments>,
  ) {
    const effectiveProvider = initInstrumentations(cfg, instruments, blockInstruments);
    if (effectiveProvider && typeof (effectiveProvider as any).getTracer === "function") {
      this.tracer = (effectiveProvider as any).getTracer(Config.LIBRARY_NAME, Config.LIBRARY_VERSION);
    } else {
      this.tracer = trace.getTracer(Config.LIBRARY_NAME, Config.LIBRARY_VERSION);
    }
  }
}
