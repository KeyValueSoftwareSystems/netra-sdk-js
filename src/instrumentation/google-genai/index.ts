/**
 * Custom Google GenAI instrumentor for Netra SDK.
 *
 * The @google/genai SDK defines public Models methods (generateContent, etc.)
 * as instance arrow functions that delegate to *Internal prototype methods.
 * We patch the Internal methods on Models.prototype and the public methods
 * on Chat.prototype to produce OTel spans.
 */

import { createRequire } from "module";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import shimmer from "shimmer";
import { Logger } from "../../logger";
import { InstrumentorOptions } from "./types";
import { __version__ } from "./version";
import {
  chatStreamWrapper,
  chatWrapper,
  embeddingsWrapper,
} from "./wrappers";

const INSTRUMENTATION_NAME = "netra.instrumentation.google_genai";
const INSTRUMENTS = ["@google/genai >= 1.0.0"];

let isInstrumented = false;

interface ResolvedClasses {
  Models: any;
  Chat?: any;
}

// Collects class sets from both ESM and CJS so dual-package setups
// are fully covered.  Each entry is a distinct set of classes that
// must be patched independently.
let allResolvedSets: ResolvedClasses[] = [];

/**
 * Extract Models and Chat classes from a loaded module.
 * Returns null when the module does not expose a usable Models class.
 */
function extractClasses(mod: any): ResolvedClasses | null {
  const result: Partial<ResolvedClasses> = {};
  const root = mod.default ?? mod;

  if (root.Models) result.Models = root.Models;
  if (root.Chat) result.Chat = root.Chat;

  return result.Models ? (result as ResolvedClasses) : null;
}

/**
 * Resolve @google/genai module from both ESM and CJS.
 * Both are attempted independently; if they resolve to distinct class
 * objects each is kept so that both module‑system codepaths are patched.
 */
async function resolveModule(): Promise<ResolvedClasses[]> {
  if (allResolvedSets.length > 0) return allResolvedSets;

  try {
    // @ts-ignore — @google/genai is an optional peer dependency
    const esmModule = await import("@google/genai");
    const classes = extractClasses(esmModule);
    if (classes) {
      allResolvedSets.push(classes);
    }
  } catch {
    Logger.warn("Failed to resolve Google GenAI ESM module");
  }

  try {
    const req = createRequire(import.meta.url);
    const cjsModule = req("@google/genai");
    const classes = extractClasses(cjsModule);
    if (classes) {
      // Only add if the CJS Models class is distinct from any ESM one
      const isDuplicate = allResolvedSets.some(
        (existing) => existing.Models === classes.Models,
      );
      if (!isDuplicate) {
        allResolvedSets.push(classes);
      }
    }
  } catch {
    Logger.warn("Failed to resolve Google GenAI CJS module");
  }

  return allResolvedSets;
}

/**
 * Instrumentor for Google GenAI SDK.
 */
export class NetraGoogleGenAIInstrumentor {
  private tracer: Tracer | null = null;
  private tracerProvider?: TracerProvider;

  instrumentationDependencies(): string[] {
    return [...INSTRUMENTS];
  }

  async instrument(
    options: InstrumentorOptions = {},
  ): Promise<NetraGoogleGenAIInstrumentor> {
    if (isInstrumented) {
      Logger.warn("Google GenAI is already instrumented");
      return this;
    }

    const classSets = await resolveModule();
    if (classSets.length === 0) {
      return this;
    }

    try {
      this.tracerProvider = options.tracerProvider;
      this.tracer = this.tracerProvider
        ? this.tracerProvider.getTracer(INSTRUMENTATION_NAME, __version__)
        : trace.getTracer(INSTRUMENTATION_NAME, __version__);
    } catch (error) {
      Logger.error(`Failed to initialize tracer: ${error}`);
      return this;
    }

    classSets.forEach((classSet) => {
      this._instrumentModels(classSet.Models);
      if (classSet.Chat) this._instrumentChat(classSet.Chat);
    });

    isInstrumented = true;
    return this;
  }

  uninstrument(): void {
    if (!isInstrumented) {
      Logger.warn("Google GenAI is not instrumented");
      return;
    }

    allResolvedSets.forEach((classes) => {
      this._uninstrumentModels(classes.Models);
      if (classes.Chat) this._uninstrumentChat(classes.Chat);
    });

    allResolvedSets = [];
    isInstrumented = false;
  }

  isInstrumented(): boolean {
    return isInstrumented;
  }

  private _instrumentModels(ModelsClass: any): void {
    if (!this.tracer) return;
    try {
      const proto = ModelsClass.prototype;
      if (!proto) {
        Logger.error(
          "Google GenAI instrumentation: Models.prototype not found",
        );
        return;
      }

      // The public methods (generateContent, etc.) are instance arrow
      // functions set in the constructor, so shimmer cannot wrap them on
      // the prototype.  They delegate to *Internal prototype methods which
      // ARE on the prototype and receive the same params shape.
      if (typeof proto.generateContentInternal === "function") {
        shimmer.wrap(
          proto,
          "generateContentInternal",
          chatWrapper(this.tracer),
        );
      }
      if (typeof proto.generateContentStreamInternal === "function") {
        shimmer.wrap(
          proto,
          "generateContentStreamInternal",
          chatStreamWrapper(this.tracer),
        );
      }
      if (typeof proto.embedContentInternal === "function") {
        shimmer.wrap(
          proto,
          "embedContentInternal",
          embeddingsWrapper(this.tracer),
        );
      }
    } catch (error) {
      Logger.error(
        `Google GenAI instrumentation: Models patch failed: ${error}`,
      );
    }
  }

  private _instrumentChat(ChatClass: any): void {
    if (!this.tracer) return;
    try {
      const proto = ChatClass.prototype;
      if (!proto) {
        Logger.error("Google GenAI instrumentation: Chat.prototype not found");
        return;
      }

      if (typeof proto.sendMessage === "function") {
        shimmer.wrap(proto, "sendMessage", chatWrapper(this.tracer));
      }
      if (typeof proto.sendMessageStream === "function") {
        shimmer.wrap(
          proto,
          "sendMessageStream",
          chatStreamWrapper(this.tracer),
        );
      }
    } catch (error) {
      Logger.error(`Google GenAI instrumentation: Chat patch failed: ${error}`);
    }
  }

  private _uninstrumentModels(ModelsClass: any): void {
    try {
      const proto = ModelsClass?.prototype;
      if (!proto) return;
      if (typeof proto.generateContentInternal === "function")
        shimmer.unwrap(proto, "generateContentInternal");
      if (typeof proto.generateContentStreamInternal === "function")
        shimmer.unwrap(proto, "generateContentStreamInternal");
      if (typeof proto.embedContentInternal === "function")
        shimmer.unwrap(proto, "embedContentInternal");
    } catch (error) {
      Logger.error(`Failed to uninstrument Google GenAI Models: ${error}`);
    }
  }

  private _uninstrumentChat(ChatClass: any): void {
    try {
      const proto = ChatClass?.prototype;
      if (!proto) return;
      if (typeof proto.sendMessage === "function")
        shimmer.unwrap(proto, "sendMessage");
      if (typeof proto.sendMessageStream === "function")
        shimmer.unwrap(proto, "sendMessageStream");
    } catch (error) {
      Logger.error(`Failed to uninstrument Google GenAI Chat: ${error}`);
    }
  }
}

export const googleGenAIInstrumentor = new NetraGoogleGenAIInstrumentor();
