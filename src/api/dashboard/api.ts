/**
 * Public Dashboard API
 * Exposed as Netra.dashboard
 */

import { Config } from "../../config";
import { Logger } from "../../logger";
import { DashboardHttpClient } from "./client";
import {
  ChartType,
  Dimension,
  FilterConfig,
  Metrics,
  QueryDataParams,
  QueryResponse,
  Scope,
  SessionDetailResponse,
  SessionFilter,
  SessionFilterConfig,
  SessionStatsData,
  SessionStatsResult,
  SortField,
  SortOrder,
} from "./models";

export class Dashboard {
  private config: Config;
  private client: DashboardHttpClient;

  constructor(config: Config) {
    this.config = config;
    this.client = new DashboardHttpClient(config);
  }

  /**
   * Execute a dynamic query for dashboards to retrieve metrics and time-series data
   * @param params Query parameters
   * @returns Query response containing timeRange and data, or null on error
   */
  async queryData(params: QueryDataParams): Promise<QueryResponse | null> {
    // Validate parameters
    if (!this.isValidScope(params.scope)) {
      throw new TypeError(
        `scope must be a Scope value, got ${typeof params.scope}`,
      );
    }
    if (!this.isValidChartType(params.chartType)) {
      throw new TypeError(
        `chartType must be a ChartType value, got ${typeof params.chartType}`,
      );
    }
    if (!this.isValidMetrics(params.metrics)) {
      throw new TypeError(
        `metrics must be a Metrics object, got ${typeof params.metrics}`,
      );
    }
    if (!this.isValidFilterConfig(params.filter)) {
      throw new TypeError(
        `filter must be a FilterConfig object, got ${typeof params.filter}`,
      );
    }
    if (
      params.dimension !== undefined &&
      !this.isValidDimension(params.dimension)
    ) {
      throw new TypeError(
        `dimension must be a Dimension object or undefined, got ${typeof params.dimension}`,
      );
    }

    const result = await this.client.queryData(
      params.scope,
      params.chartType,
      params.metrics,
      params.filter,
      params.dimension,
    );

    return result;
  }
  
async getSessionStats(
    startTime: string,
    endTime: string,
    limit: number = 10,
    filters?: SessionFilter[],
    cursor?: string,
    sortField?: SortField,
    sortOrder?: SortOrder,
  ): Promise<SessionStatsResult | null> {
    if (!startTime || !endTime) {
      Logger.error(
        "netra.dashboard: start_time and end_time are required to fetch session stats",
      );
      return null;
    }

    const result = await this.client.getSessionStats(
      startTime,
      endTime,
      filters,
      limit,
      cursor,
      sortField,
      sortOrder,
    );

    if (!result) {
      return null;
    }

    const data = result.data ?? {};
    const sessionStats = data.sessions ?? [];
    const pageInfo = data.pageInfo ?? {};

    const hasNextPage = Boolean(pageInfo.hasNextPage);
    
    let nextCursor: string | undefined = undefined;
    if (sessionStats.length > 0) {
      const lastItem = sessionStats[sessionStats.length - 1];
      nextCursor = lastItem.cursor;
    }

    return {
      data: sessionStats,
      hasNextPage,
      nextCursor,
    };
  }

  async *iterSessionStats(
    startTime: string,
    endTime: string,
    filters?: SessionFilter[],
    sortField?: SortField,
    sortOrder?: SortOrder,
  ): AsyncGenerator<SessionStatsData, void, unknown> {
    if (!startTime || !endTime) {
      Logger.error(
        "netra.dashboard: start_time and end_time are required to iterate session stats",
      );
      return;
    }

    let cursor: string | undefined = undefined;

    while (true) {
      const result = await this.getSessionStats(
        startTime,
        endTime,
        undefined,
        filters,
        cursor,
        sortField,
        sortOrder,
      );

      if (!result) {
        return;
      }

      for (const session of result.data) {
        yield session;
      }

      if (!result.hasNextPage) {
        break;
      }

      cursor = result.nextCursor;
    }
  }

  async getSessionSummary(filter: SessionFilterConfig): Promise<any | null> {
    if (!this.isSessionFilterConfig(filter)) {
      Logger.error("netra.dashboard: filter must be a SessionFilterConfig");
      return null;
    }

    if (!filter.startTime || !filter.endTime) {
      Logger.error(
        "netra.dashboard: start_time and end_time are required to fetch session summary",
      );
      return null;
    }

    const result = await this.client.getSessionSummary(
      filter.startTime,
      filter.endTime,
      filter.filters,
    );

    if (!result) {
      return null;
    }

    return result.data ?? {};
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetailResponse | null> {
    if (!sessionId) {
      Logger.error(
        "netra.dashboard: session_id is required to fetch session detail",
      );
      return null;
    }

    const result = await this.client.getSessionDetail(sessionId);

    if (!result) {
      return null;
    }

    return result.data ?? result;
  }

  private isValidScope(scope: any): scope is Scope {
    return Object.values(Scope).includes(scope);
  }

  private isValidChartType(chartType: any): chartType is ChartType {
    return Object.values(ChartType).includes(chartType);
  }

  private isValidMetrics(metrics: any): metrics is Metrics {
    return (
      metrics &&
      typeof metrics === "object" &&
      "measure" in metrics &&
      "aggregation" in metrics
    );
  }

  private isValidFilterConfig(filter: any): filter is FilterConfig {
    return (
      filter &&
      typeof filter === "object" &&
      "startTime" in filter &&
      "endTime" in filter &&
      "groupBy" in filter
    );
  }

  private isValidDimension(dimension: any): dimension is Dimension {
    return dimension && typeof dimension === "object" && "field" in dimension;
  }

  private isSessionFilterConfig(value: unknown): value is SessionFilterConfig {
    return (
      typeof value === "object" &&
      value !== null &&
      "startTime" in value &&
      "endTime" in value
    );
  }
}
