import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptsHttpClient } from "./api/prompts/client";

vi.mock("./instrumentation", () => ({
  initInstrumentations: vi.fn(() => ({})),
  instrumentationsReady: Promise.resolve(),
  uninstrumentAll: vi.fn(() => Promise.resolve()),
}));

import { Netra } from "./index";

describe("Netra.shutdown cache clearing", () => {
  afterEach(async () => {
    if (Netra.isInitialized()) {
      await Netra.shutdown();
    }
  });

  it("clears prompts cache on shutdown so the next cached getPrompt hits HTTP", async () => {
    await Netra.init({ cacheTtlSeconds: 60 });

    const getPromptVersion = vi
      .fn()
      .mockResolvedValue({ data: { template: "v1" } });
    (Netra.prompts as unknown as { client: PromptsHttpClient }).client = {
      getPromptVersion,
    } as unknown as PromptsHttpClient;

    await Netra.prompts.getPrompt({ name: "my-prompt", useCache: true });
    await Netra.prompts.getPrompt({ name: "my-prompt", useCache: true });
    expect(getPromptVersion).toHaveBeenCalledTimes(1);

    await Netra.shutdown();

    await Netra.init({ cacheTtlSeconds: 60 });
    (Netra.prompts as unknown as { client: PromptsHttpClient }).client = {
      getPromptVersion,
    } as unknown as PromptsHttpClient;

    await Netra.prompts.getPrompt({ name: "my-prompt", useCache: true });
    expect(getPromptVersion).toHaveBeenCalledTimes(2);
  });
});
