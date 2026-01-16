/**
 * Public Usage API
 * Exposed as Netra.usage
 */

import { Config } from "../../config";
import { UsageHttpClient } from "./client";
import {
  ListSpansParams,
  ListTracesParams,
  SessionUsageData,
  SpansPage,
  TenantUsageData,
  TraceSpan,
  TracesPage,
  TraceSummary,
} from "./models";

export class Usage {
  private config: Config;
  private client: UsageHttpClient;

  constructor(config: Config) {
    this.config = config;
    this.client = new UsageHttpClient(config);
  }

  /**
   * Get session usage data
   * @param sessionId Session identifier
   * @param startTime Start time for the usage data (in ISO 8601 UTC format)
   * @param endTime End time for the usage data (in ISO 8601 UTC format)
   * @returns Session usage data or null on error
   */
  async getSessionUsage(
    sessionId: string,
    startTime: string,
    endTime: string
  ): Promise<SessionUsageData | null> {
    if (!sessionId) {
      console.error("netra.usage: session_id is required to fetch session usage");
      return null;
    }
    if (!startTime || !endTime) {
      console.error(
        "netra.usage: start_time and end_time are required to fetch session usage"
      );
      return null;
    }

    const result = await this.client.getSessionUsage(sessionId, startTime, endTime);
    const sessionIdFromResult = result.session_id;
    if (!sessionIdFromResult) {
      return null;
    }

    return {
      sessionId: sessionIdFromResult,
      tokenCount: result.tokenCount ?? 0,
      requestCount: result.requestsCount ?? 0,
      totalCost: result.totalCost ?? 0.0,
    };
  }

  /**
   * Get tenant usage data
   * @param tenantId Tenant identifier
   * @param startTime Start time for the usage data (in ISO 8601 UTC format)
   * @param endTime End time for the usage data (in ISO 8601 UTC format)
   * @returns Tenant usage data or null on error
   */
  async getTenantUsage(
    tenantId: string,
    startTime: string,
    endTime: string
  ): Promise<TenantUsageData | null> {
    if (!tenantId) {
      console.error("netra.usage: tenant_id is required to fetch tenant usage");
      return null;
    }
    if (!startTime || !endTime) {
      console.error(
        "netra.usage: start_time and end_time are required to fetch tenant usage"
      );
      return null;
    }

    const result = await this.client.getTenantUsage(tenantId, startTime, endTime);
    const tenantIdFromResult = result.tenant_id;
    if (!tenantIdFromResult) {
      return null;
    }

    return {
      tenantId: tenantIdFromResult,
      organisationId: result.organisation_id ?? "",
      tokenCount: result.tokenCount ?? 0,
      requestCount: result.requestsCount ?? 0,
      sessionCount: result.sessionsCount ?? 0,
      totalCost: result.totalCost ?? 0.0,
    };
  }

  /**
   * List all traces
   * @param params List traces parameters
   * @returns Traces page or null on error
   */
  async listTraces(params: ListTracesParams): Promise<TracesPage | null> {
    if (!params.startTime || !params.endTime) {
      console.error("netra.usage: start_time and end_time are required to list traces");
      return null;
    }

    const result = await this.client.listTraces({
      startTime: params.startTime,
      endTime: params.endTime,
      traceId: params.traceId,
      sessionId: params.sessionId,
      userId: params.userId,
      tenantId: params.tenantId,
      limit: params.limit,
      cursor: params.cursor,
      direction: params.direction,
      sortField: params.sortField,
      sortOrder: params.sortOrder,
    });

    if (!result || typeof result !== "object") {
      return null;
    }

    const dataBlock = result.data ?? {};
    const items = dataBlock.data ?? [];
    const pageInfo = dataBlock.pageInfo ?? {};
    const hasNextPage = Boolean(pageInfo.hasNextPage);

    let nextCursor: string | undefined;
    if (items.length > 0) {
      const lastItem = items[items.length - 1];
      if (lastItem && typeof lastItem === "object") {
        nextCursor = lastItem.cursor;
      }
    }

    const traces: TraceSummary[] = items
      .filter((item: any) => item && typeof item === "object")
      .map((item: any) => this.mapToTraceSummary(item));

    return {
      traces,
      hasNextPage,
      nextCursor,
    };
  }

