/**
 * Decorators for easy instrumentation
 *
 * These decorators automatically establish isolated context for concurrent requests.
 * When a decorated function is called, if no context exists, one is created.
 * Nested decorated calls reuse the existing context, ensuring proper isolation.
 */

import { context, Span, trace } from "@opentelemetry/api";
import { Config } from "./config";
import { ContextStore } from "./context-store";
import { SessionManager } from "./session-manager";
import { DecoratorOptions, SpanType } from "./types";

type AnyFunction = (...args: any[]) => any;
type AsyncFunction = (...args: any[]) => Promise<any>;

function serializeValue(value: any): string {
  try {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      value === undefined
    ) {
      return String(value);
    } else if (Array.isArray(value) || typeof value === "object") {
      return JSON.stringify(value).substring(0, 1000);
    } else {
      return String(value).substring(0, 1000);
    }
  } catch {
    return String(typeof value);
  }
}

function addSpanAttributes(
  span: Span,
  func: AnyFunction,
  args: any[],
  kwargs: Record<string, any>,
  entityType: string
): void {
  span.setAttribute(`${Config.LIBRARY_NAME}.entity.type`, entityType);

  try {
    const inputData: Record<string, string> = {};
    const paramNames = getParameterNames(func);

    for (let i = 0; i < args.length && i < paramNames.length; i++) {
      const paramName = paramNames[i];
      if (paramName !== "self" && paramName !== "cls") {
        inputData[paramName] = serializeValue(args[i]);
      }
    }

    for (const [key, value] of Object.entries(kwargs)) {
      inputData[key] = serializeValue(value);
    }

    if (Object.keys(inputData).length > 0) {
      span.setAttribute(
        `${Config.LIBRARY_NAME}.entity.input`,
        JSON.stringify(inputData)
      );
    }
  } catch (e) {
    span.setAttribute(
      `${Config.LIBRARY_NAME}.input_error`,
      String(e)
    );
  }
}

function addOutputAttributes(span: Span, result: any): void {
  try {
    const serializedOutput = serializeValue(result);
    span.setAttribute(
      `${Config.LIBRARY_NAME}.entity.output`,
      serializedOutput
    );
  } catch (e) {
    span.setAttribute(
      `${Config.LIBRARY_NAME}.entity.output_error`,
      String(e)
    );
  }
}

function getParameterNames(func: AnyFunction): string[] {
  const funcStr = func.toString();
  const match = funcStr.match(/\(([^)]*)\)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p);
}

/**
 * Core function wrapper that handles both sync and async functions.
 * Automatically establishes context if none exists (for concurrency safety).
 */
/**
 * Core function wrapper that handles both sync and async functions.
 * Automatically establishes context if none exists (for concurrency safety).
 */
function createFunctionWrapper<T extends AnyFunction>(
  func: T,
  entityType: string,
  name?: string,
  asType: SpanType = SpanType.SPAN
): T {
  const moduleName = func.name || "unknown";
  const spanName = name || func.name || "anonymous";
  const isAsync = func.constructor.name === "AsyncFunction";

  if (isAsync) {
    return (async function (this: any, ...args: any[]) {
      // Check if we already have a context (nested call)
      const hasExistingContext = ContextStore.hasContext();

      // The actual execution logic
      const executeWithTracking = async () => {
        SessionManager.pushEntity(entityType, spanName);
        const tracer = trace.getTracer(moduleName);

        // Context Bridge: If active context is lost (Root) but LangGraph stack exists, use stack
        const sessionCtx = ContextStore.getOrCreateContext();
        const lgStack = sessionCtx.langgraph?.otelContextStack;
        const activeSpan = trace.getSpan(context.active());
        const rootSpan = SessionManager.getRootSpan();
        
        let parentCtx = context.active();
        if ((!activeSpan || (rootSpan && activeSpan === rootSpan)) && lgStack && lgStack.length > 0) {
             parentCtx = lgStack[lgStack.length - 1];
        }

        return tracer.startActiveSpan(spanName, { attributes: { "netra.span.type": asType } }, parentCtx, async span => {
          SessionManager.registerSpan(spanName, span);
          SessionManager.setCurrentSpan(span);

          try {
            const kwargs: Record<string, any> = {};
            addSpanAttributes(span, func, args, kwargs, entityType);

            const result = await (func as AsyncFunction).call(this, ...args);

            addOutputAttributes(span, result);
            return result;
          } catch (e: any) {
            span.setAttribute(
              `${Config.LIBRARY_NAME}.entity.error`,
              String(e)
            );
            span.recordException(e);
            throw e;
          } finally {
            span.end();
            SessionManager.unregisterSpan(spanName, span);
            SessionManager.popEntity(entityType);
          }
        });
      };

      // If we already have a context, just execute
      // Otherwise, create a new isolated context (this is the entry point)
      if (hasExistingContext) {
        return executeWithTracking();
      } else {
        return ContextStore.runWithNewContext(() => executeWithTracking());
      }
    }) as T;
  } else {
    return (function (this: any, ...args: any[]) {
      // Check if we already have a context (nested call)
      const hasExistingContext = ContextStore.hasContext();

      // The actual execution logic
      const executeWithTracking = () => {
        SessionManager.pushEntity(entityType, spanName);
        const tracer = trace.getTracer(moduleName);

        // Context Bridge: If active context is lost (Root) but LangGraph stack exists, use stack
        const sessionCtx = ContextStore.getOrCreateContext();
        const lgStack = sessionCtx.langgraph?.otelContextStack;
        const activeSpan = trace.getSpan(context.active());
        const rootSpan = SessionManager.getRootSpan();

        let parentCtx = context.active();
        if ((!activeSpan || (rootSpan && activeSpan === rootSpan)) && lgStack && lgStack.length > 0) {
             parentCtx = lgStack[lgStack.length - 1];
        }

        return tracer.startActiveSpan(spanName, { attributes: { "netra.span.type": asType } }, parentCtx, span => {
          SessionManager.registerSpan(spanName, span);
          SessionManager.setCurrentSpan(span);

          try {
            const kwargs: Record<string, any> = {};
            addSpanAttributes(span, func, args, kwargs, entityType);

            const result = (func as AnyFunction).call(this, ...args);
            addOutputAttributes(span, result);

            return result;
          } catch (e: any) {
            span.setAttribute(
              `${Config.LIBRARY_NAME}.entity.error`,
              String(e)
            );
            span.recordException(e);
            throw e;
          } finally {
            span.end();
            SessionManager.unregisterSpan(spanName, span);
            SessionManager.popEntity(entityType);
          }
        });
      };

      // If we already have a context, just execute
      // Otherwise, create a new isolated context (this is the entry point)
      if (hasExistingContext) {
        return executeWithTracking();
      } else {
        return ContextStore.runWithNewContext(() => executeWithTracking());
      }
    }) as T;
  }
}

