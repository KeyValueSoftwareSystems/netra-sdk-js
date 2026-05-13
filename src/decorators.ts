/**
 * Decorators for easy instrumentation
 */

import { trace, Span } from "@opentelemetry/api";
import { Config } from "./config";
import { SessionManager } from "./session-manager";
import { SpanType, DecoratorOptions } from "./types";

type AnyFunction = (...args: any[]) => any;
type AsyncFunction = (...args: any[]) => Promise<any>;
type AnyClass = new (...args: any[]) => any;
type ClassDecoratorFn = (target: AnyClass) => void;
type MethodDecoratorFn = (
  target: any,
  key: string | symbol,
  descriptor: PropertyDescriptor,
) => void;
type UnifiedDecorator = ClassDecoratorFn & MethodDecoratorFn;

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
  entityType: string,
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
      span.setAttribute("input", JSON.stringify(inputData));
    }
  } catch (e) {
    span.setAttribute("input_error", String(e));
  }
}

function addOutputAttributes(span: Span, result: any): void {
  try {
    span.setAttribute("output", serializeValue(result));
  } catch (e) {
    span.setAttribute("output_error", String(e));
  }
}

function isClassConstructor(fn: any): fn is AnyClass {
  return typeof fn === "function" && /^\s*class[\s{]/.test(fn.toString());
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

const SKIP_STATIC_PROPS = new Set([
  "length",
  "name",
  "prototype",
  "arguments",
  "caller",
]);

function wrapClassMethods(
  cls: AnyClass,
  entityType: string,
  name?: string,
  asType: SpanType = SpanType.SPAN,
): void {
  const className = name ?? cls.name;

  for (const methodName of Object.getOwnPropertyNames(cls.prototype)) {
    if (methodName === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(cls.prototype, methodName);
    if (!desc || typeof desc.value !== "function") continue;
    cls.prototype[methodName] = createFunctionWrapper(
      desc.value,
      entityType,
      `${className}.${methodName}`,
      asType,
    );
  }

  for (const methodName of Object.getOwnPropertyNames(cls)) {
    if (SKIP_STATIC_PROPS.has(methodName)) continue;
    const desc = Object.getOwnPropertyDescriptor(cls, methodName);
    if (!desc || typeof desc.value !== "function") continue;
    (cls as any)[methodName] = createFunctionWrapper(
      desc.value,
      entityType,
      `${className}.${methodName}`,
      asType,
    );
  }
}

function decoratorFactory(
  entityType: string,
  spanType: SpanType,
  targetOrOptions?: AnyFunction | AnyClass | DecoratorOptions,
  options?: DecoratorOptions,
): AnyFunction | AnyClass | UnifiedDecorator {
  if (isClassConstructor(targetOrOptions)) {
    wrapClassMethods(targetOrOptions, entityType, options?.name, spanType);
    return targetOrOptions;
  }

  if (typeof targetOrOptions === "function") {
    return createFunctionWrapper(
      targetOrOptions,
      entityType,
      options?.name,
      spanType,
    );
  }

  const opts = targetOrOptions as DecoratorOptions | undefined;
  return function (
    target: AnyFunction | AnyClass,
    _key?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void {
    if (isClassConstructor(target)) {
      wrapClassMethods(target, entityType, opts?.name, spanType);
      return;
    }
    if (descriptor) {
      // Mutate descriptor in place — returning void is valid for method decorators
      descriptor.value = createFunctionWrapper(
        descriptor.value,
        entityType,
        opts?.name,
        spanType,
      );
    }
  } as UnifiedDecorator;
}

export function workflow(target: AnyClass): void;
export function workflow<T extends AnyFunction>(target: T): T;
export function workflow(options?: DecoratorOptions): UnifiedDecorator;
export function workflow<T extends AnyFunction>(
  targetOrOptions?: T | AnyClass | DecoratorOptions,
  options?: DecoratorOptions,
): T | void | UnifiedDecorator {
  return decoratorFactory(
    "workflow",
    SpanType.SPAN,
    targetOrOptions,
    options,
  ) as T | void | UnifiedDecorator;
}

export function agent(target: AnyClass): void;
export function agent<T extends AnyFunction>(target: T): T;
export function agent(options?: DecoratorOptions): UnifiedDecorator;
export function agent<T extends AnyFunction>(
  targetOrOptions?: T | AnyClass | DecoratorOptions,
  options?: DecoratorOptions,
): T | void | UnifiedDecorator {
  return decoratorFactory("agent", SpanType.AGENT, targetOrOptions, options) as
    | T
    | void
    | UnifiedDecorator;
}

export function task(target: AnyClass): void;
export function task<T extends AnyFunction>(target: T): T;
export function task(options?: DecoratorOptions): UnifiedDecorator;
export function task<T extends AnyFunction>(
  targetOrOptions?: T | AnyClass | DecoratorOptions,
  options?: DecoratorOptions,
): T | void | UnifiedDecorator {
  return decoratorFactory("task", SpanType.TOOL, targetOrOptions, options) as
    | T
    | void
    | UnifiedDecorator;
}

export function span(target: AnyClass): void;
export function span<T extends AnyFunction>(target: T): T;
export function span(options?: DecoratorOptions): UnifiedDecorator;
export function span<T extends AnyFunction>(
  targetOrOptions?: T | AnyClass | DecoratorOptions,
  options?: DecoratorOptions,
): T | void | UnifiedDecorator {
  const spanType =
    (typeof targetOrOptions !== "function"
      ? (targetOrOptions as DecoratorOptions)?.asType
      : options?.asType) ?? SpanType.SPAN;
  return decoratorFactory("span", spanType, targetOrOptions, options) as
    | T
    | void
    | UnifiedDecorator;
}
