/**
 * Prompts API Models
 */

export interface GetPromptParams {
  name: string;
  label: string;
}

/**
 * Prompt response is intentionally flexible because
 * backend prompt structures may evolve (variables, templates, metadata etc.)
 */
export type PromptResponse = Record<string, any>;
