/**
 * Internal HTTP client for Models APIs
 */

import { Config } from "../../config";
import { Logger } from "../../logger";
import { NetraHttpClient } from "../http-client";
import { ModelPricing } from "./models";

export class ModelsHttpClient extends NetraHttpClient {
  constructor(config: Config) {
    super(config, "NETRA_MODELS_TIMEOUT", 10.0);
  }

  async getModelPricing(name?: string): Promise<ModelPricing[] | null> {
    if (!this.isInitialized()) {
      Logger.error(
        "netra.models: Models client is not initialized; cannot fetch model pricing",
      );
      return null;
    }

    try {
      const params = name ? { name } : undefined;
      const response = await this.get("/sdk/models", params);

      if (!response.ok) {
        const errorMessage = response.data?.error?.message ?? "Unknown error";
        Logger.error(
          `netra.models: Failed to fetch model pricing: ${errorMessage}`,
        );
        return null;
      }

      const items = this.extractData<ModelPricing[] | null>(response, null);
      if (items !== null && !Array.isArray(items)) {
        Logger.error(
          "netra.models: Unexpected response format; expected an array",
        );
        return null;
      }
      return items;
    } catch (err: any) {
      const message = err?.response?.data?.error?.message ?? err?.message ?? "";
      Logger.error("netra.models: Failed to fetch model pricing:", message);
      return null;
    }
  }
}
