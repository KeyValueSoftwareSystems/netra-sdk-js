/**
 * Prompts API Models
 */

/** Default TTL (seconds) for prompt cache when useCache is true and cacheTtl is omitted. */
export const PROMPT_CACHE_TTL_SECONDS = 60;

export interface GetPromptParams {
  name: string;
  label?: string;
  /** When true, serve from in-memory cache when available (default: false). */
  useCache?: boolean;
  /**
   * Per-call TTL in seconds.
   * When omitted with useCache: true, uses PROMPT_CACHE_TTL_SECONDS (60).
   */
  cacheTtl?: number;
}

/**
 * Prompt response is intentionally flexible because
 * backend prompt structures may evolve (variables, templates, metadata etc.)
 */
export type PromptResponse = Record<string, any>;
