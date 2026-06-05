/**
 * Internal HTTP client for Prompts APIs
 */

import { Config } from "../../config";
import { Logger } from "../../logger";
import { NetraHttpClient } from "../http-client";

export class PromptsHttpClient extends NetraHttpClient {
  constructor(config: Config) {
    super(config, "NETRA_PROMPTS_TIMEOUT", 30.0);
  }

  /**
   * Fetch prompt version from backend
   */
  async getPromptVersion(name: string, label: string): Promise<any | null> {
    if (!this.isInitialized()) {
      Logger.error(
        "netra.prompts: Prompts client is not initialized; cannot fetch prompt",
      );
      return null;
    }

    try {
      const payload = {
        promptName: name,
        label: label,
      };

      const response = await this.post("/sdk/prompts/version", payload);

      if (!response.ok) {
        const errorMessage = response.data?.error?.message ?? "Unknown error";

        Logger.error(`netra.prompts: Failed to fetch prompt: ${errorMessage}`);

        return null;
      }

      return response.data;
    } catch (err: any) {
      const message = err?.response?.data?.error?.message ?? "";

      Logger.error("netra.prompts: Failed to fetch prompt:", message);

      return null;
    }
  }
}
