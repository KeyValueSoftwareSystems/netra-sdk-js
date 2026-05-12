/**
 * Decorators for easy instrumentation
 */

import { trace, Span } from "@opentelemetry/api";
import { Config } from "./config";
import { SessionManager } from "./session-manager";
import { SpanType, DecoratorOptions } from "./types";

type AnyFunction = (...args: any[]) => any;
type AsyncFunction = (...args: any[]) => Promise<any>;
type DecoratorFunction = (
  _target: any,
  _key: string,
  descriptor: PropertyDescriptor,
) => PropertyDescriptor;

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

function getParameterNames(func: AnyFunction): string[] {
  const funcStr = func.toString();
  const match = funcStr.match(/\(([^)]*)\)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p);
}

function addSpanAttributes(
  span: Span,
  func: AnyFunction,
  args: any[],
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

    if (Object.keys(inputData).length > 0) {
      span.setAttribute(
        `${Config.LIBRARY_NAME}.entity.input`,
        JSON.stringify(inputData)
      );
    }
  } catch (e) {
    span.setAttribute(`${Config.LIBRARY_NAME}.input_error`, String(e));
  }
}

function addOutputAttributes(span: Span, result: any): void {
  try {
    span.setAttribute(
      `${Config.LIBRARY_NAME}.entity.output`,
      serializeValue(result),
    );
  } catch (e) {
    span.setAttribute(`${Config.LIBRARY_NAME}.entity.output_error`, String(e));
  }
}

function createFunctionWrapper<T extends AnyFunction>(
  func: T,
  entityType: string,
  name?: string,
  asType: SpanType = SpanType.SPAN,
): T {
  const moduleName = func.name || "unknown";
  const spanName = name || func.name || "anonymous";
  const isAsync = func.constructor.name === "AsyncFunction";

  const wrapSpan = (span: Span, fn: () => any) => {
    span.setAttribute("netra.span.type", asType);
    SessionManager.registerSpan(spanName, span);
    SessionManager.setCurrentSpan(span);
    return fn();
  };

  const handleError = (span: Span, e: any) => {
    span.setAttribute(`${Config.LIBRARY_NAME}.entity.error`, String(e));
    span.recordException(e);
    throw e;
  };

  const cleanup = (span: Span) => {
    span.end();
    SessionManager.unregisterSpan(spanName, span);
    SessionManager.popEntity(entityType);
  };

  if (isAsync) {
    return async function (this: any, ...args: any[]) {
      SessionManager.pushEntity(entityType, spanName);
      const tracer = trace.getTracer(moduleName);
      return tracer.startActiveSpan(spanName, async (span) => {
        try {
          return await wrapSpan(span, async () => {
            addSpanAttributes(span, func, args, entityType);
            const result = await (func as AsyncFunction).call(this, ...args);
            addOutputAttributes(span, result);
            return result;
          });
        } catch (e: any) {
          handleError(span, e);
        } finally {
          cleanup(span);
        }
      });
    } as T;
  } else {
    return function (this: any, ...args: any[]) {
      SessionManager.pushEntity(entityType, spanName);
      const tracer = trace.getTracer(moduleName);
      return tracer.startActiveSpan(spanName, (span) => {
        try {
          return wrapSpan(span, () => {
            addSpanAttributes(span, func, args, entityType);
            const result = (func as AnyFunction).call(this, ...args);
            addOutputAttributes(span, result);
            return result;
          });
        } catch (e: any) {
          handleError(span, e);
        } finally {
          cleanup(span);
        }
      });
    } as T;
  }
}

function decoratorFactory(
  entityType: string,
  spanType: SpanType,
  targetOrOptions?: AnyFunction | DecoratorOptions,
  options?: DecoratorOptions,
): AnyFunction | DecoratorFunction {
  if (typeof targetOrOptions === "function") {
    return createFunctionWrapper(
      targetOrOptions,
      entityType,
      options?.name,
      spanType,
    );
  }

  return (_target: any, _key: string, descriptor: PropertyDescriptor) => {
    descriptor.value = createFunctionWrapper(
      descriptor.value,
      entityType,
      targetOrOptions?.name,
      spanType,
    );
    return descriptor;
  };
}

export function workflow<T extends AnyFunction>(target: T, options?: DecoratorOptions): T;
export function workflow(options?: DecoratorOptions): DecoratorFunction;
export function workflow<T extends AnyFunction>(
  targetOrOptions?: T | DecoratorOptions,
  options?: DecoratorOptions,
): T | DecoratorFunction {
  return decoratorFactory("workflow", SpanType.SPAN, targetOrOptions, options) as T | DecoratorFunction;
}

export function agent<T extends AnyFunction>(target: T, options?: DecoratorOptions): T;
export function agent(options?: DecoratorOptions): DecoratorFunction;
export function agent<T extends AnyFunction>(
  targetOrOptions?: T | DecoratorOptions,
  options?: DecoratorOptions,
): T | DecoratorFunction {
  return decoratorFactory("agent", SpanType.AGENT, targetOrOptions, options) as T | DecoratorFunction;
}

export function task<T extends AnyFunction>(target: T, options?: DecoratorOptions): T;
export function task(options?: DecoratorOptions): DecoratorFunction;
export function task<T extends AnyFunction>(
  targetOrOptions?: T | DecoratorOptions,
  options?: DecoratorOptions,
): T | DecoratorFunction {
  return decoratorFactory("task", SpanType.TOOL, targetOrOptions, options) as T | DecoratorFunction;
}

export function span<T extends AnyFunction>(target: T, options?: DecoratorOptions): T;
export function span(options?: DecoratorOptions): DecoratorFunction;
export function span<T extends AnyFunction>(
  targetOrOptions?: T | DecoratorOptions,
  options?: DecoratorOptions,
): T | DecoratorFunction {
  const spanType =
    (typeof targetOrOptions !== "function"
      ? targetOrOptions?.asType
      : options?.asType) ?? SpanType.SPAN;
  return decoratorFactory("span", spanType, targetOrOptions, options) as T | DecoratorFunction;
}
