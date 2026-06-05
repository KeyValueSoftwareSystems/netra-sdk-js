import { Config } from "../../config";
import { Logger } from "../../logger";
import { PromptsHttpClient } from "./client";
import { GetPromptParams, PromptResponse } from "./models";

export class Prompts {
  private config: Config;
  private client: PromptsHttpClient;

  constructor(config: Config) {
    this.config = config;
    this.client = new PromptsHttpClient(config);
  }

  /**
   * Fetch prompt version by name and label.
   *
   * @param params.name  - Name of the prompt (required)
   * @param params.label - Label of the prompt version (default: "production")
   */
  async getPrompt(params: GetPromptParams): Promise<PromptResponse | null> {
    if (!params || typeof params.name !== "string" || !params.name) {
      Logger.error("netra.prompts: name is required to fetch a prompt");
      return null;
    }

    const label = params.label ?? "production";
    const result = await this.client.getPromptVersion(params.name, label);

    if (!result) {
      return null;
    }

    return result.data ?? null;
  }
}
