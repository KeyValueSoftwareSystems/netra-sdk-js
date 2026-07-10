import { TTLCache } from "../../cache";
import { Config } from "../../config";
import { Logger } from "../../logger";
import { PromptsHttpClient } from "./client";
import { GetPromptParams, PromptResponse } from "./models";

export class Prompts {
  private config: Config;
  private client: PromptsHttpClient;
  private cache: TTLCache<PromptResponse>;

  constructor(config: Config) {
    this.config = config;
    this.client = new PromptsHttpClient(config);
    this.cache = new TTLCache<PromptResponse>(config.cacheTtlSeconds);
  }

  /** Clear all cached prompt entries. */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Fetch prompt version by name and label.
   *
   * @param params.name      - Name of the prompt (required)
   * @param params.label     - Label of the prompt version (default: "production")
   * @param params.useCache  - When true, read/write the in-memory cache (default: false)
   * @param params.cacheTtl  - Per-call cache TTL in seconds (default: init cacheTtlSeconds)
   */
  async getPrompt(params: GetPromptParams): Promise<PromptResponse | null> {
    if (!params || typeof params.name !== "string" || !params.name) {
      Logger.error("netra.prompts: name is required to fetch a prompt");
      return null;
    }

    const label = params.label ?? "production";
    const useCache = params.useCache === true;
    const cacheKey = `prompt:${params.name}:${label}`;

    if (useCache) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const result = await this.client.getPromptVersion(params.name, label);

    if (!result) {
      return null;
    }

    const data = result.data ?? null;

    if (data !== null && useCache) {
      this.cache.set(cacheKey, data, params.cacheTtl);
    }

    return data;
  }
}
