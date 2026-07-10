import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelsHttpClient } from "./api/models/client";
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

  it("clears models cache on shutdown so the next cached getModelPricing hits HTTP", async () => {
    await Netra.init({ cacheTtlSeconds: 60 });

    const pricing = [
      {
        name: "gpt-4",
        projectId: null,
        matchPattern: "gpt-4*",
        prices: [],
      },
    ];
    const getModelPricing = vi.fn().mockResolvedValue(pricing);
    (Netra.models as unknown as { client: ModelsHttpClient }).client = {
      getModelPricing,
    } as unknown as ModelsHttpClient;

    await Netra.models.getModelPricing({ useCache: true });
    await Netra.models.getModelPricing({ useCache: true });
    expect(getModelPricing).toHaveBeenCalledTimes(1);

    await Netra.shutdown();

    await Netra.init({ cacheTtlSeconds: 60 });
    (Netra.models as unknown as { client: ModelsHttpClient }).client = {
      getModelPricing,
    } as unknown as ModelsHttpClient;

    await Netra.models.getModelPricing({ useCache: true });
    expect(getModelPricing).toHaveBeenCalledTimes(2);
  });
});
