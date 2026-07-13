import { TTLCache } from "../../cache";
import { Config } from "../../config";
import { ModelsHttpClient } from "./client";
import {
  GetModelPricingParams,
  MODEL_PRICING_CACHE_TTL_SECONDS,
  ModelPricing,
} from "./models";

export class Models {
  private config: Config;
  private client: ModelsHttpClient;
  private cache: TTLCache<ModelPricing[]>;

  constructor(config: Config) {
    this.config = config;
    this.client = new ModelsHttpClient(config);
    this.cache = new TTLCache<ModelPricing[]>(MODEL_PRICING_CACHE_TTL_SECONDS);
  }

  /** Clear all cached model pricing entries. */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Fetch model pricing from the backend.
   *
   * @param params.name     - Optional model name filter
   * @param params.useCache - When true, read/write the in-memory cache (default: false)
   * @param params.cacheTtl - Per-call cache TTL in seconds (default: MODEL_PRICING_CACHE_TTL_SECONDS)
   */
  async getModelPricing(
    params: GetModelPricingParams = {},
  ): Promise<ModelPricing[] | null> {
    const useCache = params.useCache === true;
    const cacheKey = `model:pricing:${params.name ?? "all"}`;

    if (useCache) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const data = await this.client.getModelPricing(params.name);

    if (data !== null && useCache) {
      this.cache.set(cacheKey, data, params.cacheTtl);
    }

    return data;
  }
}
