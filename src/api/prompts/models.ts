/**
 * Prompts API Models
 */

export interface GetPromptParams {
  name: string;
  label?: string;
  /** When true, serve from in-memory cache when available (default: false). */
  useCache?: boolean;
  /** Per-call TTL in seconds; falls back to init `cacheTtlSeconds` when omitted. */
  cacheTtl?: number;
}

/**
 * Prompt response is intentionally flexible because
 * backend prompt structures may evolve (variables, templates, metadata etc.)
 */
export type PromptResponse = Record<string, any>;
