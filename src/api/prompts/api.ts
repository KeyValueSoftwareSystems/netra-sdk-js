import { Config } from "../../config";
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
   * Fetch prompt version by name + label
   */
  async getPrompt(params: GetPromptParams): Promise<PromptResponse | null> {
    if (!this.isValidParams(params)) {
      throw new TypeError(
        "params must contain { name: string, label: string }",
      );
    }

    const result = await this.client.getPromptVersion(
      params.name,
      params.label,
    );

    if (!result) {
      return null;
    }

    return result.data ?? null;
  }

  private isValidParams(value: any): value is GetPromptParams {
    return (
      value &&
      typeof value === "object" &&
      typeof value.name === "string" &&
      typeof value.label === "string"
    );
  }
}
