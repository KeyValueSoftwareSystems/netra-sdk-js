/**
 * Google GenAI instrumentor for Netra SDK.
 *
 * The @google/genai SDK defines public Models methods (generateContent, etc.)
 * as instance arrow functions that delegate to *Internal prototype methods.
 * We patch the Internal methods on Models.prototype and the public methods
 * on Chat.prototype to produce OTel spans.
 *
 * The Decisions API (`client.decisions`, @google/genai >= 3.6) lives on a class
 * the package does not export: `GoogleGenAI.prototype.decisions` is a getter
 * that lazily builds it. That getter is replaced with one that, on first
 * access, wraps `create` on the resource's prototype, so every client's
 * `decisions.create` is traced. Older releases without the getter are skipped.
 */

import { Tracer } from "@opentelemetry/api";
import shimmer from "shimmer";
import { NetraLogger } from "../../netraLogger";
import { BaseInstrumentor } from "../base-instrumentor";
import { __version__ } from "./version";
import {
  chatStreamWrapper,
  chatWrapper,
  decisionsWrapper,
  embeddingsWrapper,
} from "./wrappers";

interface GoogleGenAIClasses {
  Models: any;
  Chat?: any;
  GoogleGenAI?: any;
}

/** What patching one `GoogleGenAI.prototype.decisions` getter changed, so it can be undone. */
interface DecisionsPatch {
  getter: PropertyDescriptor;
  wrappedPrototypes: Set<any>;
}

const DECISIONS_PROPERTY = "decisions";

export class NetraGoogleGenAIInstrumentor extends BaseInstrumentor<GoogleGenAIClasses> {
  // Keyed by GoogleGenAI.prototype: the ESM and CJS builds each have their own.
  private readonly decisionsPatches = new Map<any, DecisionsPatch>();

  protected readonly instrumentationName = "netra.instrumentation.google_genai";
  protected readonly instrumentationVersion = __version__;
  protected readonly packageName = "@google/genai";
  protected readonly displayName = "Google GenAI";

  protected extractClasses(mod: any): GoogleGenAIClasses | null {
    const root = mod.default ?? mod;
    if (!root.Models) return null;
    return { Models: root.Models, Chat: root.Chat, GoogleGenAI: root.GoogleGenAI };
  }

  protected isSameClasses(a: GoogleGenAIClasses, b: GoogleGenAIClasses): boolean {
    return a.Models === b.Models;
  }

  protected applyPatches(classes: GoogleGenAIClasses, tracer: Tracer): boolean {
    const modelsProto = classes.Models?.prototype;
    if (!modelsProto) {
      NetraLogger.error("Google GenAI: Models.prototype not found");
      return false;
    }

    let wrapped = false;

    // Public methods are instance arrow functions set in the constructor,
    // so shimmer cannot wrap them on the prototype. They delegate to
    // *Internal prototype methods which ARE on the prototype.
    if (typeof modelsProto.generateContentInternal === "function") {
      shimmer.wrap(modelsProto, "generateContentInternal", chatWrapper(tracer));
      wrapped = true;
    }
    if (typeof modelsProto.generateContentStreamInternal === "function") {
      shimmer.wrap(modelsProto, "generateContentStreamInternal", chatStreamWrapper(tracer));
      wrapped = true;
    }
    if (typeof modelsProto.embedContentInternal === "function") {
      shimmer.wrap(modelsProto, "embedContentInternal", embeddingsWrapper(tracer));
      wrapped = true;
    }

    const chatProto = classes.Chat?.prototype;
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

    if (this.patchDecisions(classes.GoogleGenAI?.prototype, tracer)) {
      wrapped = true;
    }

    return wrapped;
  }

  /**
   * Replace the `decisions` getter so the resource's `create` is wrapped on first access.
   *
   * @returns true when the getter was patched; false on releases without the Decisions API.
   */
  private patchDecisions(clientProto: any, tracer: Tracer): boolean {
    if (!clientProto || this.decisionsPatches.has(clientProto)) return false;
    const getter = Object.getOwnPropertyDescriptor(clientProto, DECISIONS_PROPERTY);
    if (!getter?.get || !getter.configurable) return false;

    const patch: DecisionsPatch = { getter, wrappedPrototypes: new Set() };
    const originalGet = getter.get;
    try {
      Object.defineProperty(clientProto, DECISIONS_PROPERTY, {
        configurable: true,
        enumerable: getter.enumerable,
        get(this: unknown) {
          const resource = originalGet.call(this);
          try {
            const resourceProto = resource ? Object.getPrototypeOf(resource) : undefined;
            if (
              resourceProto &&
              typeof resourceProto.create === "function" &&
              !resourceProto.create.__wrapped
            ) {
              shimmer.wrap(resourceProto, "create", decisionsWrapper(tracer));
              patch.wrappedPrototypes.add(resourceProto);
            }
          } catch (error) {
            NetraLogger.error("Google GenAI: failed to instrument decisions.create", error);
          }
          return resource;
        },
      });
    } catch (error) {
      NetraLogger.error("Google GenAI: failed to patch the decisions getter", error);
      return false;
    }
    this.decisionsPatches.set(clientProto, patch);
    return true;
  }

  /** Restore the original `decisions` getter and unwrap every `create` it wrapped. */
  private unpatchDecisions(clientProto: any): void {
    const patch = clientProto ? this.decisionsPatches.get(clientProto) : undefined;
    if (!patch) return;
    Object.defineProperty(clientProto, DECISIONS_PROPERTY, patch.getter);
    for (const resourceProto of patch.wrappedPrototypes) {
      if (resourceProto.create?.__wrapped) shimmer.unwrap(resourceProto, "create");
    }
    this.decisionsPatches.delete(clientProto);
  }

  protected removePatches(classes: GoogleGenAIClasses): void {
    this.unpatchDecisions(classes.GoogleGenAI?.prototype);

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
