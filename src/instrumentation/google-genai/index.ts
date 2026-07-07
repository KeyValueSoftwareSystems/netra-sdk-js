/**
 * Google GenAI instrumentor for Netra SDK.
 *
 * The @google/genai SDK defines public Models methods (generateContent, etc.)
 * as instance arrow functions that delegate to *Internal prototype methods.
 * We patch the Internal methods on Models.prototype and the public methods
 * on Chat.prototype to produce OTel spans.
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

interface GoogleGenAIClasses {
  Models: any;
  Chat?: any;
}

export class NetraGoogleGenAIInstrumentor extends BaseInstrumentor<GoogleGenAIClasses> {
  protected readonly instrumentationName = "netra.instrumentation.google_genai";
  protected readonly instrumentationVersion = __version__;
  protected readonly packageName = "@google/genai";
  protected readonly displayName = "Google GenAI";

  protected extractClasses(mod: any): GoogleGenAIClasses | null {
    const root = mod.default ?? mod;
    if (!root.Models) return null;
    return { Models: root.Models, Chat: root.Chat };
  }

  protected isSameClasses(a: GoogleGenAIClasses, b: GoogleGenAIClasses): boolean {
    return a.Models === b.Models;
  }

  protected applyPatches(classes: GoogleGenAIClasses, tracer: Tracer): boolean {
    const modelsProto = classes.Models?.prototype;
    if (!modelsProto) {
      Logger.error("Google GenAI: Models.prototype not found");
      return false;
    }

    // Public methods are instance arrow functions set in the constructor,
    // so shimmer cannot wrap them on the prototype. They delegate to
    // *Internal prototype methods which ARE on the prototype.
    if (typeof modelsProto.generateContentInternal === "function") {
      shimmer.wrap(modelsProto, "generateContentInternal", chatWrapper(tracer));
    }
    if (typeof modelsProto.generateContentStreamInternal === "function") {
      shimmer.wrap(modelsProto, "generateContentStreamInternal", chatStreamWrapper(tracer));
    }
    if (typeof modelsProto.embedContentInternal === "function") {
      shimmer.wrap(modelsProto, "embedContentInternal", embeddingsWrapper(tracer));
    }

    const chatProto = classes.Chat?.prototype;
    if (chatProto) {
      if (typeof chatProto.sendMessage === "function") {
        shimmer.wrap(chatProto, "sendMessage", chatWrapper(tracer));
      }
      if (typeof chatProto.sendMessageStream === "function") {
        shimmer.wrap(chatProto, "sendMessageStream", chatStreamWrapper(tracer));
      }
    }

    return true;
  }

  protected removePatches(classes: GoogleGenAIClasses): void {
    const modelsProto = classes.Models?.prototype;
    if (modelsProto) {
      if (typeof modelsProto.generateContentInternal === "function")
        shimmer.unwrap(modelsProto, "generateContentInternal");
      if (typeof modelsProto.generateContentStreamInternal === "function")
        shimmer.unwrap(modelsProto, "generateContentStreamInternal");
      if (typeof modelsProto.embedContentInternal === "function")
        shimmer.unwrap(modelsProto, "embedContentInternal");
    }

    const chatProto = classes.Chat?.prototype;
    if (chatProto) {
      if (typeof chatProto.sendMessage === "function")
        shimmer.unwrap(chatProto, "sendMessage");
      if (typeof chatProto.sendMessageStream === "function")
        shimmer.unwrap(chatProto, "sendMessageStream");
    }
  }
}

export const googleGenAIInstrumentor = new NetraGoogleGenAIInstrumentor();
