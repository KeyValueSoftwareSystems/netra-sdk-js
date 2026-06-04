/**
 * Span Wrapper for custom span tracking
 */

import {
  context,
  propagation,
  Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { Config } from "./config";
import { LOCAL_BLOCKED_SPANS_BAGGAGE_KEY } from "./processors/localfiltering-span-processor";
import { SessionManager } from "./session-manager";
import { ActionModel, SpanAttributes, SpanType, UsageModel } from "./types";

export class SpanWrapper {
  private name: string;
  private attributes: SpanAttributes;
  private moduleName: string;
  private startTime?: number;
  private endTime?: number;
  private status: string = "pending";
  private errorMessage?: string;
  private span?: Span;
  private activeContext?: ReturnType<typeof context.active>;
  private tracer?: any;

  constructor(
    name: string,
    attributes: SpanAttributes = {},
    moduleName: string = "netra_sdk",
    asType: SpanType = SpanType.SPAN,
    tracer?: any,
  ) {
    this.name = name;
    this.attributes = { ...attributes };
    this.moduleName = moduleName;
    this.attributes["netra.span.type"] = asType;
    this.tracer = tracer;
  }

  start(): this {
    this.startTime = Date.now();

    const tracer = this.tracer || trace.getTracer(this.moduleName);

    // Start from the currently active OTel context
    let ctx = context.active();

    // If the caller provided blocked_spans (or the canonical netra.local_blocked_spans key),
    // inject them into OTel baggage so descendant spans inherit the filtering patterns.
    const rawBlockedSpans =
      this.attributes["blocked_spans"] ??
      this.attributes["netra.local_blocked_spans"];

    if (Array.isArray(rawBlockedSpans) && rawBlockedSpans.length > 0) {
      const patterns = (rawBlockedSpans as string[]).filter(Boolean);
      if (patterns.length > 0) {
        const payload = JSON.stringify(patterns);
        const existingBaggage =
          propagation.getBaggage(ctx) ?? propagation.createBaggage();
        const updatedBaggage = existingBaggage.setEntry(
          LOCAL_BLOCKED_SPANS_BAGGAGE_KEY,
          { value: payload },
        );
        ctx = propagation.setBaggage(ctx, updatedBaggage);
      }

      // Remove from attributes — these are control directives, not span metadata
      delete this.attributes["blocked_spans"];
      delete this.attributes["netra.local_blocked_spans"];
    }

    this.span = tracer.startSpan(
      this.name,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          ...this.attributes,
          "netra.span.name": this.name,
        },
      },
      ctx,
    );

    // Store the context with this span (and any baggage) so withActive/withActiveAsync
    // propagate both parent-span and blocking baggage to child spans.
    if (this.span) {
      this.activeContext = trace.setSpan(ctx, this.span);
      SessionManager.registerSpan(this.name, this.span);
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
        durationMs.toFixed(2),
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
      for (const [key, value] of Object.entries(this.attributes)) {
        if (value !== undefined) {
          this.span.setAttribute(key, value);
        }
      }

      SessionManager.unregisterSpan(this.name, this.span);
      this.span.end();
    }

    // Release the stored context so it can be GC'd
    this.activeContext = undefined;

    return this;
  }

  setAttribute(key: string, value: string): this {
    this.attributes[key] = value;
    if (this.span) {
      this.span.setAttribute(key, value);
    }
    return this;
  }

  /**
   * Run a function with this span set as the active span in the OTel context.
   * Child spans created inside `fn` will have this span as their parent and will
   * also inherit any blocking baggage set via `blocked_spans`.
   */
  withActive<T>(fn: () => T): T {
    if (!this.span) return fn();

    const ctx =
      this.activeContext ?? trace.setSpan(context.active(), this.span);
    return context.with(ctx, fn);
  }

  /**
   * Async version of withActive(). Keeps the context active across async work.
   */
  async withActiveAsync<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.span) return fn();

    const ctx =
      this.activeContext ?? trace.setSpan(context.active(), this.span);
    return context.with(ctx, fn);
  }

  setPrompt(prompt: string): this {
    return this.setAttribute(`${Config.LIBRARY_NAME}.prompt`, prompt);
  }

  setNegativePrompt(negativePrompt: string): this {
    return this.setAttribute(
      `${Config.LIBRARY_NAME}.negative_prompt`,
      negativePrompt,
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
      errorMessage,
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
