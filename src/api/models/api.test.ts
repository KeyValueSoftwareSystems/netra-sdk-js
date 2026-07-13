import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../config";
import { Models } from "./api";
import { ModelsHttpClient } from "./client";
import { ModelPricing } from "./models";

const samplePricing: ModelPricing[] = [
  {
    name: "gpt-4",
    projectId: null,
    matchPattern: "gpt-4*",
    prices: [
      {
        usageType: "input",
        minUnits: 0,
        maxUnits: 1000,
        price: 0.03,
        unitValue: 1000,
      },
    ],
  },
];

describe("Models.getModelPricing caching", () => {
  let models: Models;
  let getModelPricing: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const config = new Config();
    models = new Models(config);
    getModelPricing = vi.fn();
    (models as unknown as { client: ModelsHttpClient }).client = {
      getModelPricing,
    } as unknown as ModelsHttpClient;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls HTTP on every request when useCache is omitted", async () => {
    getModelPricing.mockResolvedValue(samplePricing);

    await models.getModelPricing();
    await models.getModelPricing();

    expect(getModelPricing).toHaveBeenCalledTimes(2);
  });

  it("serves from cache on second call with same name when useCache is true", async () => {
    getModelPricing.mockResolvedValue(samplePricing);

    const first = await models.getModelPricing({
      name: "gpt-4",
      useCache: true,
    });
    const second = await models.getModelPricing({
      name: "gpt-4",
      useCache: true,
    });

    expect(getModelPricing).toHaveBeenCalledTimes(1);
    expect(getModelPricing).toHaveBeenCalledWith("gpt-4");
    expect(first).toEqual(samplePricing);
    expect(second).toEqual(samplePricing);
  });

  it("keeps separate cache entries for different name and all", async () => {
    const allPricing: ModelPricing[] = [];
    getModelPricing
      .mockResolvedValueOnce(samplePricing)
      .mockResolvedValueOnce(allPricing);

    const named = await models.getModelPricing({
      name: "gpt-4",
      useCache: true,
    });
    const all = await models.getModelPricing({ useCache: true });

    expect(getModelPricing).toHaveBeenCalledTimes(2);
    expect(getModelPricing).toHaveBeenNthCalledWith(1, "gpt-4");
    expect(getModelPricing).toHaveBeenNthCalledWith(2, undefined);
    expect(named).toEqual(samplePricing);
    expect(all).toEqual(allPricing);
  });

  it("does not cache null API responses", async () => {
    getModelPricing.mockResolvedValue(null);

    await models.getModelPricing({ useCache: true });
    await models.getModelPricing({ useCache: true });

    expect(getModelPricing).toHaveBeenCalledTimes(2);
  });

  it("caches empty arrays as successful responses", async () => {
    getModelPricing.mockResolvedValue([]);

    await models.getModelPricing({ useCache: true });
    await models.getModelPricing({ useCache: true });

    expect(getModelPricing).toHaveBeenCalledTimes(1);
  });

  it("ignores cache when useCache is false even if cacheTtl is set", async () => {
    getModelPricing.mockResolvedValue(samplePricing);

    await models.getModelPricing({ useCache: false, cacheTtl: 30 });
    await models.getModelPricing({ useCache: false, cacheTtl: 30 });

    expect(getModelPricing).toHaveBeenCalledTimes(2);
  });

  it("expires per-call cacheTtl before the models default TTL", async () => {
    vi.useFakeTimers();
    getModelPricing.mockResolvedValue(samplePricing);

    await models.getModelPricing({ useCache: true, cacheTtl: 1 });
    expect(getModelPricing).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1001);

    await models.getModelPricing({ useCache: true, cacheTtl: 1 });
    expect(getModelPricing).toHaveBeenCalledTimes(2);
  });

  it("hits HTTP again after clearCache when useCache is true", async () => {
    getModelPricing.mockResolvedValue(samplePricing);

    await models.getModelPricing({ useCache: true });
    models.clearCache();
    await models.getModelPricing({ useCache: true });

    expect(getModelPricing).toHaveBeenCalledTimes(2);
  });
});
