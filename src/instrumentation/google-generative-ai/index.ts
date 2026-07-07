/**
 * Google Generative AI (@google/generative-ai) instrumentor for Netra SDK.
 *
 * Patches GenerativeModel.prototype methods (generateContent,
 * generateContentStream, embedContent, startChat) to produce OTel spans.
 */

import { Tracer } from "@opentelemetry/api";
import shimmer from "shimmer";
import { Logger } from "../../logger";
import { BaseInstrumentor } from "../base-instrumentor";
import { __version__ } from "./version";
import {
  chatStreamWrapper,
  chatWrapper,
  embeddingsWrapper,
  startChatWrapper,
  unpatchChatSessions,
} from "./wrappers";

export class NetraGoogleGenerativeAIInstrumentor extends BaseInstrumentor<any> {
  protected readonly instrumentationName = "netra.instrumentation.google_generative_ai";
  protected readonly instrumentationVersion = __version__;
  protected readonly packageName = "@google/generative-ai";
  protected readonly displayName = "Google Generative AI";

  protected extractClasses(mod: any): any | null {
    const cls =
      mod.GenerativeModel ??
      mod.default?.GenerativeModel ??
      mod.default ??
      mod;
    return cls?.prototype ? cls : null;
  }

  protected applyPatches(GenerativeModel: any, tracer: Tracer): boolean {
    const proto = GenerativeModel?.prototype;
    if (!proto) {
      Logger.error("Google Generative AI: GenerativeModel.prototype not found");
      return false;
    }

    shimmer.wrap(proto, "generateContent", chatWrapper(tracer));
    shimmer.wrap(proto, "generateContentStream", chatStreamWrapper(tracer));
    shimmer.wrap(proto, "embedContent", embeddingsWrapper(tracer));

    if (typeof proto.startChat === "function") {
      shimmer.wrap(proto, "startChat", startChatWrapper(tracer));
    }

    return true;
  }

  protected removePatches(GenerativeModel: any): void {
    const proto = GenerativeModel?.prototype;
    if (!proto) return;

    if (typeof proto.generateContent === "function")
      shimmer.unwrap(proto, "generateContent");
    if (typeof proto.generateContentStream === "function")
      shimmer.unwrap(proto, "generateContentStream");
    if (typeof proto.embedContent === "function")
      shimmer.unwrap(proto, "embedContent");
    if (typeof proto.startChat === "function")
      shimmer.unwrap(proto, "startChat");
  }

  protected onUninstrument(): void {
    unpatchChatSessions();
  }

  /**
   * @deprecated Use instrument() instead. Kept for backward compatibility
   * with orchestrator call sites that haven't been updated yet.
   */
  async instrumentAsync(
    options: { tracerProvider?: any } = {},
  ): Promise<this> {
    return this.instrument(options);
  }
}

export const googleGenerativeAIInstrumentor =
  new NetraGoogleGenerativeAIInstrumentor();

export { chatWrapper, chatStreamWrapper, embeddingsWrapper, startChatWrapper, unpatchChatSessions } from "./wrappers";
export { setRequestAttributes, setResponseAttributes } from "./utils";
export { __version__ } from "./version";
