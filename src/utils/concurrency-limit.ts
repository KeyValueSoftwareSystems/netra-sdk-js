/**
 * Minimal promise concurrency limiter, API-compatible with the subset of
 * `p-limit` the SDK used (`limit(fn)` and `limit.clearQueue()`).
 *
 * `p-limit` 4+ is ESM-only, so the CommonJS build's top-level
 * `require("p-limit")` threw ERR_REQUIRE_ESM on Node 18, Node 20 < 20.19 and
 * Node 22 < 22.12, which the package claims to support (JS-PERF-004).
 */
export interface LimitFunction {
  <T>(fn: () => T | PromiseLike<T>): Promise<T>;
  /** Number of tasks currently running. */
  readonly activeCount: number;
  /** Number of tasks waiting to run. */
  readonly pendingCount: number;
  /** Drop every task that has not started. Their promises never settle. */
  clearQueue(): void;
}

export function createLimit(concurrency: number): LimitFunction {
  if (!(Number.isInteger(concurrency) || concurrency === Infinity) || concurrency < 1) {
    throw new TypeError("Expected `concurrency` to be an integer >= 1");
  }

  const queue: Array<() => void> = [];
  let active = 0;

  const next = (): void => {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (run) run();
  };

  const limit = (<T>(fn: () => T | PromiseLike<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        let result: Promise<T>;
        try {
          result = Promise.resolve(fn());
        } catch (e) {
          result = Promise.reject(e);
        }
        result.then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    })) as LimitFunction;

  Object.defineProperties(limit, {
    activeCount: { get: () => active },
    pendingCount: { get: () => queue.length },
    clearQueue: {
      value: () => {
        queue.length = 0;
      },
    },
  });

  return limit;
}
