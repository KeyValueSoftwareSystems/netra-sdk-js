import v8 from "v8";
import vm from "vm";
import { describe, expect, it, vi } from "vitest";

import { captureUnhandledRejections, settle } from "../__fixtures__/llm-test-utils";
import { wrapAsyncIterable, wrapPromise } from "./response-handler";

function callbacks() {
  return {
    withContext: <T>(fn: () => T) => fn(),
    onError: vi.fn(),
    onSuccess: vi.fn(),
    finalize: vi.fn(),
  };
}

describe("wrapPromise with preserveOriginal", () => {
  it("a rejection is not unhandled when the caller only uses an SDK method", async () => {
    const rejections = captureUnhandledRejections();
    const failure = new Error("rate limited");
    const sdkPromise = Object.assign(Promise.reject(failure), {
      $inspect: () => sdkPromise,
    });
    sdkPromise.catch(() => {});
    const cb = callbacks();

    const wrapped = wrapPromise(sdkPromise, cb, { preserveOriginal: sdkPromise });
    await expect(wrapped.$inspect()).rejects.toBe(failure);
    await settle();
    rejections.stop();

    expect(rejections.seen).toEqual([]);
    expect(cb.onError).toHaveBeenCalledWith(failure);
    expect(cb.finalize).toHaveBeenCalledWith("error");
  });

  it("the caller still sees the rejection through then/catch", async () => {
    const failure = new Error("boom");
    const sdkPromise = Promise.reject(failure);
    sdkPromise.catch(() => {});

    const wrapped = wrapPromise(sdkPromise, callbacks(), { preserveOriginal: sdkPromise });

    await expect(wrapped).rejects.toBe(failure);
  });
});

/**
 * JS-MEM-003: the span of a stream the app drops is ended once the stream is
 * garbage-collected. A stream that is still being read must never be
 * finalized that way, however the app holds it.
 */
describe("wrapAsyncIterable garbage-collection finalizer", () => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

  async function* chunks(n = 4) {
    for (let i = 0; i < n; i++) {
      await tick();
      yield i;
    }
  }

  function readableChunks(n = 4) {
    let i = 0;
    return new ReadableStream<number>({
      async pull(controller) {
        await tick();
        if (i < n) controller.enqueue(i++);
        else controller.close();
      },
    });
  }

  /** Records chunk and finalize order. */
  function recorder() {
    const events: string[] = [];
    const cb = {
      withContext: <T>(fn: () => T) => fn(),
      onChunk: (c: unknown) => events.push(`chunk ${c}`),
      onError: vi.fn(),
      onSuccess: vi.fn(),
      finalize: (status: string) => events.push(`finalize ${status}`),
    };
    return { events, cb };
  }

  async function collect() {
    for (let i = 0; i < 3; i++) {
      gc();
      await tick();
    }
  }

  const expected = ["chunk 0", "chunk 1", "chunk 2", "chunk 3", "finalize ok", "done"];

  it("keeps the span open while for-await holds only the iterator", async () => {
    const { events, cb } = recorder();
    // The wrapped stream is a temporary: only the loop's iterator lives on.
    for await (const _ of wrapAsyncIterable(chunks(), cb)) await collect();
    events.push("done");
    expect(events).toEqual(expected);
  });

  it("keeps the span open while the app holds only a reader", async () => {
    const { events, cb } = recorder();
    const reader = wrapAsyncIterable(readableChunks() as any, cb).getReader();
    for (;;) {
      await collect();
      if ((await reader.read()).done) break;
    }
    events.push("done");
    expect(events).toEqual(expected);
  });

  it("keeps the span open while the app reads a stream from .withResponse()", async () => {
    const { events, cb } = recorder();
    const stream = chunks();
    // An SDK promise whose withResponse() returns the same (cached) stream.
    const sdkPromise = Object.assign(Promise.resolve(stream), {
      withResponse: async () => ({ data: stream, response: {} }),
    });
    const { data } = await wrapPromise(sdkPromise, cb, { preserveOriginal: sdkPromise }).withResponse();
    for await (const _ of data) await collect();
    events.push("done");
    expect(events).toEqual(expected);
  });

  it("still ends the span of a stream the app drops", async () => {
    const { events, cb } = recorder();
    (() => {
      wrapAsyncIterable(chunks(), cb);
    })();
    for (let i = 0; i < 20 && events.length === 0; i++) await collect();
    expect(events).toEqual(["finalize ok"]);
  });

  it("ends the span of a stream from a wrapped promise that the app drops", async () => {
    const { events, cb } = recorder();
    await (async () => {
      await wrapPromise(Promise.resolve(chunks()), cb);
    })();
    for (let i = 0; i < 20 && events.length === 0; i++) await collect();
    expect(events).toEqual(["finalize ok"]);
  });

  it("ends the span of a dropped stream when the SDK promise is preserved", async () => {
    const { events, cb } = recorder();
    await (async () => {
      const stream = chunks();
      const sdkPromise = Object.assign(Promise.resolve(stream), {
        withResponse: async () => ({ data: stream, response: {} }),
      });
      await wrapPromise(sdkPromise, cb, { preserveOriginal: sdkPromise });
    })();
    for (let i = 0; i < 20 && events.length === 0; i++) await collect();
    expect(events).toEqual(["finalize ok"]);
  });
});

