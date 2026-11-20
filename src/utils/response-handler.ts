import { NetraLogger } from "../netraLogger";

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
 * A real Promise (including subclasses such as the provider SDKs' APIPromise,
 * and promises from another realm), as opposed to any object with a `then`
 * method. Query builders (Knex, Prisma, Mongoose, ...) are lazy thenables:
 * calling `then` runs the query (JS-SEC-010).
 */
export function isNativePromise<T = unknown>(value: unknown): value is Promise<T> {
  if (value == null || typeof (value as any).then !== "function") return false;
  return value instanceof Promise || Object.prototype.toString.call(value) === "[object Promise]";
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

export interface WrapOptions {
  /** Return the SDK's own object, routing only then/catch/finally through Netra. */
  preserveOriginal?: object;
  /** Hand an `APIPromise` back to the app as an `APIPromise`; see `wrapPromise`. */
  deriveAPIPromise?: boolean;
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
 * Ends the span of a stream the app dropped without reading to the end or
 * cancelling: once the stream object is garbage-collected, nothing can read
 * it any more, so its span is finalized. Without this the span was never
 * ended or exported and stayed in memory (JS-MEM-003).
 */
interface FinalizationRegistryLike<T> {
  register(target: object, held: T, unregisterToken?: object): void;
  unregister(unregisterToken: object): void;
}
type FinalizationRegistryCtor = new <T>(cleanup: (held: T) => void) => FinalizationRegistryLike<T>;
// Reached through globalThis: the project's TS lib predates ES2021 weakrefs.
const FinalizationRegistryImpl = (globalThis as { FinalizationRegistry?: FinalizationRegistryCtor })
  .FinalizationRegistry;
const abandonedStreams: FinalizationRegistryLike<() => void> | undefined =
  FinalizationRegistryImpl
    ? new FinalizationRegistryImpl<() => void>((finalize) => {
        try {
          finalize();
        } catch (e) {
          NetraLogger.debug("netra: finalizing an abandoned stream failed", e);
        }
      })
    : undefined;

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
  // One stream, one finalize, however it is consumed (iteration, a reader,
  // cancel(), or garbage collection).
  const state = { settled: false };
  const unregisterToken = {};
  const finalizeOnce = (status: "ok" | "error") => {
    if (state.settled) return;
    state.settled = true;
    abandonedStreams?.unregister(unregisterToken);
    try {
      callbacks.finalize(status);
    } catch (e) {
      NetraLogger.error("netra: finalize callback error", e);
    }
  };
  const safeOnChunk = (chunk: T) => {
    try {
      callbacks.onChunk?.(chunk);
    } catch (e) {
      NetraLogger.error("netra: onChunk callback error", e);
    }
  };
  const safeOnError = (e: unknown) => {
    try {
      callbacks.onError(e);
    } catch {
      NetraLogger.error("netra: onError callback error", e);
    }
  };

  function createWrappedIterator(): AsyncIterator<T> {
    const iterator = source[Symbol.asyncIterator]();
    let done = false;

    const safeFinalize = (status: "ok" | "error") => {
      if (done) return;
      done = true;
      finalizeOnce(status);
    };

    return {
      async next(value?: any) {
        try {
          const result = await callbacks.withContext(() => iterator.next(value));
          if (!result.done) {
            try {
              callbacks.onChunk?.(result.value);
            } catch (e) {
              NetraLogger.error("netra: onChunk callback error", e);
            }
          } else {
            safeFinalize("ok");
          }
          return result;
        } catch (e: any) {
          try {
            callbacks.onError(e);
          } catch {
            NetraLogger.error("netra: onError callback error", e);
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
            NetraLogger.error("netra: onError callback error", e);
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
            NetraLogger.error("netra: onError callback error", err);
          }
          safeFinalize("error");
          throw err;
        }
      },
    };
  }

  let directIterator: AsyncIterator<T> | null = null;

  /**
   * ReadableStream-style streams (LangGraph's IterableReadableStream) can be
   * read with getReader() or cancelled without ever iterating; observe those
   * paths too so the span still ends (JS-MEM-003).
   */
  const wrapReader = (reader: any): any => {
    if (!reader || typeof reader.read !== "function") return reader;
    return new Proxy(reader, {
      get(r, prop) {
        const value = r[prop];
        if (prop === "read" && typeof value === "function") {
          return async (...args: any[]) => {
            try {
              const result = await callbacks.withContext(() => value.apply(r, args));
              if (result?.done) finalizeOnce("ok");
              else safeOnChunk(result?.value);
              return result;
            } catch (e) {
              safeOnError(e);
              finalizeOnce("error");
              throw e;
            }
          };
        }
        if (prop === "cancel" && typeof value === "function") {
          return async (...args: any[]) => {
            try {
              return await value.apply(r, args);
            } finally {
              finalizeOnce("ok");
            }
          };
        }
        return typeof value === "function" ? value.bind(r) : value;
      },
    });
  };

  const proxy = new Proxy(source, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return () => createWrappedIterator();
      }
      if (prop === "getReader" && typeof (target as any).getReader === "function") {
        return (...args: any[]) => wrapReader((target as any).getReader(...args));
      }
      if (prop === "cancel" && typeof (target as any).cancel === "function") {
        return async (...args: any[]) => {
          try {
            return await (target as any).cancel(...args);
          } finally {
            finalizeOnce("ok");
          }
        };
      }
      if (typeof prop === "string" && ITERATOR_METHODS.has(prop)) {
        if (!directIterator) directIterator = createWrappedIterator();
        return (directIterator as any)[prop].bind(directIterator);
      }
      const value = (target as any)[prop];
      // SDK streams build their ReadableStream from `this[Symbol.asyncIterator]()`;
      // calling it on the proxy keeps reads going through the wrapped iterator,
      // so `new Response(stream.toReadableStream())` still ends the span.
      if (prop === "toReadableStream" && typeof value === "function") {
        return value.bind(receiver);
      }
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
  abandonedStreams?.register(proxy, () => finalizeOnce("ok"), unregisterToken);
  return proxy;
}

/**
 * Wrap a promise with lifecycle callbacks.
 * If the resolved value is async-iterable, wraps it with `wrapAsyncIterable`.
 *
 * With `deriveAPIPromise`, an `APIPromise` is never replaced: the result is
 * derived from it with `_thenUnwrap`, so every SDK method keeps working and
 * the caller's body is parsed only when the caller consumes it. Provider
 * wrappers that return the SDK's promise to the app opt in to this.
 *
 * Otherwise the promise is awaited as soon as it is wrapped, so anything it
 * wraps (an instrumented LLM call, the Anthropic SDK's own span) ends before
 * this span does, and Netra still marks the trace root as an LLM call. With
 * `preserveOriginal`, a Proxy routes then/catch/finally to the instrumented
 * promise and other properties to the original object.
 */
export function wrapPromise<T>(
  promise: Promise<T>,
  callbacks: ResponseCallbacks,
  options?: WrapOptions,
): any {
  let finalized = false;
  function safeFinalize(status: "ok" | "error") {
    if (finalized) return;
    finalized = true;
    try {
      callbacks.finalize(status);
    } catch (e) {
      NetraLogger.error("netra: finalize callback error", e);
    }
  }
  function safeOnSuccess(value: unknown) {
    try {
      callbacks.onSuccess?.(value);
    } catch (e) {
      NetraLogger.error("netra: onSuccess callback error", e);
    }
  }
  function safeOnError(error: unknown) {
    try {
      callbacks.onError(error);
    } catch {
      NetraLogger.error("netra: onError callback error", error);
    }
  }

  if (options?.deriveAPIPromise && isAPIPromise(promise)) {
    // Failures are seen on the raw response promise, which never reads the body.
    promise.responsePromise.then(observeJSONBody, (error) => {
      safeOnError(error);
      safeFinalize("error");
    });
    return promise._thenUnwrap((value) => {
      if (isAsyncIterable(value)) {
        return wrapAsyncIterable(value, { ...callbacks, finalize: safeFinalize });
      }
      if (!finalized) {
        safeOnSuccess(value);
        safeFinalize("ok");
      }
      return value;
    });
  }

  // Read a copy of a JSON body so the span ends when the response arrives,
  // even if the caller reads the result late or never. The caller's own body
  // is left unread. This runs before any caller handler on responsePromise,
  // so the body is still unused when it is cloned.
  function observeJSONBody(props: any) {
    try {
      const response = props?.response;
      const contentType = String(response?.headers?.get?.("content-type") ?? "");
      if (typeof response?.clone !== "function" || !contentType.includes("json")) {
        return;
      }
      response
        .clone()
        .json()
        .then(
          (body: unknown) => {
            if (finalized) return;
            safeOnSuccess(body);
            safeFinalize("ok");
          },
          // A malformed or truncated body: the caller's own read of the same
          // bytes fails too, and _thenUnwrap never runs, so end the span here.
          (error: unknown) => {
            if (finalized) return;
            safeOnError(error);
            safeFinalize("error");
          },
        );
    } catch (e) {
      NetraLogger.debug("netra: could not read a copy of the response body", e);
    }
  }

  const instrumentedPromise = (async () => {
    try {
      const value = await promise;
      if (isAsyncIterable(value)) {
        return wrapAsyncIterable(value as any, { ...callbacks, finalize: safeFinalize });
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

  const original = options.preserveOriginal as any;
  return new Proxy(instrumentedPromise, {
    get(target, prop, receiver) {
      if (prop === "then" || prop === "catch" || prop === "finally") {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") return value.bind(target);
        return value;
      }
      // `.withResponse()` resolves to the SDK's own stream, which Netra never
      // sees being read, so the span never ended (JS-MEM-003). Hand back the
      // same result with a wrapped stream.
      if (prop === "withResponse" && typeof original.withResponse === "function") {
        return async (...args: any[]) => {
          const result = await original.withResponse(...args);
          if (result && isAsyncIterable(result.data)) {
            return { ...result, data: wrapAsyncIterable(result.data, { ...callbacks, finalize: safeFinalize }) };
          }
          return result;
        };
      }
      // `.asResponse()` on a stream: the app reads the raw bytes itself and
      // nothing more can be observed, so end the span once the call returns.
      if (prop === "asResponse" && typeof original.asResponse === "function") {
        return async (...args: any[]) => {
          const response = await original.asResponse(...args);
          instrumentedPromise.then(
            (value) => {
              if (isAsyncIterable(value)) safeFinalize("ok");
            },
            () => {},
          );
          return response;
        };
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
  options?: WrapOptions,
): T {
  if (isAsyncIterable(response)) {
    return wrapAsyncIterable(response as any, callbacks) as T;
  }

  if (isNativePromise(response)) {
    return wrapPromise(response as any, callbacks, options) as T;
  }

  if (isPromise(response)) {
    // A lazy thenable: awaiting it would run it early, outside the caller's
    // control (for example outside a database transaction). Hand it back
    // untouched; the span ends now, without an output (JS-SEC-010).
    try {
      callbacks.finalize("ok");
    } catch (e) {
      NetraLogger.error("netra: finalize callback error", e);
    }
    return response;
  }

  try {
    callbacks.onSuccess?.(response);
  } catch (e) {
    NetraLogger.error("netra: onSuccess callback error", e);
  }
  try {
    callbacks.finalize("ok");
  } catch (e) {
    NetraLogger.error("netra: finalize callback error", e);
  }
  return response;
}
