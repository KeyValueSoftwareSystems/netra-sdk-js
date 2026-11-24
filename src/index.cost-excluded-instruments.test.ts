import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./instrumentation", () => ({
  initInstrumentations: vi.fn(() => ({})),
  instrumentationsReady: Promise.resolve(),
  uninstrumentAll: vi.fn(() => Promise.resolve()),
}));

import { NetraInstruments } from "./config";
import { Netra } from "./index";
import { initInstrumentations } from "./instrumentation";

describe("Netra.init costExcludedInstruments", () => {
  afterEach(async () => {
    vi.mocked(initInstrumentations).mockClear();
    if (Netra.isInitialized()) {
      await Netra.shutdown();
    }
  });

  it.each([
    ["omitted", undefined],
    ["set", new Set([NetraInstruments.OPENAI])],
  ])("passes costExcludedInstruments to initInstrumentations when %s", async (_label, excluded) => {
    await Netra.init({ registerShutdownHooks: false, costExcludedInstruments: excluded });

    expect(initInstrumentations).toHaveBeenCalledTimes(1);
    expect(vi.mocked(initInstrumentations).mock.calls[0]?.[4]).toBe(excluded);
  });
});
