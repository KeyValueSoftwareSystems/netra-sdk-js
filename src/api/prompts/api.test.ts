import { beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../config";
import { Prompts } from "./api";
import { PromptsHttpClient } from "./client";

describe("Prompts.getPrompt caching", () => {
  let prompts: Prompts;
  let getPromptVersion: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const config = new Config({ cacheTtlSeconds: 60 });
    prompts = new Prompts(config);
    getPromptVersion = vi.fn();
    (prompts as unknown as { client: PromptsHttpClient }).client = {
      getPromptVersion,
    } as unknown as PromptsHttpClient;
  });

  it("calls HTTP on every request when useCache is omitted", async () => {
    getPromptVersion.mockResolvedValue({ data: { template: "v1" } });

    await prompts.getPrompt({ name: "my-prompt" });
    await prompts.getPrompt({ name: "my-prompt" });

    expect(getPromptVersion).toHaveBeenCalledTimes(2);
  });

  it("serves from cache on second call with same name and label when useCache is true", async () => {
    getPromptVersion.mockResolvedValue({ data: { template: "v1" } });

    const first = await prompts.getPrompt({ name: "my-prompt", useCache: true });
    const second = await prompts.getPrompt({ name: "my-prompt", useCache: true });

    expect(getPromptVersion).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ template: "v1" });
    expect(second).toEqual({ template: "v1" });
  });

  it("keeps separate cache entries per label when useCache is true", async () => {
    getPromptVersion
      .mockResolvedValueOnce({ data: { template: "prod" } })
      .mockResolvedValueOnce({ data: { template: "staging" } });

    const prod = await prompts.getPrompt({
      name: "my-prompt",
      label: "production",
      useCache: true,
    });
    const staging = await prompts.getPrompt({
      name: "my-prompt",
      label: "staging",
      useCache: true,
    });

    expect(getPromptVersion).toHaveBeenCalledTimes(2);
    expect(prod).toEqual({ template: "prod" });
    expect(staging).toEqual({ template: "staging" });
  });

  it("does not cache null API responses", async () => {
    getPromptVersion.mockResolvedValue(null);

    await prompts.getPrompt({ name: "my-prompt", useCache: true });
    await prompts.getPrompt({ name: "my-prompt", useCache: true });

    expect(getPromptVersion).toHaveBeenCalledTimes(2);
  });

  it("ignores cache when useCache is false even if cacheTtl is set", async () => {
    getPromptVersion.mockResolvedValue({ data: { template: "v1" } });

    await prompts.getPrompt({
      name: "my-prompt",
      useCache: false,
      cacheTtl: 30,
    });
    await prompts.getPrompt({
      name: "my-prompt",
      useCache: false,
      cacheTtl: 30,
    });

    expect(getPromptVersion).toHaveBeenCalledTimes(2);
  });

  it("hits HTTP again after clearCache when useCache is true", async () => {
    getPromptVersion.mockResolvedValue({ data: { template: "v1" } });

    await prompts.getPrompt({ name: "my-prompt", useCache: true });
    prompts.clearCache();
    await prompts.getPrompt({ name: "my-prompt", useCache: true });

    expect(getPromptVersion).toHaveBeenCalledTimes(2);
  });
});