  /**
   * List all spans for a given trace
   * @param params List spans parameters
   * @returns Spans page or null on error
   */
  async listSpansByTraceId(params: ListSpansParams): Promise<SpansPage | null> {
    if (!params.traceId) {
      console.error("netra.usage: trace_id is required to list spans");
      return null;
    }

    const result = await this.client.listSpansByTraceId({
      traceId: params.traceId,
      cursor: params.cursor,
      direction: params.direction,
      limit: params.limit,
      spanName: params.spanName,
    });

    if (!result || typeof result !== "object") {
      return null;
    }

    const dataBlock = result.data ?? {};
    const items = dataBlock.data ?? [];
    const pageInfo = dataBlock.pageInfo ?? {};
    const hasNextPage = Boolean(pageInfo.hasNextPage);

    let nextCursor: string | undefined;
    if (items.length > 0) {
      const lastItem = items[items.length - 1];
      if (lastItem && typeof lastItem === "object") {
        nextCursor = lastItem.cursor;
      }
    }

    const spans: TraceSpan[] = items
      .filter((item: any) => item && typeof item === "object")
      .map((item: any) => this.mapToTraceSpan(item));

    return {
      spans,
      hasNextPage,
      nextCursor,
    };
  }

  /**
   * Iterate over traces using cursor-based pagination
   * @param params List traces parameters
   * @returns Async generator yielding TraceSummary items
   */
  async *iterTraces(
    params: ListTracesParams
  ): AsyncGenerator<TraceSummary, void, unknown> {
    if (!params.startTime || !params.endTime) {
      console.error("netra.usage: start_time and end_time are required to iterate traces");
      return;
    }

    let currentCursor = params.cursor;

    while (true) {
      const page = await this.listTraces({
        ...params,
        cursor: currentCursor,
      });

      if (!page) {
        break;
      }

      for (const trace of page.traces) {
        yield trace;
      }

      if (!page.hasNextPage || !page.nextCursor) {
        break;
      }

      currentCursor = page.nextCursor;
    }
  }

  /**
   * Iterate over spans for a given trace using cursor-based pagination
   * @param params List spans parameters
   * @returns Async generator yielding TraceSpan items
   */
  async *iterSpansByTraceId(
    params: ListSpansParams
  ): AsyncGenerator<TraceSpan, void, unknown> {
    if (!params.traceId) {
      console.error("netra.usage: trace_id is required to iterate spans");
      return;
    }

    let currentCursor = params.cursor;

    while (true) {
      const page = await this.listSpansByTraceId({
        ...params,
        cursor: currentCursor,
      });

      if (!page) {
        break;
      }

      for (const span of page.spans) {
        yield span;
      }

      if (!page.hasNextPage || !page.nextCursor) {
        break;
      }

      currentCursor = page.nextCursor;
    }
  }

  private mapToTraceSummary(item: any): TraceSummary {
    return {
      id: item.id ?? "",
      name: item.name ?? "",
      kind: item.kind ?? "",
      latencyMs: item.latency_ms ?? 0,
      startTime: item.start_time ?? "",
      endTime: item.end_time ?? "",
      cursor: item.cursor ?? "",
      organisationId: item.organisation_id ?? "",
      projectId: item.project_id ?? "",
      sessionId: item.session_id,
      tenantId: item.tenant_id,
      userId: item.user_id,
      environment: item.environment,
      models: item.models,
      promptTokens: item.prompt_tokens,
      completionTokens: item.completion_tokens,
      cachedTokens: item.cached_tokens,
      totalTokens: item.total_tokens,
      promptTokensCost: item.prompt_tokens_cost,
      completionTokensCost: item.completion_tokens_cost,
      cachedTokensCost: item.cached_tokens_cost,
      totalCost: item.total_cost,
      hasPii: item.has_pii,
      piiEntities: item.pii_entities,
      hasViolation: item.has_violation,
      violations: item.violations,
      hasError: item.has_error,
      service: item.service,
    };
  }

  private mapToTraceSpan(item: any): TraceSpan {
    return {
      id: item.id ?? "",
      traceId: item.trace_id ?? "",
      name: item.name ?? "",
      kind: item.kind ?? "",
      parentSpanId: item.parent_span_id,
      latencyMs: item.latency_ms,
      startTimeMs: item.start_time_ms,
      endTimeMs: item.end_time_ms,
      organisationId: item.organisation_id ?? "",
      projectId: item.project_id ?? "",
      sessionId: item.session_id,
      tenantId: item.tenant_id,
      userId: item.user_id,
      environment: item.environment,
      modelName: item.model_name,
      promptTokens: item.prompt_tokens,
      completionTokens: item.completion_tokens,
      cachedTokens: item.cached_tokens,
      totalTokens: item.total_tokens,
      promptTokensCost: item.prompt_tokens_cost,
      completionTokensCost: item.completion_tokens_cost,
      cachedTokensCost: item.cached_tokens_cost,
      totalCost: item.total_cost,
      hasPii: item.has_pii,
      piiEntities: item.pii_entities,
      piiActions: item.pii_actions,
      hasViolation: item.has_violation,
      violations: item.violations,
      violationActions: item.violation_actions,
      status: item.status,
      attributes: item.attributes,
      events: item.events,
      links: item.links,
      resources: item.resources,
      metadata: item.metadata,
      hasError: item.has_error,
      createdAt: item.created_at ?? "",
      cursor: item.cursor ?? "",
    };
  }
}
