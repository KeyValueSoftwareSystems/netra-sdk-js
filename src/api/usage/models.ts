/**
 * Usage API Models
 */

export interface SessionUsageData {
  sessionId: string;
  tokenCount: number;
  requestCount: number;
  totalCost: number;
}

export interface TenantUsageData {
  tenantId: string;
  organisationId: string;
  tokenCount: number;
  requestCount: number;
  sessionCount: number;
  totalCost: number;
}

export interface TraceSummary {
  id: string;
  name: string;
  kind: string;
  latencyMs: number;
  startTime: string;
  endTime: string;
  cursor: string;
  organisationId: string;
  projectId: string;
  sessionId?: string;
  tenantId?: string;
  userId?: string;
  environment?: string;
  models?: string[];
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  promptTokensCost?: number;
  completionTokensCost?: number;
  cachedTokensCost?: number;
  totalCost?: number;
  hasPii?: boolean;
  piiEntities?: any[];
  hasViolation?: boolean;
  violations?: any[];
  hasError?: boolean;
  service?: string;
}

export interface TracesPage {
  traces: TraceSummary[];
  hasNextPage: boolean;
  nextCursor?: string;
}

export interface TraceSpan {
  id: string;
  traceId: string;
  name: string;
  kind: string;
  parentSpanId?: string;
  latencyMs?: number;
  startTimeMs?: string;
  endTimeMs?: string;
  organisationId: string;
  projectId: string;
  sessionId?: string;
  tenantId?: string;
  userId?: string;
  environment?: string;
  modelName?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  promptTokensCost?: number;
  completionTokensCost?: number;
  cachedTokensCost?: number;
  totalCost?: number;
  hasPii?: boolean;
  piiEntities?: any[];
  piiActions?: Record<string, any>;
  hasViolation?: boolean;
  violations?: any[];
  violationActions?: Record<string, any>;
  status?: string;
  attributes?: string;
  events?: string;
  links?: string;
  resources?: string;
  metadata?: Record<string, any>;
  hasError?: boolean;
  createdAt: string;
  cursor: string;
}

export interface SpansPage {
  spans: TraceSpan[];
  hasNextPage: boolean;
  nextCursor?: string;
}

export interface ListTracesParams {
  startTime: string;
  endTime: string;
  traceId?: string;
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  limit?: number;
  cursor?: string;
  direction?: "up" | "down";
  sortField?: string;
  sortOrder?: "asc" | "desc";
}

export interface ListSpansParams {
  traceId: string;
  cursor?: string;
  direction?: "up" | "down";
  limit?: number;
  spanName?: string;
}
