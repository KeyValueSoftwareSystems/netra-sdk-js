import { createRequire } from "module";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { NetraLogger } from "../../netraLogger";
import { __version__ } from "./version";
import { systemOneWrapper } from "./wrappers";

// The exported OpenTelemetry scope name is a wire contract -- dashboards and
// backend queries key off it, and the root-instrument filter maps its last
// segment to `NetraInstruments.TYPESAFE` -- so it must match the Python SDK.
const INSTRUMENTATION_NAME = "netra.instrumentation.typesafe";
const SUPPORTED_VERSIONS = ["@typesafe-ai/sdk >= 0.7.0"];
const MODULE_NAME = "@typesafe-ai/sdk";
const METHOD = "systemOne";

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

let typeSafeClientClasses: any[] = [];

/**
 * Resolve `TypeSafeClient` from the application's context.
 * The package ships separate ESM and CommonJS builds, so an app can load
 * either (or both); each is a distinct class and is patched on its own.
 */
async function resolveTypeSafeClients(): Promise<any[]> {
  if (typeSafeClientClasses.length > 0) return typeSafeClientClasses;

  try {
    // @ts-ignore - @typesafe-ai/sdk is an optional peer dependency
    const mod = await import("@typesafe-ai/sdk");
    if (mod?.TypeSafeClient) typeSafeClientClasses.push(mod.TypeSafeClient);
  } catch {
    NetraLogger.debug("TypeSafe SDK ESM module not available");
  }

  try {
    const req = createRequire(import.meta.url);
    const cjsClass = req(MODULE_NAME)?.TypeSafeClient;
    if (cjsClass && !typeSafeClientClasses.includes(cjsClass)) {
      typeSafeClientClasses.push(cjsClass);
    }
  } catch {
    NetraLogger.debug("TypeSafe SDK CJS module not available");
  }

  return typeSafeClientClasses;
}

/**
 * Instrumentor for the TypeSafe AI JavaScript SDK (`@typesafe-ai/sdk`), which serves the Jev models.
 *
 * One `typesafe.system_one` CLIENT span is created per `systemOne` call on
 * `TypeSafeClient`. Libraries built on the SDK are covered through the same call.
 */
export class NetraTypeSafeInstrumentor {
  private tracer: Tracer | null = null;
  private static _isInstrumented = false;
  private readonly originalMethods = new Map<any, Function>();

  instrumentationDependencies(): string[] {
    return [...SUPPORTED_VERSIONS];
  }

  isInstrumented(): boolean {
    return NetraTypeSafeInstrumentor._isInstrumented;
  }

  async instrument(options: InstrumentorOptions = {}): Promise<NetraTypeSafeInstrumentor> {
    if (this.isInstrumented()) {
      NetraLogger.warn("TypeSafe is already instrumented");
      return this;
    }

    try {
      const provider = options.tracerProvider;
      this.tracer = provider
        ? provider.getTracer(INSTRUMENTATION_NAME, __version__)
        : trace.getTracer(INSTRUMENTATION_NAME, __version__);
    } catch (error) {
      NetraLogger.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    const clientClasses = await resolveTypeSafeClients();
    if (clientClasses.length === 0) {
      NetraLogger.debug("TypeSafe SDK not installed; skipping instrumentation");
      return this;
    }
    clientClasses.forEach((clientClass) => this.patch(clientClass));

    NetraTypeSafeInstrumentor._isInstrumented = true;
    return this;
  }

  async uninstrument(): Promise<void> {
    if (!this.isInstrumented()) {
      NetraLogger.warn("TypeSafe is not instrumented");
      return;
    }

    for (const [proto, original] of this.originalMethods) {
      try {
        proto[METHOD] = original;
      } catch (error) {
        NetraLogger.error(`Failed to uninstrument TypeSafe ${METHOD}: ${error}`);
      }
    }

    this.originalMethods.clear();
    typeSafeClientClasses.length = 0;
    NetraTypeSafeInstrumentor._isInstrumented = false;
  }

  private patch(clientClass: any): void {
    if (!this.tracer) return;

    const proto = clientClass?.prototype;
    const original = proto?.[METHOD];
    if (typeof original !== "function") {
      NetraLogger.error(`Failed to find TypeSafe method to patch: TypeSafeClient.${METHOD}`);
      return;
    }

    try {
      const wrapper = systemOneWrapper(this.tracer);
      this.originalMethods.set(proto, original);
      proto[METHOD] = function (this: unknown, ...args: unknown[]): unknown {
        return wrapper(original as (...a: unknown[]) => unknown, this, args);
      };
    } catch (error) {
      NetraLogger.error(`Failed to instrument TypeSafe ${METHOD}: ${error}`);
    }
  }
}

export const typeSafeInstrumentor = new NetraTypeSafeInstrumentor();

export { systemOneWrapper, SYSTEM_ONE_SPAN_NAME } from "./wrappers";
export { setRequestAttributes, setResponseAttributes } from "./utils";
export { __version__ } from "./version";
