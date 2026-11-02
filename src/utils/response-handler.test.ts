import { describe, expect, it, vi } from "vitest";

import { captureUnhandledRejections, settle } from "../__fixtures__/llm-test-utils";
import { wrapPromise } from "./response-handler";

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
