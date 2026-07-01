/**
 * Decorators for easy instrumentation
 */

import { context, trace, Span, SpanStatusCode } from "@opentelemetry/api";
import { Config } from "./config";
import { Logger } from "./logger";
import { SessionManager } from "./session-manager";
import { SpanType, DecoratorOptions } from "./types";
import { wrapResponse } from "./utils/response-handler";
import { safeStringify, serializeValue } from "./utils/serialization";

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

/**
 * Returns true if the span already has a non-empty `output` attribute.
 * Checks both the public `attributes` property and the internal `_attributes`
 * store to handle SDK implementations that buffer attributes before export.
 */
function spanHasOutput(span: Span): boolean {
  try {
    for (const field of ["attributes", "_attributes"]) {
      const attrs = (span as any)[field];
      if (attrs && typeof attrs === "object" && attrs["output"]) return true;
    }
  } catch (e) {
    Logger.warn("spanHasOutput: error inspecting span attributes:", e);
  }
  return false;
}

function addInputAttributes(span: Span, args: any[], entityType: string): void {
  span.setAttribute(`${Config.LIBRARY_NAME}.entity.type`, entityType);
  if (args.length > 0) {
    span.setAttribute("input", safeStringify(args, Config.ATTRIBUTE_MAX_LEN));
  }
}

function addOutputAttributes(span: Span, result: any): void {
  // Skip if the user already set output explicitly inside the decorated function
  if (spanHasOutput(span)) return;
  try {
    span.setAttribute("output", serializeValue(result, Config.ATTRIBUTE_MAX_LEN));
  } catch (e) {
    span.setAttribute("output_error", String(e));
  }
}

function isClassConstructor(value: unknown): value is AnyClass {
  if (typeof value !== "function") {
    return false;
  }

  const prototype = value.prototype;
  return (
    prototype != null &&
    typeof prototype === "object" &&
    prototype.constructor === value
  );
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

  const initSpan = (span: Span): void => {
    span.setAttribute("netra.span.type", asType);
    SessionManager.registerSpan(spanName, span);
  };

  const handleError = (span: Span, e: any) => {
    span.setAttribute(`${Config.LIBRARY_NAME}.entity.error`, String(e));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: e instanceof Error ? e.message : String(e),
    });
    span.recordException(e);
    throw e;
  };

  const cleanup = (span: Span) => {
    span.end();
    SessionManager.unregisterSpan(spanName, span);
    SessionManager.popEntity(entityType);
  };

  const wrapperFn = isAsync
    ? async function (this: any, ...args: any[]) {
        SessionManager.pushEntity(entityType, spanName);
        const tracer = trace.getTracer(moduleName);
        return tracer.startActiveSpan(spanName, async (span) => {
          try {
            initSpan(span);
            addInputAttributes(span, args, entityType);
            const result = await (func as AsyncFunction).call(this, ...args);
            const spanCtx = trace.setSpan(context.active(), span);
            return wrapResponse(result, {
              withContext: (fn) => context.with(spanCtx, fn),
              onError: (e) => {
                span.setAttribute(
                  `${Config.LIBRARY_NAME}.entity.error`,
                  String(e),
                );
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: e instanceof Error ? e.message : String(e),
                });
                span.recordException(e as Error);
              },
              onSuccess: (value) => addOutputAttributes(span, value),
              finalize: () => cleanup(span),
            });
          } catch (e: any) {
            cleanup(span);
            handleError(span, e);
          }
        });
      }
    : function (this: any, ...args: any[]) {
        SessionManager.pushEntity(entityType, spanName);
        const tracer = trace.getTracer(moduleName);
        return tracer.startActiveSpan(spanName, (span) => {
          try {
            initSpan(span);
            addInputAttributes(span, args, entityType);
            const result = (func as AnyFunction).call(this, ...args);
            const spanCtx = trace.setSpan(context.active(), span);
            return wrapResponse(result, {
              withContext: (fn) => context.with(spanCtx, fn),
              onError: (e) => {
                span.setAttribute(
                  `${Config.LIBRARY_NAME}.entity.error`,
                  String(e),
                );
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: e instanceof Error ? e.message : String(e),
                });
                span.recordException(e as Error);
              },
              onSuccess: (value) => addOutputAttributes(span, value),
              finalize: () => cleanup(span),
            });
          } catch (e: any) {
            cleanup(span);
            handleError(span, e);
          }
        });
      };
  return wrapperFn as T;
}

const SKIP_STATIC_PROPS = new Set([
  "length",
  "name",
  "prototype",
  "arguments",
  "caller",
]);

function createClassWrapper(
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
    createClassWrapper(targetOrOptions, entityType, options?.name, spanType);
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
    if (descriptor) {
      // Mutate descriptor in place — returning void is valid for method decorators
      descriptor.value = createFunctionWrapper(
        descriptor.value,
        entityType,
        opts?.name,
        spanType,
      );
      return;
    } else if (isClassConstructor(target)) {
      createClassWrapper(target, entityType, opts?.name, spanType);
      return;
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
