/**
 * Span Wrapper for custom span tracking
 *
 * SpanWrapper now uses ContextStore for concurrency-safe session management.
 * If no context exists when start() is called, a new isolated context
 * will be created automatically.
 */

import {
  Span,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
} from "@opentelemetry/api";
import { Config } from "./config";
import { SessionManager } from "./session-manager";
import { SpanType, UsageModel, ActionModel } from "./types";
import { ContextStore } from "./context-store";

export class SpanWrapper {
  private name: string;
  private attributes: Record<string, string>;
  private moduleName: string;
  private startTime?: number;
  private endTime?: number;
  private status: string = "pending";
  private errorMessage?: string;
  private span?: Span;
  private activeContext?: ReturnType<typeof context.active>;
  private contextCreatedByUs: boolean = false;

  constructor(
    name: string,
    attributes: Record<string, string> = {},
    moduleName: string = "netra_sdk",
    asType: SpanType = SpanType.SPAN
  ) {
    this.name = name;
    this.attributes = { ...attributes };
    this.moduleName = moduleName;
    this.attributes["netra.span.type"] = asType;
  }

  start(): this {
    // Ensure we have a context for session isolation
    // If no context exists, we'll track that we need to be careful
    // Note: We can't create a context that persists after start() returns,
    // so we just ensure SessionManager uses the fallback context
    if (!ContextStore.hasContext()) {
      this.contextCreatedByUs = true;
    }

    this.startTime = Date.now();
    const tracer = trace.getTracer(this.moduleName);
    this.activeContext = context.active();

    this.span = tracer.startSpan(this.name, {
      kind: SpanKind.CLIENT,
      attributes: this.attributes,
    }, this.activeContext);

    if (this.span) {
      SessionManager.registerSpan(this.name, this.span);
      SessionManager.setCurrentSpan(this.span);
    }

    return this;
  }

  end(): this {
    this.endTime = Date.now();
    const durationMs =
      this.startTime && this.endTime
        ? (this.endTime - this.startTime) / 1000
        : undefined;

    if (durationMs !== undefined) {
      this.setAttribute(
        `${Config.LIBRARY_NAME}.duration_ms`,
        durationMs.toFixed(2)
      );
    }

    if (this.status === "pending") {
      this.status = "success";
      if (this.span) {
        this.span.setStatus({ code: SpanStatusCode.OK });
      }
    }

    this.setAttribute(`${Config.LIBRARY_NAME}.status`, this.status);

    if (this.span) {
      // Update all attributes
      for (const [key, value] of Object.entries(this.attributes)) {
        this.span.setAttribute(key, value);
      }

      SessionManager.unregisterSpan(this.name, this.span);
      this.span.end();
    }

    return this;
  }

  setAttribute(key: string, value: string): this {
    this.attributes[key] = value;
    if (this.span) {
      this.span.setAttribute(key, value);
    }
    return this;
  }

  setPrompt(prompt: string): this {
    return this.setAttribute(`${Config.LIBRARY_NAME}.prompt`, prompt);
  }

  setNegativePrompt(negativePrompt: string): this {
    return this.setAttribute(
      `${Config.LIBRARY_NAME}.negative_prompt`,
      negativePrompt
    );
  }

  setUsage(usage: UsageModel[]): this {
    const usageJson = JSON.stringify(usage);
    return this.setAttribute(`${Config.LIBRARY_NAME}.usage`, usageJson);
  }

  setAction(action: ActionModel[]): this {
    const actionJson = JSON.stringify(action);
    return this.setAttribute(`${Config.LIBRARY_NAME}.action`, actionJson);
  }

  setModel(model: string): this {
    return this.setAttribute(`${Config.LIBRARY_NAME}.model`, model);
  }

  setLlmSystem(system: string): this {
    return this.setAttribute(`${Config.LIBRARY_NAME}.llm_system`, system);
  }

  setError(errorMessage: string): this {
    this.status = "error";
    this.errorMessage = errorMessage;
    if (this.span) {
      this.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
      });
    }
    return this.setAttribute(
      `${Config.LIBRARY_NAME}.error_message`,
      errorMessage
    );
  }

  setSuccess(): this {
    this.status = "success";
    if (this.span) {
      this.span.setStatus({ code: SpanStatusCode.OK });
    }
    return this;
  }

  addEvent(name: string, attributes?: Record<string, string>): this {
    if (this.span) {
      this.span.addEvent(name, attributes);
    }
    return this;
  }

  getCurrentSpan(): Span | undefined {
    return this.span;
  }
}
