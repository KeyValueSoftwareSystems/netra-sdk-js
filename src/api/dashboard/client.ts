/**
 * Internal HTTP client for Dashboard APIs
 */

import { Session } from "openai/resources/beta/realtime.mjs";
import { Config } from "../../config";
import { NetraHttpClient } from "../http-client";
import {
  ChartType,
  Dimension,
  FilterConfig,
  Metrics,
  Scope,
  SessionFilter,
  SortField,
  SortOrder,
} from "./models";

export class DashboardHttpClient extends NetraHttpClient {
  constructor(config: Config) {
    super(config, "NETRA_DASHBOARD_TIMEOUT", 30.0);
  }

  /**
   * Execute a dynamic query for dashboards
   */
  async queryData(
    scope: Scope,
    chartType: ChartType,
    metrics: Metrics,
    filter: FilterConfig,
    dimension?: Dimension,
  ): Promise<any> {
    if (!this.isInitialized()) {
      console.error(
        "netra.dashboard: Dashboard client is not initialized; cannot execute query",
      );
      return null;
    }

    const payload: Record<string, any> = {
      scope: scope,
      chartType: chartType,
      metrics: {
        measure: metrics.measure,
        aggregation: metrics.aggregation,
      },
    };

    // Build filter object
    if (filter) {
      const filterPayload: Record<string, any> = {
        startTime: filter.startTime,
        endTime: filter.endTime,
        groupBy: filter.groupBy,
      };

      if (filter.filters && filter.filters.length > 0) {
        filterPayload.filters = filter.filters.map((item) => {
          const filterItem: Record<string, any> = {
            field: item.field,
            operator: item.operator,
            type: item.type,
            value: item.value,
          };
          if (item.key) {
            filterItem.key = item.key;
          }
          return filterItem;
        });
      }

      payload.filter = filterPayload;
    }

    // Add dimension if provided
    if (dimension) {
      payload.dimension = {
        field: dimension.field,
      };
    }

    const response = await this.post("/public/dashboard/query-data", payload);

    if (!response.ok) {
      const errorMessage = response.data?.error?.message ?? "Unknown error";
      console.error(
        `netra.dashboard: Failed to execute dashboard query: ${errorMessage}`,
      );
      return null;
    }

    return response.data;
  }

  /**
   * Get session statistics with pagination.
   *
   * Args:
   *   startTime: Start time in ISO 8601 UTC format.
   *   endTime: End time in ISO 8601 UTC format.
   *   filters: Optional list of session filters.
   *   limit: Maximum number of results per page.
   *   page: Page number for pagination.
   *   sortField: Field to sort by.
   *   sortOrder: Sort order (asc/desc).
   *
   * Returns:
   *   The session stats response data or null on error.
   */
async getSessionStats(
    startTime: string,
    endTime: string,
    filters?: SessionFilter[],
    limit?: number,
    cursor?: string,
    sortField?: SortField,
    sortOrder?: SortOrder,
  ): Promise<any | null> {
    if (!this.isInitialized()) {
      console.error(
        "netra.dashboard: Dashboard client is not initialized; cannot get session stats",
      );
      return null;
    }

    try {
      const url = "/public/dashboard/sessions/stats";

      const payload: Record<string, any> = {
        startTime,
        endTime,
      };

      if (filters && filters.length > 0) {
        payload.filters = filters.map((filter) => ({
          field: filter.field,
          operator: filter.operator,
          type: filter.type,
          value: filter.value,
        }));
      }

      if (limit !== undefined || cursor !== undefined) {
        payload.pagination = {};

        if (limit !== undefined) {
          payload.pagination.limit = limit;
        }

        if (cursor !== undefined) { 
          payload.pagination.cursor = cursor;
        }
      }

      if (sortField !== undefined) {
        payload.sortField = sortField;
      }

      if (sortOrder !== undefined) {
        payload.sortOrder = sortOrder;
      }

      const response = await this.post(url, payload);

      if (!response.ok) {
        const errorMessage = response.data?.error?.message ?? "Unknown error";
        console.error(
          `netra.dashboard: Failed to execute dashboard query: ${errorMessage}`,
        );
        return null;
      }

      return response.data;
    } catch (err: any) {
      const message = err?.response?.data?.error?.message ?? "";

      console.error("netra.dashboard: Failed to fetch session stats:", message);
      return null;
    }
  }

  /**
   * Get aggregated session metrics including total sessions, costs, latency,
   * and cost breakdown by model.
   *
   * Args:
   *   startTime: Start time in ISO 8601 UTC format.
   *   endTime: End time in ISO 8601 UTC format.
   *   filters: Optional list of session filters.
   *
   * Returns:
   *   The session summary response data or null on error.
   */
  async getSessionSummary(
    startTime: string,
    endTime: string,
    filters?: SessionFilter[],
  ): Promise<any | null> {
    if (!this.isInitialized()) {
      console.error(
        "netra.dashboard: Dashboard client is not initialized; cannot execute query",
      );
      return null;
    }

    try {
      const url = "/public/dashboard/sessions/summary";

      const payload: Record<string, any> = {
        filter: {
          startTime,
          endTime,
        },
      };

      if (filters && filters.length > 0) {
        payload.filter.filters = filters.map((filter) => ({
          field: filter.field,
          operator: filter.operator,
          type: filter.type,
          value: filter.value,
        }));
      }

      const response = await this.post(url, payload);

      if (!response.ok) {
        const errorMessage = response.data?.error?.message ?? "Unknown error";
        console.error(
          `netra.dashboard: Failed to execute dashboard query: ${errorMessage}`,
        );
        return null;
      }

      return response.data;
    } catch (err: any) {
      const message = err?.response?.data?.error?.message ?? "";

      console.error(
        "netra.dashboard: Failed to fetch session summary:",
        message,
      );
      return null;
    }
  }
}
