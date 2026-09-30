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
import { Logger } from "./logger";
import { LOCAL_BLOCKED_SPANS_BAGGAGE_KEY } from "./processors/localfiltering-span-processor";
import { EntityFrame, SessionManager } from "./session-manager";
import { ActionModel, SpanAttributes, SpanType, UsageModel } from "./types";

/**
 * Maps SpanType to the entity type used by SessionManager for entity stacks.
 * Only AGENT and TOOL span types have entity semantics.
 */
const SPAN_TYPE_TO_ENTITY_TYPE: Partial<Record<SpanType, string>> = {
  [SpanType.AGENT]: "agent",
  [SpanType.TOOL]: "task",
};

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
  private blockedSpanPatterns?: string[];
  private _entityType?: string;
  private _entityFrame?: EntityFrame;
  /** Name the span was registered under at start(); end() unregisters
   *  under it because updateSpanName changes this.name, not the registry key. */
  private _registeredName?: string;

  constructor(
    name: string,
    attributes: SpanAttributes = {},
    moduleName: string = "netra_sdk",
    asType: SpanType = SpanType.SPAN,
    tracer?: any,
    blockedSpanPatterns?: string[],
  ) {
    this.name = name;
    this.attributes = { ...attributes };
    this.moduleName = moduleName;
    this.attributes["netra.span.type"] = asType;
    this.tracer = tracer;
    this.blockedSpanPatterns = blockedSpanPatterns;
    this._entityType = SPAN_TYPE_TO_ENTITY_TYPE[asType];
  }

  start(): this {
    this.startTime = Date.now();

    // Push entity before span starts so SessionSpanProcessor captures the name
    if (this._entityType) {
      this._entityFrame = SessionManager.pushEntity(this._entityType, this.name);
    }

    const tracer = this.tracer || trace.getTracer(this.moduleName);

    let ctx = context.active();

    if (this.blockedSpanPatterns && this.blockedSpanPatterns.length > 0) {
      const patterns = this.blockedSpanPatterns.filter(Boolean);
      if (patterns.length > 0) {
        const existingBaggage =
          propagation.getBaggage(ctx) ?? propagation.createBaggage();
        const existingRaw = existingBaggage.getEntry(
          LOCAL_BLOCKED_SPANS_BAGGAGE_KEY,
        )?.value;
        const existingPatterns = this.decodeBaggagePatterns(existingRaw);
        const merged = [...new Set([...existingPatterns, ...patterns])];
        const payload = JSON.stringify(merged);
        const updatedBaggage = existingBaggage.setEntry(
          LOCAL_BLOCKED_SPANS_BAGGAGE_KEY,
          { value: payload },
        );
        ctx = propagation.setBaggage(ctx, updatedBaggage);
      }
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

    // Store the context with this span (and any baggage) so withActive()
    // propagates both parent-span and blocking baggage to child spans.
    if (this.span) {
      this.activeContext = trace.setSpan(ctx, this.span);
      SessionManager.registerSpan(this.name, this.span);
      this._registeredName = this.name;
      if (this._entityType && this._entityFrame) {
        SessionManager.bindSpanToEntity(this.span, this._entityType, this._entityFrame);
      }
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

      SessionManager.unregisterSpan(this._registeredName ?? this.name, this.span);
      this.span.end();
    }

    // Pop entity from session stack so nested spans get correct parentage
    if (this._entityType) {
      SessionManager.popEntity(this._entityType, this._entityFrame);
      this._entityFrame = undefined;
    }

    // Release the stored context so it can be GC'd
    this.activeContext = undefined;

    return this;
  }

  setAttribute(key: string, value: string | string[] | boolean): this {
    this.attributes[key] = value;
    if (this.span) {
      this.span.setAttribute(key, value);
    }
    return this;
  }

  /**
   * Rename this span, keeping its entity name in sync.
   *
   * Use this when a span is opened under a placeholder (e.g. an id) and the
   * human-readable name only becomes known later. For AGENT / TOOL spans it
   * also updates `netra.agent.name` / `netra.task.name` on this span and on
   * child spans started *after* this call.
   *
   * Child spans that already started keep the old entity name (it was stamped
   * at their start). Called before the span is started, it changes the name
   * the span will start with.
   *
   * @param newName - The new span name. A non-string or empty value is ignored.
   * @returns The span wrapper (for chaining).
   */
  updateSpanName(newName: string): this {
    if (typeof newName !== "string" || !newName) {
      Logger.warn("updateSpanName: newName must be a non-empty string; ignoring");
      return this;
    }
    if (this.span) {
      SessionManager.updateSpanName(this.span, newName);
    }
    this.name = newName;
    return this;
  }

  /**
   * Run a function with this span set as the active span in the OTel context.
   * Child spans created inside `fn` will have this span as their parent and will
   * also inherit any blocking baggage set via `blockedSpans`. Works for both
   * sync and async functions — context.with() passes through the return value as-is.
   */
  withActive<T>(fn: () => T): T {
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

  private decodeBaggagePatterns(raw: string | undefined): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((v: unknown) => typeof v === "string" && v);
      }
    } catch {
      // ignore malformed baggage
    }
    return [];
  }
}