export function workflow<T extends AnyFunction>(
  target: T,
  options?: DecoratorOptions
): T;
export function workflow<T extends AnyFunction>(
  options?: DecoratorOptions
): (target: T) => T;
export function workflow<T extends AnyFunction>(
  targetOrOptions?: T | DecoratorOptions,
  options?: DecoratorOptions
): T | ((target: T) => T) {
  if (typeof targetOrOptions === "function") {
    return createFunctionWrapper(
      targetOrOptions,
      "workflow",
      options?.name,
      SpanType.SPAN
    );
  } else {
    return (target: T) =>
      createFunctionWrapper(
        target,
        "workflow",
        targetOrOptions?.name,
        SpanType.SPAN
      );
  }
}

export function agent<T extends AnyFunction>(
  target: T,
  options?: DecoratorOptions
): T;
export function agent<T extends AnyFunction>(
  options?: DecoratorOptions
): (target: T) => T;
export function agent<T extends AnyFunction>(
  targetOrOptions?: T | DecoratorOptions,
  options?: DecoratorOptions
): T | ((target: T) => T) {
  if (typeof targetOrOptions === "function") {
    return createFunctionWrapper(
      targetOrOptions,
      "agent",
      options?.name,
      SpanType.AGENT
    );
  } else {
    return (target: T) =>
      createFunctionWrapper(
        target,
        "agent",
        targetOrOptions?.name,
        SpanType.AGENT
      );
  }
}

export function task<T extends AnyFunction>(
  target: T,
  options?: DecoratorOptions
): T;
export function task<T extends AnyFunction>(
  options?: DecoratorOptions
): (target: T) => T;
export function task<T extends AnyFunction>(
  targetOrOptions?: T | DecoratorOptions,
  options?: DecoratorOptions
): T | ((target: T) => T) {
  if (typeof targetOrOptions === "function") {
    return createFunctionWrapper(
      targetOrOptions,
      "task",
      options?.name,
      SpanType.TOOL
    );
  } else {
    return (target: T) =>
      createFunctionWrapper(
        target,
        "task",
        targetOrOptions?.name,
        SpanType.TOOL
      );
  }
}

export function span<T extends AnyFunction>(
  target: T,
  options?: DecoratorOptions
): T;
export function span<T extends AnyFunction>(
  options?: DecoratorOptions
): (target: T) => T;
export function span<T extends AnyFunction>(
  targetOrOptions?: T | DecoratorOptions,
  options?: DecoratorOptions
): T | ((target: T) => T) {
  const asType = options?.asType || (typeof targetOrOptions !== "function" ? targetOrOptions?.asType : undefined) || SpanType.SPAN;
  if (typeof targetOrOptions === "function") {
    return createFunctionWrapper(
      targetOrOptions,
      "span",
      options?.name,
      asType
    );
  } else {
    return (target: T) =>
      createFunctionWrapper(
        target,
        "span",
        targetOrOptions?.name,
        asType
      );
  }
}
