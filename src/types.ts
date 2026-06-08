/**
 * Type definitions for Netra SDK
 */

import { SpanWrapper } from "./span-wrapper";

export enum SpanType {
  SPAN = "SPAN",
  GENERATION = "GENERATION",
  TOOL = "TOOL",
  EMBEDDING = "EMBEDDING",
  AGENT = "AGENT",
  HANDOFF = "HANDOFF",
  GUARDRAIL = "GUARDRAIL",
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

export interface SpanOptions {
  attributes?: Record<string, string>;
  moduleName?: string;
  asType?: SpanType;
}

export interface DecoratorOptions {
  name?: string;
  asType?: SpanType;
}

export type SpanCallback<T> = (span: SpanWrapper) => T;
