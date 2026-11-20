import { TTLCache } from "../../cache";
import { Config } from "../../config";
import { NetraLogger } from "../../netraLogger";
import { PromptsHttpClient } from "./client";
import {
  GetPromptParams,
  PROMPT_CACHE_TTL_SECONDS,
  PromptResponse,
} from "./models";

export class Prompts {
  private config: Config;
  private client: PromptsHttpClient;
  private cache: TTLCache<PromptResponse>;
  private readonly inFlight = new Map<string, Promise<PromptResponse | null>>();

  constructor(config: Config) {
    this.config = config;
    this.client = new PromptsHttpClient(config);
    this.cache = new TTLCache<PromptResponse>(PROMPT_CACHE_TTL_SECONDS);
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
   * @param params.cacheTtl  - Per-call cache TTL in seconds (default: PROMPT_CACHE_TTL_SECONDS)
   */
  async getPrompt(params: GetPromptParams): Promise<PromptResponse | null> {
    if (!params || typeof params.name !== "string" || !params.name) {
      NetraLogger.notice("error", "netra.prompts: name is required to fetch a prompt");
      return null;
    }

    const label = params.label ?? "production";
    const useCache = params.useCache === true;
    // JSON keeps name and label apart: with a ":" join, name "a:b" + label
    // "c" and name "a" + label "b:c" shared one entry (JS-SEC-023).
    const cacheKey = `prompt:${JSON.stringify([params.name, label])}`;

    if (!useCache) {
      return this.fetchPrompt(params.name, label);
    }

    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Concurrent misses for the same key share one request instead of each
    // fetching the prompt (JS-PERF-015).
    let pending = this.inFlight.get(cacheKey);
    if (!pending) {
      pending = this.fetchPrompt(params.name, label)
        .then((data) => {
          if (data !== null) this.cache.set(cacheKey, data, params.cacheTtl);
          return data;
        })
        .finally(() => this.inFlight.delete(cacheKey));
      this.inFlight.set(cacheKey, pending);
    }
    const data = await pending;
    if (data === null) return null;
    // Each caller gets its own copy from the cache, as a cache hit does.
    return this.cache.get(cacheKey) ?? structuredClone(data);
  }

  private async fetchPrompt(name: string, label: string): Promise<PromptResponse | null> {
    const result = await this.client.getPromptVersion(name, label);
    if (!result) {
      return null;
    }
    return result.data ?? null;
  }
}
