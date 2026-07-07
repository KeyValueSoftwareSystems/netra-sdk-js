/**
 * Google Generative AI (@google/generative-ai) instrumentor for Netra SDK.
 *
 * Patches GenerativeModel.prototype methods (generateContent,
 * generateContentStream, embedContent) and ChatSession.prototype
 * methods (sendMessage, sendMessageStream) to produce OTel spans.
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
} from "./wrappers";

interface GoogleGenerativeAIClasses {
  GenerativeModel: any;
  ChatSession?: any;
}

export class NetraGoogleGenerativeAIInstrumentor extends BaseInstrumentor<GoogleGenerativeAIClasses> {
  protected readonly instrumentationName = "netra.instrumentation.google_generative_ai";
  protected readonly instrumentationVersion = __version__;
  protected readonly packageName = "@google/generative-ai";
  protected readonly displayName = "Google Generative AI";

  protected extractClasses(mod: any): GoogleGenerativeAIClasses | null {
    const root = mod.default ?? mod;
    const GenerativeModel =
      root.GenerativeModel ?? root;
    if (!GenerativeModel?.prototype) return null;
    return { GenerativeModel, ChatSession: root.ChatSession };
  }

  protected isSameClasses(a: GoogleGenerativeAIClasses, b: GoogleGenerativeAIClasses): boolean {
    return a.GenerativeModel === b.GenerativeModel;
  }

  protected applyPatches(classes: GoogleGenerativeAIClasses, tracer: Tracer): boolean {
    const proto = classes.GenerativeModel?.prototype;
    if (!proto) {
      Logger.error("Google Generative AI: GenerativeModel.prototype not found");
      return false;
    }

    let wrapped = false;

    if (typeof proto.generateContent === "function") {
      shimmer.wrap(proto, "generateContent", chatWrapper(tracer));
      wrapped = true;
    }
    if (typeof proto.generateContentStream === "function") {
      shimmer.wrap(proto, "generateContentStream", chatStreamWrapper(tracer));
      wrapped = true;
    }
    if (typeof proto.embedContent === "function") {
      shimmer.wrap(proto, "embedContent", embeddingsWrapper(tracer));
      wrapped = true;
    }

    const chatProto = classes.ChatSession?.prototype;
    if (chatProto) {
      if (typeof chatProto.sendMessage === "function") {
        shimmer.wrap(chatProto, "sendMessage", chatWrapper(tracer));
        wrapped = true;
      }
      if (typeof chatProto.sendMessageStream === "function") {
        shimmer.wrap(chatProto, "sendMessageStream", chatStreamWrapper(tracer));
        wrapped = true;
      }
    }

    return wrapped;
  }

  protected removePatches(classes: GoogleGenerativeAIClasses): void {
    const proto = classes.GenerativeModel?.prototype;
    if (proto) {
      if (typeof proto.generateContent === "function")
        shimmer.unwrap(proto, "generateContent");
      if (typeof proto.generateContentStream === "function")
        shimmer.unwrap(proto, "generateContentStream");
      if (typeof proto.embedContent === "function")
        shimmer.unwrap(proto, "embedContent");
    }

    const chatProto = classes.ChatSession?.prototype;
    if (chatProto) {
      if (typeof chatProto.sendMessage === "function")
        shimmer.unwrap(chatProto, "sendMessage");
      if (typeof chatProto.sendMessageStream === "function")
        shimmer.unwrap(chatProto, "sendMessageStream");
    }
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

export { chatWrapper, chatStreamWrapper, embeddingsWrapper } from "./wrappers";
export { setRequestAttributes, setResponseAttributes } from "./utils";
export { __version__ } from "./version";
