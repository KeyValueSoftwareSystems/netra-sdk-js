/**
 * Type definitions for Netra SDK
 */

import { Span } from "@opentelemetry/api";

export enum SpanType {
  SPAN = "SPAN",
  GENERATION = "GENERATION",
  TOOL = "TOOL",
  EMBEDDING = "EMBEDDING",
  AGENT = "AGENT",
}

export enum ConversationType {
  INPUT = "input",
  OUTPUT = "output",
}

export interface UsageModel {
  model: string;
  usage_type: string;
  units_used?: number;
  cost_in_usd?: number;
}

export interface ActionModel {
  start_time: string;
  action: string;
  action_type: string;
  success: boolean;
  affected_records?: Array<{ record_id: string; record_type: string }>;
  metadata?: Record<string, string>;
}

export interface SpanWrapperOptions {
  name: string;
  attributes?: Record<string, string>;
  moduleName?: string;
  asType?: SpanType;
}

export interface DecoratorOptions {
  name?: string;
  asType?: SpanType;
}

/**
 * Options for running a function with isolated session context.
 * Used with Netra.runWithSession().
 */
export interface RunInContextOptions {
  /** Session ID to set for this context */
  sessionId?: string;
  /** User ID to set for this context */
  userId?: string;
  /** Tenant ID to set for this context */
  tenantId?: string;
  /** Custom attributes to set on spans in this context */
  customAttributes?: Record<string, string>;
}


