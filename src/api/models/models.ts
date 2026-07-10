/**
 * Models API Models
 */

/** Default TTL (seconds) for model pricing cache when useCache is true and cacheTtl is omitted. */
export const MODEL_PRICING_CACHE_TTL_SECONDS = 300;

export interface ModelPrice {
  usageType: string;
  minUnits: number;
  maxUnits: number;
  price: number;
  unitValue: number;
}

export interface ModelPricing {
  name: string;
  projectId: string | null;
  matchPattern: string;
  prices: ModelPrice[];
}

export interface GetModelPricingParams {
  name?: string;
  /** When true, read/write in-memory cache (default: false). */
  useCache?: boolean;
  /**
   * Per-call TTL in seconds.
   * When omitted with useCache: true, uses MODEL_PRICING_CACHE_TTL_SECONDS (300),
   * NOT Config.cacheTtlSeconds.
   */
  cacheTtl?: number;
}
