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

/**
 * The `APIPromise` returned by Stainless-generated SDKs (OpenAI, Anthropic,
 * Groq): a Promise subclass whose extra methods (`.withResponse()`,
 * `.asResponse()`, `._thenUnwrap()`) the SDKs' own helpers such as
 * `.parse()` and `.stream()` depend on.
 */
export interface APIPromiseLike<T = unknown> extends Promise<T> {
  responsePromise: Promise<unknown>;
  _thenUnwrap<U>(transform: (value: T) => U): APIPromiseLike<U>;
}

export function isAPIPromise(value: unknown): value is APIPromiseLike {
  return (
    isPromise(value) &&
    typeof (value as any)._thenUnwrap === "function" &&
    isPromise((value as any).responsePromise)
  );
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
  function createWrappedIterator(): AsyncIterator<T> {
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

    return {
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
  }

  let directIterator: AsyncIterator<T> | null = null;

  return new Proxy(source, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return () => createWrappedIterator();
      }
      if (typeof prop === "string" && ITERATOR_METHODS.has(prop)) {
        if (!directIterator) directIterator = createWrappedIterator();
        return (directIterator as any)[prop].bind(directIterator);
      }
      const value = (target as any)[prop];
      // SDK streams build their ReadableStream from `this[Symbol.asyncIterator]()`;
      // calling it on the proxy keeps reads going through the wrapped iterator.
      if (prop === "toReadableStream" && typeof value === "function") {
        return value.bind(receiver);
      }
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
}

/**
 * Wrap a promise with lifecycle callbacks.
 * If the resolved value is async-iterable, wraps it with `wrapAsyncIterable`.
 *
 * An `APIPromise` is never replaced: the result is derived from it with
 * `_thenUnwrap`, so every SDK method keeps working and the body is parsed
 * only when the caller consumes it.
 *
 * Otherwise, when `preserveOriginal` is set, returns a Proxy that routes
 * then/catch/finally to the instrumented promise and other properties
 * to the original object.
 */
export function wrapPromise<T>(
  promise: Promise<T>,
  callbacks: ResponseCallbacks,
  options?: { preserveOriginal?: object },
): any {
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
  function safeOnSuccess(value: unknown) {
    try {
      callbacks.onSuccess?.(value);
    } catch (e) {
      Logger.error("netra: onSuccess callback error", e);
    }
  }
  function safeOnError(error: unknown) {
    try {
      callbacks.onError(error);
    } catch {
      Logger.error("netra: onError callback error", error);
    }
  }

  if (isAPIPromise(promise)) {
    // Failures are seen on the raw response promise, which never reads the body.
    promise.responsePromise.then(undefined, (error) => {
      safeOnError(error);
      safeFinalize("error");
    });
    return promise._thenUnwrap((value) => {
      if (isAsyncIterable(value)) {
        return wrapAsyncIterable(value, { ...callbacks, finalize: safeFinalize });
      }
      safeOnSuccess(value);
      safeFinalize("ok");
      return value;
    });
  }

  const instrumentedPromise = (async () => {
    try {
      const value = await promise;
      if (isAsyncIterable(value)) {
        return wrapAsyncIterable(value as any, callbacks);
      }
      safeOnSuccess(value);
      safeFinalize("ok");
      return value;
    } catch (error) {
      safeOnError(error);
      safeFinalize("error");
      throw error;
    }
  })();

  if (!options?.preserveOriginal) {
    return instrumentedPromise;
  }

  // The caller may consume the original through an SDK method and never
  // touch this promise; mark it handled so a rejection can't crash the process.
  // The caller still sees the error through its own then/catch.
  instrumentedPromise.catch(() => {});

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
