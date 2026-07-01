import { Logger } from "../logger";

export interface ResponseCallbacks<TChunk = unknown> {
  withContext<T>(fn: () => T): T;
  onChunk?(chunk: TChunk): void;
  onError(error: unknown): void;
  onSuccess?(value: unknown): void;
  finalize(status: "ok" | "error"): void;
}

export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  return (
    value != null && typeof (value as any)[Symbol.asyncIterator] === "function"
  );
}

export function isPromise<T = unknown>(value: unknown): value is Promise<T> {
  return value != null && typeof (value as any).then === "function";
}

const ITERATOR_METHODS = new Set(["next", "return", "throw"]);

/**
 * Wrap an async iterable with lifecycle callbacks.
 * Returns a Proxy that preserves the original object's full interface
 * while intercepting iteration methods.
 *
 * When `onChunk` is provided, each yielded value is passed to it
 * (enabling LLM response accumulation). When omitted, chunks pass through
 * untouched (lifecycle-only mode).
 */
export function wrapAsyncIterable<T>(
  source: AsyncIterable<T>,
  callbacks: ResponseCallbacks<T>,
): any {
  const iterator = source[Symbol.asyncIterator]();
  let done = false;

  const safeFinalize = (status: "ok" | "error") => {
    if (done) return;
    done = true;
    try {
      callbacks.finalize(status);
    } catch (e) {
      Logger.error("netra: finalize callback error", e);
    }
  };

  const wrappedIterator: AsyncIterator<T> = {
    async next(value?: any) {
      try {
        const result = await callbacks.withContext(() => iterator.next(value));
        if (!result.done) {
          try {
            callbacks.onChunk?.(result.value);
          } catch (e) {
            Logger.error("netra: onChunk callback error", e);
          }
        } else {
          safeFinalize("ok");
        }
        return result;
      } catch (e: any) {
        try {
          callbacks.onError(e);
        } catch {
          Logger.error("netra: onError callback error", e);
        }
        safeFinalize("error");
        throw e;
      }
    },
    async return(value?: any) {
      try {
        const result = await callbacks.withContext(
          () => iterator.return?.(value) ?? { done: true as const, value },
        );
        safeFinalize("ok");
        return result;
      } catch (e: any) {
        try {
          callbacks.onError(e);
        } catch {
          Logger.error("netra: onError callback error", e);
        }
        safeFinalize("error");
        throw e;
      }
    },
    async throw(e?: any) {
      try {
        const result = await callbacks.withContext(() => {
          if (iterator.throw) return iterator.throw(e);
          throw e;
        });
        if (result.done) safeFinalize("ok");
        return result;
      } catch (err) {
        try {
          callbacks.onError(err);
        } catch {
          Logger.error("netra: onError callback error", err);
        }
        safeFinalize("error");
        throw err;
      }
    },
  };

  return new Proxy(source, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return () => wrappedIterator;
      }
      if (typeof prop === "string" && ITERATOR_METHODS.has(prop)) {
        return (wrappedIterator as any)[prop].bind(wrappedIterator);
      }
      const value = (target as any)[prop];
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
}

/**
 * Wrap a promise with lifecycle callbacks.
 * If the resolved value is async-iterable, wraps it with `wrapAsyncIterable`.
 * When `preserveOriginal` is set, returns a Proxy that routes
 * then/catch/finally to the instrumented promise and other properties
 * to the original object (preserving SDK methods like `.withResponse()`).
 */
export function wrapPromise<T>(
  promise: Promise<T>,
  callbacks: ResponseCallbacks,
  options?: { preserveOriginal?: object },
): any {
  const instrumentedPromise = (async () => {
    try {
      const value = await promise;
      if (isAsyncIterable(value)) {
        return wrapAsyncIterable(value as any, callbacks);
      }
      try {
        callbacks.onSuccess?.(value);
      } catch (e) {
        Logger.error("netra: onSuccess callback error", e);
      }
      safeFinalize("ok");
      return value;
    } catch (error) {
      try {
        callbacks.onError(error);
      } catch {
        Logger.error("netra: onError callback error", error);
      }
      safeFinalize("error");
      throw error;
    }
  })();

  let finalized = false;
  function safeFinalize(status: "ok" | "error") {
    if (finalized) return;
    finalized = true;
    try {
      callbacks.finalize(status);
    } catch (e) {
      Logger.error("netra: finalize callback error", e);
    }
  }

  if (!options?.preserveOriginal) {
    return instrumentedPromise;
  }

  const original = options.preserveOriginal;
  return new Proxy(instrumentedPromise, {
    get(target, prop, receiver) {
      if (prop === "then" || prop === "catch" || prop === "finally") {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") return value.bind(target);
        return value;
      }
      const originalValue = (original as any)[prop];
      if (originalValue !== undefined) {
        if (typeof originalValue === "function")
          return originalValue.bind(original);
        return originalValue;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
}

/**
 * Unified response dispatcher. Detects response type and delegates:
 * - AsyncIterable -> wrapAsyncIterable
 * - Promise -> wrapPromise (which handles Promise<AsyncIterable> internally)
 * - Sync value -> onSuccess + finalize immediately
 */
export function wrapResponse<T>(
  response: T,
  callbacks: ResponseCallbacks,
  options?: { preserveOriginal?: object },
): T {
  if (isAsyncIterable(response)) {
    return wrapAsyncIterable(response as any, callbacks) as T;
  }

  if (isPromise(response)) {
    return wrapPromise(response as any, callbacks, options) as T;
  }

  try {
    callbacks.onSuccess?.(response);
  } catch (e) {
    Logger.error("netra: onSuccess callback error", e);
  }
  try {
    callbacks.finalize("ok");
  } catch (e) {
    Logger.error("netra: finalize callback error", e);
  }
  return response;
}
